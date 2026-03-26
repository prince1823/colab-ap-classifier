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
} from '../../shared/types/services';
import type { TaxonomyNode } from '../../shared/types';
import type { CompanyContext } from '../../shared/types/project';
import type { ClassificationProgress, ClassificationResult } from '../../shared/types/classification';
import type { FilterCondition } from '../../shared/types/transactions';
import type { SupplierInfo } from '../../shared/types/suppliers';
import { cleanDescription } from '../utils/text';
import { buildDedupGroups, batchDedupGroups, extractSubBatch } from '../utils/dedup-groups';
import { runPool } from '../utils/concurrency-pool';
import { debugLog } from '../utils/debug-log';

const DEFAULT_CONCURRENCY = 5;
const CALL1_BATCH_SIZE = 10;

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
    private supplierUniverse: SupplierUniverse
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
      status: 'stopped',
      totalSuppliers: 0,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: null,
      currentStep: 'Stopped',
    });
  }

  private async resolveScopedIds(conditions?: FilterCondition[]): Promise<Set<string> | null> {
    if (!conditions || conditions.length === 0) return null;
    const ids = await this.transactions.getIdsByConditions(conditions);
    return new Set(ids);
  }

  async getScopeCount(conditions?: FilterCondition[]): Promise<number> {
    if (!conditions || conditions.length === 0) {
      const result = await this.db.get<{ cnt: number | bigint }>(
        `SELECT COUNT(*) as cnt FROM transactions WHERE classification_status = 'unclassified'`
      );
      return Number(result?.cnt ?? 0);
    }
    const ids = await this.transactions.getIdsByConditions(conditions);
    return ids.length;
  }

  async classifyAll(conditions?: FilterCondition[]): Promise<void> {
    if (this.isRunningFlag) {
      throw new Error('Classification is already running');
    }

    this.isRunningFlag = true;
    this.isStopped = false;

    try {
      const scopedIds = await this.resolveScopedIds(conditions);

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
      // First pass: apply rules and collect suppliers that still have unclassified txns
      const suppliersNeedingClassification: Array<{
        id: string;
        supplier_name: string;
        research: SupplierInfo | null;
        parentName: string | null;
      }> = [];

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

        // Resolve supplier info for Call 1
        const supplierInfo = await this.db.get<{ supplier_name: string; is_researched: boolean; parent_name: string | null }>(
          `SELECT ps.supplier_name, ps.is_researched, sp.name AS parent_name
           FROM project_suppliers ps
           LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id
           WHERE ps.id = ?`,
          supplier.id
        );
        const supplierName = supplierInfo?.supplier_name ?? supplier.supplier_name;

        let research: SupplierInfo | null = null;
        if (supplierName) {
          research = await this.supplierUniverse.getSupplier(supplierName);
        }
        if (supplierInfo?.is_researched && !research) {
          debugLog('WARN', `Supplier "${supplierName}" is marked as researched but no research data found in supplier universe`);
        }
        const parentName = supplierInfo?.parent_name ?? research?.parentCompanyName ?? null;

        suppliersNeedingClassification.push({
          id: supplier.id,
          supplier_name: supplierName,
          research,
          parentName,
        });
      }

      if (this.isStopped) return;

      // ── Phase 2: Chunked pipeline — Call 1 (category selection) then Call 2 (L3) per batch ──
      const concurrency = Number(process.env.CLASSIFIER_CONCURRENCY) || DEFAULT_CONCURRENCY;

      if (suppliersNeedingClassification.length > 0) {
        // Chunk into batches of CALL1_BATCH_SIZE
        const batches: typeof suppliersNeedingClassification[] = [];
        for (let i = 0; i < suppliersNeedingClassification.length; i += CALL1_BATCH_SIZE) {
          batches.push(suppliersNeedingClassification.slice(i, i + CALL1_BATCH_SIZE));
        }

        for (const [batchIdx, batch] of batches.entries()) {
          if (this.isStopped) break;

          // ── Call 1: category selection for this batch ──
          this.emitProgress({
            status: 'running',
            totalSuppliers,
            processedSuppliers,
            percentage: Math.round((processedSuppliers / totalSuppliers) * 100),
            currentSupplier: null,
            currentStep: `Selecting categories (batch ${batchIdx + 1}/${batches.length})`,
          });

          const batchCategoryMap = new Map<string, string>(); // supplierId → categoryPath (batch-scoped)

          try {
            const result = await this.classificationAgent.selectCategories({
              suppliers: batch.map((s) => ({
                name: s.supplier_name,
                research: s.research,
                parentName: s.parentName,
              })),
              taxonomy: taxonomyNodes,
              companyContext,
            });

            // Map results back to supplier IDs
            const missingIndices: number[] = [];
            for (let i = 0; i < batch.length; i++) {
              const categoryPath = result.get(i + 1);
              if (categoryPath) {
                batchCategoryMap.set(batch[i].id, categoryPath);
              } else {
                missingIndices.push(i);
              }
            }

            // Retry missing suppliers individually
            for (const idx of missingIndices) {
              if (this.isStopped) break;
              const supplier = batch[idx];
              try {
                const singleResult = await this.classificationAgent.selectCategories({
                  suppliers: [{ name: supplier.supplier_name, research: supplier.research, parentName: supplier.parentName }],
                  taxonomy: taxonomyNodes,
                  companyContext,
                });
                const path = singleResult.get(1);
                if (path) {
                  batchCategoryMap.set(supplier.id, path);
                } else {
                  debugLog('WARN', `Category selection retry returned no result for "${supplier.supplier_name}"`);
                }
              } catch (err) {
                debugLog('ERROR', `Category selection retry failed for "${supplier.supplier_name}"`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } catch (err) {
            debugLog('ERROR', `Batch ${batchIdx} category selection failed, retrying individually`, {
              error: err instanceof Error ? err.message : String(err),
            });
            // Retry each supplier individually
            for (const supplier of batch) {
              if (this.isStopped) break;
              try {
                const result = await this.classificationAgent.selectCategories({
                  suppliers: [{ name: supplier.supplier_name, research: supplier.research, parentName: supplier.parentName }],
                  taxonomy: taxonomyNodes,
                  companyContext,
                });
                const path = result.get(1);
                if (path) batchCategoryMap.set(supplier.id, path);
              } catch {
                debugLog('ERROR', `Individual category selection also failed for "${supplier.supplier_name}"`);
              }
            }
          }

          if (this.isStopped) break;

          // ── Call 2: L3 classification for this batch's suppliers ──
          const call2Tasks = batch.map((supplier) => async () => {
            if (this.isStopped) return;

            const categoryPath = batchCategoryMap.get(supplier.id);

            this.emitProgress({
              status: 'running',
              totalSuppliers,
              processedSuppliers,
              percentage: Math.round((processedSuppliers / totalSuppliers) * 100),
              currentSupplier: supplier.supplier_name,
              currentStep: `Classifying: ${supplier.supplier_name}`,
            });

            try {
              if (!categoryPath) {
                await this.markSupplierError(supplier.id, scopedIds);
              } else {
                await this.classifySupplierTransactions(
                  supplier.id, categoryPath, taxonomyNodes, companyContext, columnPriorities, scopedIds ?? undefined
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

    // Resolve supplier info
    const supplierInfo = await this.db.get<{ supplier_name: string; parent_name: string | null }>(
      `SELECT ps.supplier_name, sp.name AS parent_name
       FROM project_suppliers ps
       LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id
       WHERE ps.id = ?`,
      projectSupplierId
    );
    const supplierName = supplierInfo?.supplier_name ?? '';

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
      const allTxns = await this.db.all<Record<string, unknown>>(
        `SELECT * FROM transactions WHERE project_supplier_id = ?`,
        projectSupplierId
      );
      return allTxns.filter((r) => scopedTxnIds.has(String(r.id)));
    }
    return this.db.all<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE project_supplier_id = ? AND classification_status = 'unclassified'`,
      projectSupplierId
    );
  }

  private async getUnmatchedTransactions(
    projectSupplierId: string,
    scopedTxnIds?: Set<string>
  ): Promise<Record<string, unknown>[]> {
    // Get transactions that are still unclassified (after rules have been applied)
    if (scopedTxnIds) {
      const allTxns = await this.db.all<Record<string, unknown>>(
        `SELECT * FROM transactions WHERE project_supplier_id = ? AND classification_status = 'unclassified'`,
        projectSupplierId
      );
      return allTxns.filter((r) => scopedTxnIds.has(String(r.id)));
    }
    return this.db.all<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE project_supplier_id = ? AND classification_status = 'unclassified'`,
      projectSupplierId
    );
  }

  private async markSupplierError(projectSupplierId: string, scopedIds: Set<string> | null): Promise<void> {
    let failedQuery = `SELECT id FROM transactions WHERE project_supplier_id = ?`;
    const failedParams: unknown[] = [projectSupplierId];

    if (scopedIds) {
      const supplierScopedIds = Array.from(scopedIds);
      failedQuery += ` AND id IN (${supplierScopedIds.map(() => '?').join(',')})`;
      failedParams.push(...supplierScopedIds);
    } else {
      failedQuery += ` AND classification_status = 'unclassified'`;
    }

    const failedTxns = await this.db.all<{ id: string }>(failedQuery, ...failedParams);
    if (failedTxns.length > 0) {
      await this.transactions.updateTransactions(
        { ids: failedTxns.map((t) => t.id), classificationStatus: 'classification_error' },
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
