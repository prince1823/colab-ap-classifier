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
import { cleanDescription } from '../utils/text';
import { buildDedupGroups, batchDedupGroups, extractSubBatch } from '../utils/dedup-groups';
import { debugLog } from '../utils/debug-log';

export class ClassificationRunner implements IClassificationRunner {
  private isRunningFlag = false;
  private isCancelled = false;

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

  async cancel(): Promise<void> {
    this.isCancelled = true;
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
   * Resolve filter conditions to a set of matching transaction IDs.
   * Returns null when no conditions are provided (meaning: use default behavior).
   */
  private async resolveScopedIds(conditions?: FilterCondition[]): Promise<Set<string> | null> {
    if (!conditions || conditions.length === 0) return null;
    const ids = await this.transactions.getIdsByConditions(conditions);
    return new Set(ids);
  }

  async getScopeCount(conditions?: FilterCondition[]): Promise<number> {
    if (!conditions || conditions.length === 0) {
      // Default: count all unclassified
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
    this.isCancelled = false;

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

        // Get suppliers that have transactions in the scoped set
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
        // Default: all suppliers with unclassified transactions
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

      // Load and validate column priorities
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

      for (const supplier of supplierRows) {
        if (this.isCancelled) break;

        this.emitProgress({
          status: 'running',
          totalSuppliers,
          processedSuppliers,
          percentage: totalSuppliers > 0 ? Math.round((processedSuppliers / totalSuppliers) * 100) : 0,
          currentSupplier: supplier.supplier_name,
          currentStep: `Classifying: ${supplier.supplier_name}`,
        });

        try {
          await this.classifySupplier(supplier.id, taxonomyNodes, companyContext, columnPriorities, scopedIds ?? undefined);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          debugLog('ERROR', `Classification failed for supplier "${supplier.supplier_name}"`, { error: errMsg });
          // Mark failed transactions — scope to scoped IDs if provided
          let failedQuery = `SELECT id FROM transactions WHERE project_supplier_id = ?`;
          const failedParams: unknown[] = [supplier.id];

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
              {
                ids: failedTxns.map((t) => t.id),
                classificationStatus: 'classification_error',
              },
              'pipeline'
            );
          }
        }

        processedSuppliers++;
      }

      if (this.isCancelled) return;

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
      if (!this.isCancelled) {
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
      this.isCancelled = false;
    }
  }

  async classifySupplier(
    projectSupplierId: string,
    taxonomy: TaxonomyNode[],
    companyContext: CompanyContext,
    columnPriorities: string[],
    scopedTxnIds?: Set<string>
  ): Promise<void> {
    // Step 1: Get transactions for this supplier (scoped or default unclassified)
    let txnRows: Record<string, unknown>[];

    if (scopedTxnIds) {
      // Get all transactions for this supplier, then filter to scoped IDs
      const allTxns = await this.db.all<Record<string, unknown>>(
        `SELECT * FROM transactions WHERE project_supplier_id = ?`,
        projectSupplierId
      );
      txnRows = allTxns.filter((r) => scopedTxnIds.has(String(r.id)));
    } else {
      txnRows = await this.db.all<Record<string, unknown>>(
        `SELECT * FROM transactions WHERE project_supplier_id = ? AND classification_status = 'unclassified'`,
        projectSupplierId
      );
    }

    if (txnRows.length === 0) return;

    const txnIds = txnRows.map((r) => String(r.id));

    // Step 2: Apply override rules
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
        {
          ids,
          taxonomyNodeId: targetNodeId,
          classificationStatus: 'classified_by_rule',
          appliedRuleId: ruleId,
        },
        'rule'
      );
    }

    // Step 3: AI classify unmatched transactions
    const unmatchedTxns = txnRows.filter((r) => !matchedTxnIds.has(String(r.id)));
    if (unmatchedTxns.length === 0) return;

    // Get canonical supplier name from project_suppliers
    const supplierRow = await this.db.get<{ supplier_name: string }>(
      'SELECT supplier_name FROM project_suppliers WHERE id = ?',
      projectSupplierId
    );
    const supplierName = supplierRow?.supplier_name;

    // Get supplier research from universe
    let supplierResearch = null;
    let parentName: string | null = null;
    if (supplierName) {
      supplierResearch = await this.supplierUniverse.getSupplier(supplierName);
    }

    // Clean descriptions and inject canonical supplier_name, overriding the raw CSV alias
    const cleanedTxns = unmatchedTxns.map((txn) => {
      const cleaned = { ...txn };
      if (typeof cleaned.gl_description === 'string') {
        cleaned.gl_description = cleanDescription(cleaned.gl_description);
      }
      // supplier_name on transactions holds the raw CSV alias; replace it with the
      // canonical project supplier name so column priorities reflect the project supplier
      if (supplierName) cleaned.supplier_name = supplierName;
      return cleaned;
    });

    // Build dedup groups and split into batches
    const dedupResult = buildDedupGroups(cleanedTxns, columnPriorities);
    const batches = batchDedupGroups(dedupResult);

    debugLog('INFO', `Supplier ${supplierName ?? projectSupplierId}: ${dedupResult.groupCount} groups in ${batches.length} batch(es)`);

    for (const batch of batches) {
      if (this.isCancelled) return;

      // Collect all transaction IDs in this batch for fallback error marking
      const allBatchTxnIds = new Set<string>();
      for (const ids of batch.groupToTransactionIds.values()) {
        for (const id of ids) allBatchTxnIds.add(id);
      }

      const MAX_ATTEMPTS = 3;
      let remainingBatch = batch;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (this.isCancelled) return;

        // Build transaction list for current (possibly narrowed) batch
        const currentTxnIds = new Set<string>();
        for (const ids of remainingBatch.groupToTransactionIds.values()) {
          for (const id of ids) currentTxnIds.add(id);
        }
        const currentTxns = cleanedTxns.filter((t) => currentTxnIds.has(String(t.id)));

        try {
          const result = await this.classificationAgent.classifyInvoiceGroup({
            transactions: currentTxns,
            taxonomy,
            companyContext,
            supplierResearch,
            parentName,
            columnPriorities,
          });

          const { validResult, missedGroups } = this.extractValidAssignments(result, remainingBatch.groupCount);

          // Apply whatever succeeded
          if (Object.keys(validResult.assignments).length > 0) {
            await this.applyMultiClassification(validResult, remainingBatch.groupToTransactionIds, taxonomy);
          }

          if (missedGroups.length === 0) {
            break; // fully classified
          }

          debugLog('WARN', `Supplier ${supplierName ?? projectSupplierId}: ${missedGroups.length} groups missed on attempt ${attempt}/${MAX_ATTEMPTS}, retrying missed groups`);

          if (attempt < MAX_ATTEMPTS) {
            // Narrow to only missed groups for next attempt
            remainingBatch = extractSubBatch(remainingBatch, missedGroups);
          } else {
            // Final attempt exhausted — mark remaining transactions as error
            const failedTxnIds: string[] = [];
            for (const g of missedGroups) {
              const ids = remainingBatch.groupToTransactionIds.get(g);
              if (ids) failedTxnIds.push(...ids);
            }
            if (failedTxnIds.length > 0) {
              debugLog('ERROR', `All ${MAX_ATTEMPTS} attempts exhausted for supplier ${supplierName ?? projectSupplierId}: ${failedTxnIds.length} transactions unclassified`);
              await this.transactions.updateTransactions({
                ids: failedTxnIds,
                classificationStatus: 'classification_error',
              }, 'pipeline');
            }
          }
        } catch (err) {
          // Total parse/LLM failure — no partial results possible
          const errMsg = err instanceof Error ? err.message : String(err);
          debugLog('WARN', `Classification attempt ${attempt}/${MAX_ATTEMPTS} failed for supplier ${supplierName ?? projectSupplierId}`, { error: errMsg });
          if (attempt === MAX_ATTEMPTS) {
            debugLog('ERROR', `All ${MAX_ATTEMPTS} classification attempts failed for supplier ${supplierName ?? projectSupplierId}`, { error: errMsg });
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

  /**
   * Extract valid assignments from a classification result, skipping invalid entries.
   * Returns the cleaned assignments and any group numbers that were not assigned.
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
      if (!classificationIds.has(classId)) continue; // skip unknown classification IDs

      const validGroups: number[] = [];
      for (const g of groupNumbers) {
        if (g < 1 || g > groupCount) continue; // skip out-of-range
        if (assignedGroups.has(g)) continue; // skip duplicates
        assignedGroups.add(g);
        validGroups.push(g);
      }
      if (validGroups.length > 0) {
        cleanedAssignments[classIdStr] = validGroups;
      }
    }

    // Find unassigned groups
    const missedGroups: number[] = [];
    for (let g = 1; g <= groupCount; g++) {
      if (!assignedGroups.has(g)) missedGroups.push(g);
    }

    // Filter classifications to only those that have assignments
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

      // Collect all transaction IDs for this classification
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
