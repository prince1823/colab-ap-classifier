import type {
  Database,
  TaxonomyStore as ITaxonomyStore,
  ProjectStore as IProjectStore,
  RuleStore as IRuleStore,
  TransactionStore as ITransactionStore,
  ChangelogStore as IChangelogStore,
  ClassificationAgent,
  EventBus,
  ClassificationRunner as IClassificationRunner,
  SupplierUniverse,
  SupplierService as ISupplierService,
} from '../../shared/types/services';
import type { TaxonomyNode } from '../../shared/types';
import type { CompanyContext } from '../../shared/types/project';
import type { ClassificationProgress, ClassificationResult } from '../../shared/types/classification';
import type { GroupedFilter } from '../../shared/types/transactions';
import type { SupplierInfo } from '../../shared/types/suppliers';
import { cleanDescription } from '../utils/text';
import { buildDedupGroups, batchDedupGroups, extractSubBatch, extractFields } from '../utils/dedup-groups';
import { runPool } from '../utils/concurrency-pool';
import { debugLog } from '../utils/debug-log';

const DEFAULT_CONCURRENCY = 5;
const TAIL_SPEND_BATCH_SUPPLIERS = 10;
const TAIL_SPEND_BATCH_GROUPS = 300;

export class ClassificationRunner implements IClassificationRunner {
  private isRunningFlag = false;
  private isStopped = false;

  constructor(
    private db: Database,
    private taxonomy: ITaxonomyStore,
    private project: IProjectStore,
    private rules: IRuleStore,
    private transactions: ITransactionStore,
    private changelog: IChangelogStore,
    private classificationAgent: ClassificationAgent,
    private eventBus: EventBus,
    private supplierUniverse: SupplierUniverse,
    private suppliers: ISupplierService
  ) {}

  private emitProgress(progress: ClassificationProgress): void {
    this.eventBus.emit('classification:progress', progress);
  }

  getIsRunning(): boolean {
    return this.isRunningFlag;
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    this.emitProgress({
      status: 'cancelled',
      totalSuppliers: 0,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: null,
      currentStep: 'Cancelled',
    });
  }

  /**
   * Resolve grouped filter to a set of matching transaction IDs.
   * Returns null when no filter is provided (meaning: use default behavior).
   */
  private async resolveScopedIds(groupedFilter?: GroupedFilter): Promise<Set<string> | null> {
    if (!groupedFilter || groupedFilter.groups.length === 0) return null;
    const ids = await this.transactions.getIdsByGroupedConditions(groupedFilter);
    return new Set(ids);
  }

  async getScopeCount(groupedFilter?: GroupedFilter): Promise<number> {
    if (!groupedFilter || groupedFilter.groups.length === 0) {
      const result = await this.db.get<{ cnt: number | bigint }>(
        `SELECT COUNT(*) as cnt FROM transactions WHERE classification_status = 'unclassified'`
      );
      return Number(result?.cnt ?? 0);
    }
    const ids = await this.transactions.getIdsByGroupedConditions(groupedFilter);
    return ids.length;
  }

  async classifyAll(groupedFilter?: GroupedFilter): Promise<void> {
    if (this.isRunningFlag) {
      throw new Error('Classification is already running');
    }

    this.isRunningFlag = true;
    this.isStopped = false;

    try {
      const scopedIds = await this.resolveScopedIds(groupedFilter);

      // Get suppliers with transactions in scope
      let supplierRows: { id: string; supplier_name: string }[];

      if (scopedIds !== null) {
        if (scopedIds.size === 0) {
          this.emitProgress({
            status: 'completed',
            totalSuppliers: 0,
            processedSuppliers: 0,
            percentage: 100,
            currentSupplier: null,
            currentStep: 'No transactions match the filter',
          });
          return;
        }

        const placeholders = Array.from(scopedIds).map(() => '?').join(',');
        supplierRows = await this.db.all<{ id: string; supplier_name: string }>(
          `SELECT DISTINCT ps.id, ps.supplier_name
           FROM project_suppliers ps
           JOIN transactions t ON t.project_supplier_id = ps.id
           WHERE t.id IN (${placeholders})
           ORDER BY ps.supplier_name`,
          ...Array.from(scopedIds)
        );
      } else {
        supplierRows = await this.db.all<{ id: string; supplier_name: string }>(
          `SELECT DISTINCT ps.id, ps.supplier_name
           FROM project_suppliers ps
           JOIN transactions t ON t.project_supplier_id = ps.id
           WHERE t.classification_status = 'unclassified'
           ORDER BY ps.supplier_name`
        );
      }

      if (supplierRows.length === 0) {
        this.emitProgress({
          status: 'completed',
          totalSuppliers: 0,
          processedSuppliers: 0,
          percentage: 100,
          currentSupplier: null,
          currentStep: 'No transactions to classify',
        });
        return;
      }

      const totalSuppliers = supplierRows.length;
      let processedSuppliers = 0;

      this.emitProgress({
        status: 'running',
        totalSuppliers,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: 'Starting classification',
      });

      // Load shared data
      const taxonomyNodes = await this.taxonomy.getNodes();
      let companyContext: CompanyContext;
      try {
        companyContext = (await this.project.getSetting('company_context') as CompanyContext) ?? { industry: 'Unknown' };
      } catch {
        companyContext = { industry: 'Unknown' };
      }

      const columnPriorities = await this.project.getSetting('column_priorities') as string[] | null;
      if (!columnPriorities || columnPriorities.length === 0) {
        throw new Error('Column priorities must be configured before classification. Set column_priorities in project settings.');
      }

      const availableColumns = await this.transactions.getColumns();
      const invalidColumns = columnPriorities.filter((col) => !availableColumns.includes(col));
      if (invalidColumns.length > 0) {
        throw new Error(
          `Column priorities contain columns not found in transactions table: ${invalidColumns.join(', ')}`
        );
      }

      // ── Phase 1: Apply override rules per supplier ──
      // First pass: apply rules and collect non-tail-spend suppliers that still have unclassified txns
      const nonTailSpendSuppliers: Array<{ id: string; supplier_name: string; l1_l2_path: string | null }> = [];
      const tailSpendSuppliers: Array<{ id: string; supplier_name: string; l1_l2_path: string | null }> = [];

      for (const supplier of supplierRows) {
        if (this.isStopped) break;

        // Get transactions for this supplier
        const txnRows = await this.getSupplierTransactions(supplier.id, scopedIds);
        if (txnRows.length === 0) {
          processedSuppliers++;
          continue;
        }

        // Apply override rules
        const txnIds = txnRows.map((r) => String(r.id));
        const ruleMatches = await this.rules.evaluateRules(txnIds);

        const txnsByRuleAndNode = new Map<string, { ruleId: string; targetNodeId: string; ids: string[] }>();
        const matchedTxnIds = new Set<string>();

        for (const [txnId, match] of ruleMatches.entries()) {
          const key = `${match.ruleId}::${match.targetTaxonomyNodeId}`;
          let entry = txnsByRuleAndNode.get(key);
          if (!entry) {
            entry = { ruleId: match.ruleId, targetNodeId: match.targetTaxonomyNodeId, ids: [] };
            txnsByRuleAndNode.set(key, entry);
          }
          entry.ids.push(txnId);
          matchedTxnIds.add(txnId);
        }

        for (const { ruleId, targetNodeId, ids } of txnsByRuleAndNode.values()) {
          await this.transactions.updateTransactions(
            { ids, taxonomyNodeId: targetNodeId, classificationStatus: 'classified_by_rule', appliedRuleId: ruleId },
            'rule'
          );
        }

        // Check if any unmatched transactions remain
        const unmatchedCount = txnIds.length - matchedTxnIds.size;
        if (unmatchedCount === 0) {
          processedSuppliers++;
          continue;
        }

        // Read l1_l2_path and is_tail_spend from project_suppliers
        const supplierRow = await this.db.get<{
          supplier_name: string;
          is_tail_spend: boolean;
          l1_l2_path: string | null;
        }>(
          'SELECT supplier_name, is_tail_spend, l1_l2_path FROM project_suppliers WHERE id = ?',
          supplier.id
        );
        const supplierName = supplierRow?.supplier_name ?? supplier.supplier_name;
        const isTailSpend = Boolean(supplierRow?.is_tail_spend);
        const l1L2Path = supplierRow?.l1_l2_path ?? null;

        if (isTailSpend) {
          tailSpendSuppliers.push({ id: supplier.id, supplier_name: supplierName, l1_l2_path: l1L2Path });
        } else {
          nonTailSpendSuppliers.push({ id: supplier.id, supplier_name: supplierName, l1_l2_path: l1L2Path });
        }
      }

      if (this.isStopped) return;

      // ── Phase 2: Non-tail-spend L3 classification (Call 2 only, l1_l2_path pre-populated) ──
      const concurrency = Number(process.env.CLASSIFIER_CONCURRENCY) || DEFAULT_CONCURRENCY;

      if (nonTailSpendSuppliers.length > 0) {
        const call2Tasks = nonTailSpendSuppliers.map((supplier) => async () => {
          if (this.isStopped) return;

          this.emitProgress({
            status: 'running',
            totalSuppliers,
            processedSuppliers,
            percentage: Math.round((processedSuppliers / totalSuppliers) * 100),
            currentSupplier: supplier.supplier_name,
            currentStep: `Classifying: ${supplier.supplier_name}`,
          });

          try {
            if (!supplier.l1_l2_path) {
              debugLog('WARN', `[Classification] l1_l2_path missing for "${supplier.supplier_name}" — marking as error`);
              await this.markSupplierError(supplier.id, scopedIds);
            } else {
              await this.classifySupplierTransactions(
                supplier.id, supplier.l1_l2_path, taxonomyNodes, companyContext, columnPriorities, scopedIds ?? undefined
              );
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            debugLog('ERROR', `Classification failed for supplier "${supplier.supplier_name}"`, { error: errMsg });
            try {
              await this.markSupplierError(supplier.id, scopedIds);
            } catch (markErr) {
              debugLog('ERROR', `Failed to mark supplier "${supplier.supplier_name}" as error`, {
                error: markErr instanceof Error ? markErr.message : String(markErr),
              });
            }
          } finally {
            processedSuppliers++;
          }
        });

        await runPool(call2Tasks, concurrency, () => this.isStopped);
      }

      if (this.isStopped) return;

      // ── Phase 3: Tail spend L3 classification (grouped by L2) ──
      if (tailSpendSuppliers.length > 0) {
        // Mark suppliers with no l1_l2_path as error
        const validTailSpend = tailSpendSuppliers.filter((s) => {
          if (!s.l1_l2_path) {
            debugLog('WARN', `[Classification] l1_l2_path missing for tail spend "${s.supplier_name}" — marking as error`);
            return false;
          }
          return true;
        });

        // Mark invalid ones as errors
        for (const supplier of tailSpendSuppliers.filter((s) => !s.l1_l2_path)) {
          await this.markSupplierError(supplier.id, scopedIds);
          processedSuppliers++;
        }

        if (validTailSpend.length > 0) {
          // Group by L2 (the full l1_l2_path, which is L1|L2)
          const byL2 = new Map<string, typeof validTailSpend>();
          for (const supplier of validTailSpend) {
            const l2Key = supplier.l1_l2_path!;
            const group = byL2.get(l2Key) ?? [];
            group.push(supplier);
            byL2.set(l2Key, group);
          }

          this.emitProgress({
            status: 'running',
            totalSuppliers,
            processedSuppliers,
            percentage: Math.round((processedSuppliers / totalSuppliers) * 100),
            currentSupplier: null,
            currentStep: 'Classifying tail spend suppliers...',
          });

          // Preparation: build all batches across all L2 categories (sequential — CPU/DB only)
          type TailSpendEntry = {
            supplier: { id: string; supplier_name: string; l1_l2_path: string | null };
            groups: Array<{ fields: Array<[string, string]>; count: number }>;
            groupCount: number;
          };
          type TailSpendTask = {
            l2Path: string;
            l3Taxonomy: TaxonomyNode[];
            batch: TailSpendEntry[];
          };

          const tailSpendTasks: TailSpendTask[] = [];

          for (const [l2Path, l2Suppliers] of byL2) {
            const [l1, l2] = l2Path.split('|');
            const l3Taxonomy = taxonomyNodes.filter(
              (n) => n.depth === 3 && n.l1 === l1 && n.l2 === l2
            );

            // Build groups per supplier
            const supplierGroupData: TailSpendEntry[] = [];

            for (const supplier of l2Suppliers) {
              const txns = await this.getUnmatchedTransactions(supplier.id, scopedIds ?? undefined);
              if (txns.length === 0) {
                processedSuppliers++;
                continue;
              }

              const cleanedTxns = txns.map((txn) => {
                const cleaned = { ...txn };
                if (typeof cleaned.gl_description === 'string') {
                  cleaned.gl_description = cleanDescription(cleaned.gl_description);
                }
                cleaned.supplier_name = supplier.supplier_name;
                return cleaned;
              });

              const dedupResult = buildDedupGroups(cleanedTxns, columnPriorities);
              const groups: Array<{ fields: Array<[string, string]>; count: number }> = [];

              for (let g = 1; g <= dedupResult.groupCount; g++) {
                const ids = dedupResult.groupToTransactionIds.get(g);
                if (!ids) continue;
                const firstTxn = cleanedTxns.find((t) => String(t.id) === ids[0]);
                if (!firstTxn) continue;
                const fields = extractFields(firstTxn, columnPriorities);
                groups.push({ fields, count: ids.length });
              }

              supplierGroupData.push({ supplier, groups, groupCount: groups.length });
            }

            // Batch: max 10 suppliers, max 300 groups per call
            let currentBatch: TailSpendEntry[] = [];
            let currentGroupCount = 0;

            for (const entry of supplierGroupData) {
              if (entry.groupCount > TAIL_SPEND_BATCH_GROUPS) {
                if (currentBatch.length > 0) {
                  tailSpendTasks.push({ l2Path, l3Taxonomy, batch: currentBatch });
                  currentBatch = [];
                  currentGroupCount = 0;
                }
                tailSpendTasks.push({ l2Path, l3Taxonomy, batch: [entry] });
                continue;
              }

              if (
                currentBatch.length >= TAIL_SPEND_BATCH_SUPPLIERS ||
                currentGroupCount + entry.groupCount > TAIL_SPEND_BATCH_GROUPS
              ) {
                tailSpendTasks.push({ l2Path, l3Taxonomy, batch: currentBatch });
                currentBatch = [];
                currentGroupCount = 0;
              }

              currentBatch.push(entry);
              currentGroupCount += entry.groupCount;
            }
            if (currentBatch.length > 0) tailSpendTasks.push({ l2Path, l3Taxonomy, batch: currentBatch });
          }

          // Execution: process all batches concurrently via worker pool
          const tailTasks = tailSpendTasks.map((task) => async () => {
            try {
              const result = await this.classificationAgent.classifyL3ForTailSpend({
                categoryPath: task.l2Path,
                l3Taxonomy: task.l3Taxonomy,
                suppliers: task.batch.map((e) => ({
                  name: e.supplier.supplier_name,
                  groups: e.groups,
                })),
                companyContext,
              });

              // Apply results: one L3 path per supplier → all their transactions
              for (let i = 0; i < task.batch.length; i++) {
                const classificationPath = result.get(i + 1);
                if (classificationPath) {
                  const taxonomyNode = taxonomyNodes.find((n) => n.fullPath === classificationPath);
                  const txns = await this.getUnmatchedTransactions(task.batch[i].supplier.id, scopedIds ?? undefined);
                  if (txns.length > 0) {
                    await this.transactions.updateTransactions({
                      ids: txns.map((t) => String(t.id)),
                      taxonomyNodeId: taxonomyNode?.id ?? undefined,
                      classificationStatus: 'classified_by_ai',
                    }, 'pipeline');
                  }
                } else {
                  debugLog('WARN', `No L3 result for tail spend supplier "${task.batch[i].supplier.supplier_name}"`);
                }
                processedSuppliers++;
              }
            } catch (err) {
              debugLog('ERROR', `Tail spend L3 classification failed for L2 group "${task.l2Path}"`, {
                error: err instanceof Error ? err.message : String(err),
              });
              // Mark all suppliers in batch as error
              for (const entry of task.batch) {
                await this.markSupplierError(entry.supplier.id, scopedIds);
                processedSuppliers++;
              }
            }
          });

          await runPool(tailTasks, concurrency, () => this.isStopped);
        }
      }

      if (this.isStopped) return;

      // Log to changelog
      const classifiedCount = await this.db.get<{ cnt: number | bigint }>(
        `SELECT COUNT(*) as cnt FROM transactions WHERE classification_status != 'unclassified'`
      );
      await this.changelog.logChange({
        source: 'pipeline',
        affectedTable: 'transactions',
        affectedIds: [],
        affectedCount: Number(classifiedCount?.cnt ?? 0),
        oldValues: null,
        newValues: { status: 'classified' },
        description: `Classification completed: ${processedSuppliers} suppliers processed`,
      });

      this.emitProgress({
        status: 'completed',
        totalSuppliers,
        processedSuppliers: totalSuppliers,
        percentage: 100,
        currentSupplier: null,
        currentStep: 'Completed',
      });
    } catch (err) {
      if (!this.isStopped) {
        this.emitProgress({
          status: 'failed',
          totalSuppliers: 0,
          processedSuppliers: 0,
          percentage: 0,
          currentSupplier: null,
          currentStep: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      this.isRunningFlag = false;
      this.isStopped = false;
    }
  }

  /**
   * Call 2 only: classify a supplier's transactions into L3 under the given categoryPath.
   */
  async classifySupplierTransactions(
    projectSupplierId: string,
    categoryPath: string,
    taxonomy: TaxonomyNode[],
    companyContext: CompanyContext,
    columnPriorities: string[],
    scopedTxnIds?: Set<string>
  ): Promise<void> {
    // Get unmatched transactions (after rules)
    const txnRows = await this.getUnmatchedTransactions(projectSupplierId, scopedTxnIds);
    if (txnRows.length === 0) return;

    // Resolve supplier info via service (includes parent name via JOIN)
    const projectSupplier = await this.suppliers.getProjectSupplier(projectSupplierId);
    const supplierName = projectSupplier?.supplierName ?? '';

    let supplierResearch: SupplierInfo | null = null;
    if (supplierName) {
      supplierResearch = await this.supplierUniverse.getSupplier(supplierName);
    }

    // Clean descriptions and inject canonical supplier_name
    const cleanedTxns = txnRows.map((txn) => {
      const cleaned = { ...txn };
      if (typeof cleaned.gl_description === 'string') {
        cleaned.gl_description = cleanDescription(cleaned.gl_description);
      }
      if (supplierName) cleaned.supplier_name = supplierName;
      return cleaned;
    });

    // Filter taxonomy to L3 nodes under the chosen L1|L2
    const [l1, l2] = categoryPath.split('|');
    const l3Taxonomy = taxonomy.filter(
      (n) => n.depth === 3 && n.l1 === l1 && n.l2 === l2
    );

    // Build dedup groups and split into batches
    const dedupResult = buildDedupGroups(cleanedTxns, columnPriorities);
    const batches = batchDedupGroups(dedupResult);

    debugLog('INFO', `Supplier ${supplierName || projectSupplierId}: ${dedupResult.groupCount} groups in ${batches.length} batch(es), category: ${categoryPath}`);

    for (const batch of batches) {
      if (this.isStopped) return;

      const allBatchTxnIds = new Set<string>();
      for (const ids of batch.groupToTransactionIds.values()) {
        for (const id of ids) allBatchTxnIds.add(id);
      }

      const MAX_ATTEMPTS = 3;
      let remainingBatch = batch;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (this.isStopped) return;

        const currentTxnIds = new Set<string>();
        for (const ids of remainingBatch.groupToTransactionIds.values()) {
          for (const id of ids) currentTxnIds.add(id);
        }
        const currentTxns = cleanedTxns.filter((t) => currentTxnIds.has(String(t.id)));

        try {
          const result = await this.classificationAgent.classifyL3({
            categoryPath,
            l3Taxonomy,
            transactions: currentTxns,
            columnPriorities,
            companyContext,
            supplierName,
            supplierType: supplierResearch?.supplierType ?? null,
          });

          const { validResult, missedGroups } = this.extractValidAssignments(result, remainingBatch.groupCount);

          if (Object.keys(validResult.assignments).length > 0) {
            await this.applyMultiClassification(validResult, remainingBatch.groupToTransactionIds, taxonomy);
          }

          if (missedGroups.length === 0) break;

          debugLog('WARN', `Supplier ${supplierName || projectSupplierId}: ${missedGroups.length} groups missed on attempt ${attempt}/${MAX_ATTEMPTS}`);

          if (attempt < MAX_ATTEMPTS) {
            remainingBatch = extractSubBatch(remainingBatch, missedGroups);
          } else {
            const failedTxnIds: string[] = [];
            for (const g of missedGroups) {
              const ids = remainingBatch.groupToTransactionIds.get(g);
              if (ids) failedTxnIds.push(...ids);
            }
            if (failedTxnIds.length > 0) {
              debugLog('ERROR', `All ${MAX_ATTEMPTS} attempts exhausted for supplier ${supplierName || projectSupplierId}`);
              await this.transactions.updateTransactions({
                ids: failedTxnIds,
                classificationStatus: 'classification_error',
              }, 'pipeline');
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          debugLog('WARN', `Classification attempt ${attempt}/${MAX_ATTEMPTS} failed for supplier ${supplierName || projectSupplierId}`, { error: errMsg });
          if (attempt === MAX_ATTEMPTS) {
            debugLog('ERROR', `All ${MAX_ATTEMPTS} classification attempts failed for supplier ${supplierName || projectSupplierId}`);
            const failedIds = Array.from(allBatchTxnIds);
            await this.transactions.updateTransactions({
              ids: failedIds,
              classificationStatus: 'classification_error',
            }, 'pipeline');
          }
        }
      }
    }
  }

  private async getSupplierTransactions(
    projectSupplierId: string,
    scopedTxnIds: Set<string> | null
  ): Promise<Record<string, unknown>[]> {
    if (scopedTxnIds) {
      const allTxns = await this.transactions.queryBySupplier(projectSupplierId);
      return allTxns.filter((r) => scopedTxnIds.has(String(r.id)));
    }
    return this.transactions.queryBySupplier(projectSupplierId, 'unclassified');
  }

  private async getUnmatchedTransactions(
    projectSupplierId: string,
    scopedTxnIds?: Set<string>
  ): Promise<Record<string, unknown>[]> {
    const allTxns = await this.transactions.queryBySupplier(projectSupplierId, 'unclassified');
    if (scopedTxnIds) {
      return allTxns.filter((r) => scopedTxnIds.has(String(r.id)));
    }
    return allTxns;
  }

  private async markSupplierError(projectSupplierId: string, scopedIds: Set<string> | null): Promise<void> {
    let failedIds: string[];
    if (scopedIds) {
      // Get all transactions for the supplier, then intersect with scoped IDs
      const allIds = await this.transactions.getIdsBySupplier(projectSupplierId);
      failedIds = allIds.filter((id) => scopedIds.has(id));
    } else {
      failedIds = await this.transactions.getIdsBySupplier(projectSupplierId, { statuses: ['unclassified'] });
    }

    if (failedIds.length > 0) {
      await this.transactions.updateTransactions(
        { ids: failedIds, classificationStatus: 'classification_error' },
        'pipeline'
      );
    }
  }

  /**
   * Extract valid assignments from a classification result, skipping invalid entries.
   */
  private extractValidAssignments(
    result: ClassificationResult,
    groupCount: number
  ): { validResult: ClassificationResult; missedGroups: number[] } {
    const classificationIds = new Set(result.classifications.map((c) => c.id));
    const assignedGroups = new Set<number>();
    const cleanedAssignments: Record<string, number[]> = {};

    for (const [classIdStr, groupNumbers] of Object.entries(result.assignments)) {
      const classId = Number(classIdStr);
      if (!classificationIds.has(classId)) continue;

      const validGroups: number[] = [];
      for (const g of groupNumbers) {
        if (g < 1 || g > groupCount) continue;
        if (assignedGroups.has(g)) continue;
        assignedGroups.add(g);
        validGroups.push(g);
      }
      if (validGroups.length > 0) {
        cleanedAssignments[classIdStr] = validGroups;
      }
    }

    const missedGroups: number[] = [];
    for (let g = 1; g <= groupCount; g++) {
      if (!assignedGroups.has(g)) missedGroups.push(g);
    }

    const usedClassIds = new Set(Object.keys(cleanedAssignments).map(Number));
    const validClassifications = result.classifications.filter((c) => usedClassIds.has(c.id));

    return {
      validResult: { classifications: validClassifications, assignments: cleanedAssignments },
      missedGroups,
    };
  }

  private async applyMultiClassification(
    result: ClassificationResult,
    groupToTransactionIds: Map<number, string[]>,
    taxonomy: TaxonomyNode[]
  ): Promise<void> {
    for (const classification of result.classifications) {
      const assignedGroups = result.assignments[String(classification.id)];
      if (!assignedGroups || assignedGroups.length === 0) continue;

      const txnIds: string[] = [];
      for (const groupNum of assignedGroups) {
        const ids = groupToTransactionIds.get(groupNum);
        if (ids) txnIds.push(...ids);
      }
      if (txnIds.length === 0) continue;

      const taxonomyNode = taxonomy.find((n) => n.fullPath === classification.classificationPath);
      if (!taxonomyNode) {
        debugLog('WARN', `Taxonomy node not found for path "${classification.classificationPath}"`);
      }

      await this.transactions.updateTransactions({
        ids: txnIds,
        taxonomyNodeId: taxonomyNode?.id ?? undefined,
        classificationStatus: 'classified_by_ai',
      }, 'pipeline');
    }
  }
}
