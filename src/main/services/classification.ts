import crypto from 'crypto';
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
import { buildDedupGroups, batchDedupGroups, extractSubBatch, DEFAULT_SAMPLE_COUNT } from '../utils/dedup-groups';
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';
import { runPool } from '../utils/concurrency-pool';
import { debugLog } from '../utils/debug-log';

const DEFAULT_CONCURRENCY = 5;
const TAIL_SPEND_BATCH_SUPPLIERS = 5;
const TAIL_SPEND_BATCH_GROUPS = 150;

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

    // Scope temp table — created once for filtered runs, reused in Phase 1 to avoid
    // spreading large ID arrays as function arguments (causes call stack overflow).
    let scopeTempTable: string | null = null;

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

        // Build scope temp table once — reused for supplier lookup and Phase 1
        const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        scopeTempTable = `_target_txns_${runId}`;
        await this.db.run(`CREATE TEMP TABLE ${scopeTempTable} (id VARCHAR PRIMARY KEY)`);
        const scopeArr = Array.from(scopedIds);
        for (let i = 0; i < scopeArr.length; i += 10_000) {
          const chunk = scopeArr.slice(i, i + 10_000);
          const ph = chunk.map(() => '(?)').join(',');
          await this.db.run(`INSERT INTO ${scopeTempTable} VALUES ${ph}`, ...chunk);
        }

        supplierRows = await this.db.all<{ id: string; supplier_name: string }>(
          `SELECT DISTINCT ps.id, ps.supplier_name
           FROM project_suppliers ps
           JOIN transactions t ON t.project_supplier_id = ps.id
           WHERE t.id IN (SELECT id FROM ${scopeTempTable})
           ORDER BY ps.supplier_name`
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
      let errorCount = 0;
      let skippedNoPaths = 0;
      let lastError: Error | null = null;

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

      const rawColumnPriorities = await this.project.getSetting('column_priorities') as string[] | null;
      if (!rawColumnPriorities || rawColumnPriorities.length === 0) {
        throw new Error('Column priorities must be configured before classification. Set column_priorities in project settings.');
      }

      const sampleCount = (await this.project.getSetting('classification_sample_count') as number | null) ?? DEFAULT_SAMPLE_COUNT;

      // Strip virtual columns — they have no physical presence on transaction rows and cannot
      // contribute to dedup groups. This is a safety net for projects saved before this fix.
      const columnPriorities = rawColumnPriorities.filter((col) => !VIRTUAL_COLUMN_NAMES.has(col));

      const availableColumns = await this.transactions.getColumns();
      const invalidColumns = columnPriorities.filter((col) => !availableColumns.includes(col));
      if (invalidColumns.length > 0) {
        throw new Error(
          `Column priorities contain columns not found in transactions table: ${invalidColumns.join(', ')}`
        );
      }

      // ── Phase 1: Bulk rule evaluation (single SQL pass) ──
      {
        // Reuse scopeTempTable if already built (filtered run), otherwise build from unclassified
        let phase1Table: string | null = scopeTempTable;
        let phase1OwnedTable = false;

        if (!phase1Table) {
          const unclassifiedIds = (await this.db.all<{ id: string }>(
            "SELECT id FROM transactions WHERE classification_status = 'unclassified'"
          )).map(r => r.id);

          if (unclassifiedIds.length > 0) {
            const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
            phase1Table = `_target_txns_${runId}`;
            phase1OwnedTable = true;
            await this.db.run(`CREATE TEMP TABLE ${phase1Table} (id VARCHAR PRIMARY KEY)`);
            for (let i = 0; i < unclassifiedIds.length; i += 10_000) {
              const chunk = unclassifiedIds.slice(i, i + 10_000);
              const ph = chunk.map(() => '(?)').join(',');
              await this.db.run(`INSERT INTO ${phase1Table} VALUES ${ph}`, ...chunk);
            }
          }
        }

        if (phase1Table) {
          const scopeTable = phase1Table;
          try {
            // Single bulk evaluation
            const ruleMatches = await this.rules.evaluateRulesBulk({ scopeTable });

            // Batch UPDATE by target node
            const txnsByRuleAndNode = new Map<string, { ruleId: string; targetNodeId: string; ids: string[] }>();
            for (const [txnId, match] of ruleMatches.entries()) {
              const key = `${match.ruleId}::${match.targetTaxonomyNodeId}`;
              let entry = txnsByRuleAndNode.get(key);
              if (!entry) {
                entry = { ruleId: match.ruleId, targetNodeId: match.targetTaxonomyNodeId, ids: [] };
                txnsByRuleAndNode.set(key, entry);
              }
              entry.ids.push(txnId);
            }

            for (const { ruleId, targetNodeId, ids } of txnsByRuleAndNode.values()) {
              await this.transactions.updateTransactions(
                { ids, taxonomyNodeId: targetNodeId, classificationStatus: 'classified_by_rule', appliedRuleId: ruleId },
                'rule'
              );
            }
          } finally {
            // Only drop if we created this table (not scopeTempTable, which is cleaned up in outer finally)
            if (phase1OwnedTable) {
              try { await this.db.run(`DROP TABLE IF EXISTS ${scopeTable}`); } catch { /* ignore */ }
            }
          }
        }
      }

      if (this.isStopped) return;

      // ── After Phase 1: Collect suppliers that still have unclassified transactions ──
      const nonTailSpendSuppliers: Array<{ id: string; supplier_name: string; l1_l2_paths: string[] | null }> = [];
      const tailSpendSuppliers: Array<{ id: string; supplier_name: string; l1_l2_paths: string[] | null }> = [];

      for (const supplier of supplierRows) {
        if (this.isStopped) break;

        // Get remaining unmatched transactions for this supplier
        const txnRows = await this.getSupplierTransactions(supplier.id, scopedIds);
        if (txnRows.length === 0) {
          processedSuppliers++;
          continue;
        }

        // Check if any unclassified remain (rules may have classified them all)
        const unclassifiedTxns = txnRows.filter(r => r.classification_status === 'unclassified');
        if (unclassifiedTxns.length === 0) {
          processedSuppliers++;
          continue;
        }

        // Read l1_l2_path and is_tail_spend via SupplierService
        const supplierRecord = await this.suppliers.getProjectSupplier(supplier.id);
        const supplierName = supplierRecord?.supplierName ?? supplier.supplier_name;
        const isTailSpend = Boolean(supplierRecord?.isTailSpend);
        const l1L2Paths: string[] | null = supplierRecord?.l1L2Path ?? null;

        if (isTailSpend) {
          tailSpendSuppliers.push({ id: supplier.id, supplier_name: supplierName, l1_l2_paths: l1L2Paths });
        } else {
          nonTailSpendSuppliers.push({ id: supplier.id, supplier_name: supplierName, l1_l2_paths: l1L2Paths });
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
            if (!supplier.l1_l2_paths || supplier.l1_l2_paths.length === 0) {
              debugLog('WARN', `[Classification] l1_l2_paths missing for "${supplier.supplier_name}" — marking as error`);
              skippedNoPaths++;
              await this.markSupplierError(supplier.id, scopedIds);
            } else {
              await this.classifySupplierTransactions(
                supplier.id, supplier.l1_l2_paths, taxonomyNodes, companyContext, columnPriorities, sampleCount, scopedIds ?? undefined
              );
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            debugLog('ERROR', `Classification failed for supplier "${supplier.supplier_name}"`, { error: errMsg });
            errorCount++;
            lastError = err instanceof Error ? err : new Error(errMsg);
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
        // Mark suppliers with no l1_l2_paths as error
        const validTailSpend = tailSpendSuppliers.filter((s) => {
          if (!s.l1_l2_paths || s.l1_l2_paths.length === 0) {
            debugLog('WARN', `[Classification] l1_l2_paths missing for tail spend "${s.supplier_name}" — marking as error`);
            return false;
          }
          return true;
        });

        // Mark invalid ones as errors
        for (const supplier of tailSpendSuppliers.filter((s) => !s.l1_l2_paths || s.l1_l2_paths.length === 0)) {
          skippedNoPaths++;
          await this.markSupplierError(supplier.id, scopedIds);
          processedSuppliers++;
        }

        if (validTailSpend.length > 0) {
          // Group by L2 (tail spend always has a single l1_l2_path)
          const byL2 = new Map<string, typeof validTailSpend>();
          for (const supplier of validTailSpend) {
            const l2Key = supplier.l1_l2_paths![0];
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
            supplier: { id: string; supplier_name: string; l1_l2_paths: string[] | null };
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
                return cleaned;
              });

              const dedupResult = buildDedupGroups(cleanedTxns, columnPriorities, sampleCount);
              supplierGroupData.push({ supplier, groups: dedupResult.groups, groupCount: dedupResult.groupCount });
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
              lastError = err instanceof Error ? err : new Error(String(err));
              // Mark all suppliers in batch as error
              for (const entry of task.batch) {
                errorCount++;
                await this.markSupplierError(entry.supplier.id, scopedIds);
                processedSuppliers++;
              }
            }
          });

          await runPool(tailTasks, concurrency, () => this.isStopped);
        }
      }

      if (this.isStopped) return;

      // If every supplier that needed LLM classification failed, surface the error
      const llmSupplierCount = nonTailSpendSuppliers.length + tailSpendSuppliers.length;
      if (llmSupplierCount > 0 && errorCount + skippedNoPaths >= llmSupplierCount) {
        if (skippedNoPaths > 0 && errorCount === 0) {
          throw new Error(`All ${skippedNoPaths} suppliers are missing category paths — run categorization first`);
        }
        throw lastError ?? new Error('All suppliers failed during classification');
      }

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

      const completedParts: string[] = ['Completed'];
      if (skippedNoPaths > 0) {
        completedParts.push(`${skippedNoPaths} supplier${skippedNoPaths > 1 ? 's' : ''} skipped (missing category paths — run categorization first)`);
      }
      if (errorCount > 0) {
        completedParts.push(`${errorCount} supplier${errorCount > 1 ? 's' : ''} failed during classification`);
      }

      this.emitProgress({
        status: 'completed',
        totalSuppliers,
        processedSuppliers: totalSuppliers,
        percentage: 100,
        currentSupplier: null,
        currentStep: completedParts.join(' — '),
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
      if (scopeTempTable) {
        try { await this.db.run(`DROP TABLE IF EXISTS ${scopeTempTable}`); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Call 2 only: classify a supplier's transactions into L3 under the given categoryPaths (merges L3 from all branches).
   */
  async classifySupplierTransactions(
    projectSupplierId: string,
    categoryPaths: string[],
    taxonomy: TaxonomyNode[],
    companyContext: CompanyContext,
    columnPriorities: string[],
    sampleCount: number,
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

    // Clean descriptions — supplier name is passed separately to the agent, not via row data
    const cleanedTxns = txnRows.map((txn) => {
      const cleaned = { ...txn };
      if (typeof cleaned.gl_description === 'string') {
        cleaned.gl_description = cleanDescription(cleaned.gl_description);
      }
      return cleaned;
    });

    // Merge L3 taxonomy from all candidate L2 branches
    const seen = new Set<string>();
    const l3Taxonomy = categoryPaths.flatMap((catPath) => {
      const [l1, l2] = catPath.split('|');
      return taxonomy.filter((n) => n.depth === 3 && n.l1 === l1 && n.l2 === l2);
    }).filter((n) => {
      if (seen.has(n.fullPath)) return false;
      seen.add(n.fullPath);
      return true;
    });

    // Build dedup groups and split into batches
    const dedupResult = buildDedupGroups(cleanedTxns, columnPriorities, sampleCount);
    const batches = batchDedupGroups(dedupResult);

    debugLog('INFO', `Supplier ${supplierName || projectSupplierId}: ${dedupResult.groupCount} groups in ${batches.length} batch(es), categories: ${categoryPaths.join(', ')}`);

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
            categoryPaths,
            l3Taxonomy,
            transactions: currentTxns,
            columnPriorities,
            companyContext,
            supplierName,
            supplierType: supplierResearch?.supplierType ?? null,
            sampleCount,
          });

          debugLog('INFO', `[L3] ${supplierName} attempt ${attempt}: classifyL3 returned ${result.classifications.length} classifications, ${Object.keys(result.assignments).length} assignment keys, groupCount=${remainingBatch.groupCount}`);
          const { validResult, missedGroups } = this.extractValidAssignments(result, remainingBatch.groupCount);
          debugLog('INFO', `[L3] ${supplierName} attempt ${attempt}: extractValidAssignments → ${Object.keys(validResult.assignments).length} valid assignment keys, ${missedGroups.length} missed groups`);

          if (Object.keys(validResult.assignments).length > 0) {
            await this.applyMultiClassification(validResult, remainingBatch.groupToTransactionIds, taxonomy);
            debugLog('INFO', `[L3] ${supplierName} attempt ${attempt}: applyMultiClassification completed`);
          }

          if (missedGroups.length === 0) break;

          debugLog('WARN', `Supplier ${supplierName || projectSupplierId}: ${missedGroups.length} groups missed on attempt ${attempt}/${MAX_ATTEMPTS}`);

          if (attempt < MAX_ATTEMPTS) {
            remainingBatch = extractSubBatch(remainingBatch, missedGroups);
          } else {
            const failedTxnIds: string[] = [];
            for (const g of missedGroups) {
              const ids = remainingBatch.groupToTransactionIds.get(g);
              if (ids) { for (const id of ids) failedTxnIds.push(id); }
            }
            if (failedTxnIds.length > 0) {
              debugLog('ERROR', `All ${MAX_ATTEMPTS} attempts exhausted for supplier ${supplierName || projectSupplierId}`);
              const BATCH_SIZE = 10_000;
              for (let i = 0; i < failedTxnIds.length; i += BATCH_SIZE) {
                await this.transactions.updateTransactions({
                  ids: failedTxnIds.slice(i, i + BATCH_SIZE),
                  classificationStatus: 'classification_error',
                }, 'pipeline');
              }
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          debugLog('WARN', `Classification attempt ${attempt}/${MAX_ATTEMPTS} failed for supplier ${supplierName || projectSupplierId}`, { error: errMsg });
          if (attempt === MAX_ATTEMPTS) {
            debugLog('ERROR', `All ${MAX_ATTEMPTS} classification attempts failed for supplier ${supplierName || projectSupplierId}`);
            const failedIds = Array.from(allBatchTxnIds);
            const BATCH_SIZE = 10_000;
            for (let i = 0; i < failedIds.length; i += BATCH_SIZE) {
              await this.transactions.updateTransactions({
                ids: failedIds.slice(i, i + BATCH_SIZE),
                classificationStatus: 'classification_error',
              }, 'pipeline');
            }
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
      const BATCH_SIZE = 10_000;
      for (let i = 0; i < failedIds.length; i += BATCH_SIZE) {
        await this.transactions.updateTransactions(
          { ids: failedIds.slice(i, i + BATCH_SIZE), classificationStatus: 'classification_error' },
          'pipeline'
        );
      }
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
      if (!classificationIds.has(classId)) {
        debugLog('WARN', `[extractValid] classId=${classId} not in classificationIds=${JSON.stringify([...classificationIds])}`);
        continue;
      }

      const validGroups: number[] = [];
      let outOfRange = 0;
      let duplicates = 0;
      for (const g of groupNumbers) {
        if (g < 1 || g > groupCount) { outOfRange++; continue; }
        if (assignedGroups.has(g)) { duplicates++; continue; }
        assignedGroups.add(g);
        validGroups.push(g);
      }
      if (outOfRange > 0 || duplicates > 0) {
        debugLog('WARN', `[extractValid] classId=${classId}: ${outOfRange} out-of-range, ${duplicates} duplicates, ${validGroups.length} valid out of ${groupNumbers.length}`);
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
        if (ids) {
          for (const id of ids) txnIds.push(id);
        }
      }
      debugLog('INFO', `[applyMulti] classification id=${classification.id}, path="${classification.classificationPath}", ${assignedGroups.length} groups → ${txnIds.length} txnIds`);
      if (txnIds.length === 0) continue;

      const taxonomyNode = taxonomy.find((n) => n.fullPath === classification.classificationPath);
      if (!taxonomyNode) {
        debugLog('WARN', `Taxonomy node not found for path "${classification.classificationPath}" — available: ${taxonomy.filter(n => n.depth === 3).map(n => n.fullPath).slice(0, 5).join(', ')}...`);
      }

      debugLog('INFO', `[applyMulti] updating ${txnIds.length} txns with taxonomyNodeId=${taxonomyNode?.id ?? 'undefined'}, status=classified_by_ai`);
      // Batch updates to avoid stack overflow from spread operators in updateTransactions
      const BATCH_SIZE = 10_000;
      for (let i = 0; i < txnIds.length; i += BATCH_SIZE) {
        const chunk = txnIds.slice(i, i + BATCH_SIZE);
        await this.transactions.updateTransactions({
          ids: chunk,
          taxonomyNodeId: taxonomyNode?.id ?? undefined,
          classificationStatus: 'classified_by_ai',
        }, 'pipeline');
      }
      debugLog('INFO', `[applyMulti] updateTransactions completed for classification id=${classification.id}`);
    }
  }
}
