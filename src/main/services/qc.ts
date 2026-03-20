import type {
  Database,
  TransactionStore as ITransactionStore,
  EventBus,
  QCRunner as IQCRunner,
} from '../../shared/types/services';
import type { QCProgress, QCOutcome } from '../../shared/types/classification';

const CLASSIFIED_STATUSES = `('classified_by_ai', 'classified_by_rule', 'classified_by_qc_agent')`;
const L3_THRESHOLD = 0.95;
const L2_THRESHOLD = 0.95;

interface SpendGroup {
  taxonomy_node_id: string;
  l2: string | null;
  full_path: string | null;
  spend: number;
}

export class QCRunner implements IQCRunner {
  private isRunningFlag = false;
  private isCancelled = false;

  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private eventBus: EventBus
  ) {}

  getIsRunning(): boolean {
    return this.isRunningFlag;
  }

  cancel(): void {
    this.isCancelled = true;
  }

  async runQC(): Promise<void> {
    if (this.isRunningFlag) return;
    this.isRunningFlag = true;
    this.isCancelled = false;

    try {
      const suppliers = await this.db.all<{ project_supplier_id: string; supplier_name: string }>(
        `SELECT DISTINCT CAST(t.project_supplier_id AS VARCHAR) as project_supplier_id,
                         COALESCE(ps.supplier_name, '') as supplier_name
         FROM transactions t
         LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
         WHERE t.classification_status IN ${CLASSIFIED_STATUSES}
           AND t.taxonomy_node_id IS NOT NULL`
      );

      const total = suppliers.length;
      let processed = 0;

      this.emitProgress({
        status: 'running', totalSuppliers: total, processedSuppliers: 0,
        percentage: 0, currentSupplier: null, currentStep: 'Starting QC',
      });

      for (const supplier of suppliers) {
        if (this.isCancelled) break;

        this.emitProgress({
          status: 'running', totalSuppliers: total, processedSuppliers: processed,
          percentage: Math.round((processed / total) * 100),
          currentSupplier: supplier.supplier_name, currentStep: 'Analyzing',
        });

        const { outcome, consolidatedTo } = await this.processSupplier(supplier.project_supplier_id);
        processed++;
        this.emitProgress({
          status: 'running', totalSuppliers: total, processedSuppliers: processed,
          percentage: Math.round((processed / total) * 100),
          currentSupplier: supplier.supplier_name, currentStep: 'Done',
          outcome, consolidatedTo,
        });
      }

      this.emitProgress({
        status: this.isCancelled ? 'cancelled' : 'completed',
        totalSuppliers: total, processedSuppliers: processed,
        percentage: 100, currentSupplier: null,
        currentStep: this.isCancelled ? 'Cancelled' : 'Complete',
      });
    } catch (err) {
      this.emitProgress({
        status: 'failed', totalSuppliers: 0, processedSuppliers: 0,
        percentage: 0, currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isRunningFlag = false;
    }
  }

  private async processSupplier(projectSupplierId: string): Promise<{ outcome: QCOutcome; consolidatedTo?: string }> {
    const groups = await this.db.all<SpendGroup>(
      `SELECT CAST(t.taxonomy_node_id AS VARCHAR) as taxonomy_node_id,
              tax.l2,
              tax.full_path,
              COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) as spend
       FROM transactions t
       LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL
       GROUP BY t.taxonomy_node_id, tax.l2, tax.full_path`,
      projectSupplierId
    );

    // Nothing to consolidate if already on one L3
    if (groups.length <= 1) return { outcome: 'clean' };

    const totalSpend = groups.reduce((s, g) => s + g.spend, 0);
    if (totalSpend === 0) return { outcome: 'skipped' };

    // Pass 1: ≥95% of total spend in one L3 node
    const dominantL3 = groups.find(g => g.spend / totalSpend >= L3_THRESHOLD);
    if (dominantL3) {
      await this.pullOutliersTo(projectSupplierId, dominantL3.taxonomy_node_id);
      return { outcome: 'consolidated', consolidatedTo: dominantL3.full_path ?? undefined };
    }

    // Pass 2: ≥95% of total spend in one L2, AND ≥95% of that L2's spend in one L3
    const byL2 = new Map<string, SpendGroup[]>();
    for (const g of groups) {
      const key = g.l2 ?? '';
      if (!byL2.has(key)) byL2.set(key, []);
      byL2.get(key)!.push(g);
    }

    for (const [, l2Nodes] of byL2) {
      const l2Spend = l2Nodes.reduce((s, g) => s + g.spend, 0);
      if (l2Spend / totalSpend < L2_THRESHOLD) continue;

      const dominantInL2 = l2Nodes.find(g => g.spend / l2Spend >= L3_THRESHOLD);
      if (dominantInL2) {
        await this.pullOutliersTo(projectSupplierId, dominantInL2.taxonomy_node_id);
        return { outcome: 'consolidated', consolidatedTo: dominantInL2.full_path ?? undefined };
      }
    }

    // Neither pass fired — flag all transactions for this supplier for human review
    const allIds = await this.getSupplierTxnIds(projectSupplierId);
    if (allIds.length > 0) {
      await this.transactions.updateTransactions(
        { ids: allIds, flaggedForReview: true },
        'pipeline'
      );
    }
    return { outcome: 'flagged' };
  }

  private async pullOutliersTo(projectSupplierId: string, winnerNodeId: string): Promise<void> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id
       FROM transactions
       WHERE CAST(project_supplier_id AS VARCHAR) = ?
         AND CAST(taxonomy_node_id AS VARCHAR) != ?
         AND classification_status IN ${CLASSIFIED_STATUSES}`,
      projectSupplierId,
      winnerNodeId
    );
    const outlierIds = rows.map(r => r.id);
    if (outlierIds.length === 0) return;

    await this.transactions.updateTransactions(
      { ids: outlierIds, taxonomyNodeId: winnerNodeId, classificationStatus: 'classified_by_qc_agent' },
      'pipeline'
    );
  }

  private async getSupplierTxnIds(projectSupplierId: string): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id
       FROM transactions
       WHERE CAST(project_supplier_id AS VARCHAR) = ?
         AND classification_status IN ${CLASSIFIED_STATUSES}
         AND taxonomy_node_id IS NOT NULL`,
      projectSupplierId
    );
    return rows.map(r => r.id);
  }

  private emitProgress(progress: QCProgress): void {
    this.eventBus.emit('qc:progress', progress);
  }
}
