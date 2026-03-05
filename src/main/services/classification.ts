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
import type { ClassificationProgress } from '../../shared/types/classification';
import { cleanDescription } from '../utils/text';

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

  async classifyAll(): Promise<void> {
    if (this.isRunningFlag) {
      throw new Error('Classification is already running');
    }

    this.isRunningFlag = true;
    this.isCancelled = false;

    try {
      // Get all project suppliers with unclassified transactions
      const supplierRows = await this.db.all<{ id: string; supplier_name: string }>(
        `SELECT DISTINCT ps.id, ps.supplier_name
         FROM project_suppliers ps
         JOIN transactions t ON t.project_supplier_id = ps.id
         WHERE t.classification_status = 'unclassified'
         ORDER BY ps.supplier_name`
      );

      if (supplierRows.length === 0) {
        this.emitProgress({
          status: 'completed',
          totalSuppliers: 0,
          processedSuppliers: 0,
          percentage: 100,
          currentSupplier: null,
          currentStep: 'No unclassified transactions',
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
          await this.classifySupplier(supplier.id, taxonomyNodes, companyContext, columnPriorities);
        } catch (err) {
          console.error(`[Classification] Failed for "${supplier.supplier_name}":`, err);
          // Mark failed transactions
          const failedTxns = await this.db.all<{ id: string }>(
            `SELECT id FROM transactions WHERE project_supplier_id = ? AND classification_status = 'unclassified'`,
            supplier.id
          );
          if (failedTxns.length > 0) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.transactions.updateTransactions(
              {
                ids: failedTxns.map((t) => t.id),
                classificationStatus: 'classification_failed',
                classificationReasoning: `Classification failed: ${errMsg}`,
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
    columnPriorities: string[]
  ): Promise<void> {
    // Step 1: Get unclassified transactions for this supplier
    const txnRows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE project_supplier_id = ? AND classification_status = 'unclassified'`,
      projectSupplierId
    );

    if (txnRows.length === 0) return;

    const txnIds = txnRows.map((r) => String(r.id));

    // Step 2: Apply override rules
    const ruleMatches = await this.rules.evaluateRules(txnIds);

    const txnsByTargetNode = new Map<string, string[]>();
    const matchedTxnIds = new Set<string>();

    for (const [txnId, match] of ruleMatches.entries()) {
      let ids = txnsByTargetNode.get(match.targetTaxonomyNodeId);
      if (!ids) {
        ids = [];
        txnsByTargetNode.set(match.targetTaxonomyNodeId, ids);
      }
      ids.push(txnId);
      matchedTxnIds.add(txnId);
    }

    for (const [targetNodeId, ids] of txnsByTargetNode) {
      await this.transactions.updateTransactions(
        {
          ids,
          taxonomyNodeId: targetNodeId,
          classificationStatus: 'classified_by_rule',
          classificationReasoning: 'Matched override rule',
        },
        'rule'
      );
    }

    // Step 3: AI classify unmatched transactions
    const unmatchedTxns = txnRows.filter((r) => !matchedTxnIds.has(String(r.id)));
    if (unmatchedTxns.length === 0) return;

    // Get supplier name for research lookup
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

    // Clean descriptions
    const cleanedTxns = unmatchedTxns.map((txn) => {
      const cleaned = { ...txn };
      if (typeof cleaned.gl_description === 'string') {
        cleaned.gl_description = cleanDescription(cleaned.gl_description);
      }
      return cleaned;
    });

    // Classify the batch
    const result = await this.classificationAgent.classifyInvoiceGroup({
      transactions: cleanedTxns,
      taxonomy,
      companyContext,
      supplierResearch,
      parentName,
      historicalClassifications: [],
      columnPriorities,
    });

    const taxonomyNode = taxonomy.find(
      (n) => n.fullPath === result.classificationPath
    );

    if (!taxonomyNode) {
      console.warn(
        `[Classification] Taxonomy node not found for path "${result.classificationPath}" — transaction(s) will be classified without a node`
      );
    }

    // Apply classification
    const unmatchedIds = unmatchedTxns.map((r) => String(r.id));
    const reasoning = taxonomyNode
      ? result.reasoning
      : `${result.reasoning}\n[Warning: LLM returned path "${result.classificationPath}" which did not match any taxonomy node]`;

    await this.transactions.updateTransactions(
      {
        ids: unmatchedIds,
        taxonomyNodeId: taxonomyNode?.id ?? undefined,
        classificationStatus: 'classified_by_ai',
        classificationReasoning: reasoning,
      },
      'pipeline'
    );
  }
}
