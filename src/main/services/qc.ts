import type {
  Database,
  TransactionStore as ITransactionStore,
  EventBus,
  QCRunner as IQCRunner,
} from '../../shared/types/services';
import type { QCProgress, QCOutcome } from '../../shared/types/classification';
import type { TransactionFilter } from '../../shared/types/transactions';
import { buildWhereClause } from '../utils/query-builder';
import { debugLog } from '../utils/debug-log';

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

  stop(): void {
    this.isCancelled = true;
  }

  private buildFilterSQL(filter?: TransactionFilter): { sql: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];

    if (filter?.humanReviewed === false) {
      parts.push('(t.human_reviewed IS NULL OR t.human_reviewed = false)');
    }

    if (filter?.conditions?.length) {
      const result = buildWhereClause(filter.conditions, (field) => `t.${field}`);
      if (result) {
        parts.push(result.sql);
        params.push(...result.params);
      }
    }

    return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
  }

  async getSupplierCount(filter?: TransactionFilter): Promise<number> {
    const { sql: filterSQL, params: filterParams } = this.buildFilterSQL(filter);
    const rows = await this.db.all<{ count: number }>(
      `SELECT COUNT(DISTINCT t.project_supplier_id) as count
       FROM transactions t
       WHERE t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL${filterSQL}`,
      ...filterParams
    );
    return rows[0]?.count ?? 0;
  }

  async runQC(filter?: TransactionFilter): Promise<void> {
    if (this.isRunningFlag) return;
    this.isRunningFlag = true;
    this.isCancelled = false;

    const { sql: filterSQL, params: filterParams } = this.buildFilterSQL(filter);

    try {
      const suppliers = await this.db.all<{ project_supplier_id: string; supplier_name: string }>(
        `SELECT DISTINCT CAST(t.project_supplier_id AS VARCHAR) as project_supplier_id,
                         COALESCE(ps.supplier_name, '') as supplier_name
         FROM transactions t
         LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
         WHERE t.classification_status IN ${CLASSIFIED_STATUSES}
           AND t.taxonomy_node_id IS NOT NULL${filterSQL}`,
        ...filterParams
      );

      const total = suppliers.length;
      let processed = 0;

      debugLog('INFO', `[QC] Starting — ${total} suppliers to process`);
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

        const { outcome, consolidatedTo } = await this.processSupplier(supplier.project_supplier_id, filterSQL, filterParams);
        processed++;
        this.emitProgress({
          status: 'running', totalSuppliers: total, processedSuppliers: processed,
          percentage: Math.round((processed / total) * 100),
          currentSupplier: supplier.supplier_name, currentStep: 'Done',
          outcome, consolidatedTo,
        });
      }

      const finalStatus = this.isCancelled ? 'cancelled' : 'completed';
      debugLog('INFO', `[QC] ${finalStatus} — processed ${processed}/${total}`);
      this.emitProgress({
        status: finalStatus,
        totalSuppliers: total, processedSuppliers: processed,
        percentage: 100, currentSupplier: null,
        currentStep: this.isCancelled ? 'Cancelled' : 'Complete',
      });
    } catch (err) {
      debugLog('ERROR', '[QC] runQC threw', err instanceof Error ? err.message : String(err));
      this.emitProgress({
        status: 'failed', totalSuppliers: 0, processedSuppliers: 0,
        percentage: 0, currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isRunningFlag = false;
    }
  }

  private async processSupplier(projectSupplierId: string, filterSQL: string, filterParams: unknown[]): Promise<{ outcome: QCOutcome; consolidatedTo?: string }> {
    const groups = await this.db.all<SpendGroup>(
      `SELECT CAST(t.taxonomy_node_id AS VARCHAR) as taxonomy_node_id,
              tax.l2,
              tax.full_path,
              COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) as spend
       FROM transactions t
       LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL${filterSQL}
       GROUP BY t.taxonomy_node_id, tax.l2, tax.full_path`,
      projectSupplierId,
      ...filterParams
    );

    // Nothing to consolidate if already on one L3
    if (groups.length <= 1) return { outcome: 'clean' };

    const totalSpend = groups.reduce((s, g) => s + g.spend, 0);
    if (totalSpend === 0) return { outcome: 'skipped' };

    // Pass 1: ≥95% of total spend in one L3 node
    const dominantL3 = groups.find(g => g.spend / totalSpend >= L3_THRESHOLD);
    if (dominantL3) {
      await this.pullOutliersTo(projectSupplierId, dominantL3.taxonomy_node_id, filterSQL, filterParams);
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
        await this.pullOutliersTo(projectSupplierId, dominantInL2.taxonomy_node_id, filterSQL, filterParams);
        return { outcome: 'consolidated', consolidatedTo: dominantInL2.full_path ?? undefined };
      }
    }

    // Neither pass fired — flag all transactions for this supplier for human review
    const allIds = await this.getSupplierTxnIds(projectSupplierId, filterSQL, filterParams);
    if (allIds.length > 0) {
      await this.transactions.updateTransactions(
        { ids: allIds, flaggedForReview: true },
        'pipeline'
      );
    }
    return { outcome: 'flagged' };
  }

  private async pullOutliersTo(projectSupplierId: string, winnerNodeId: string, filterSQL: string, filterParams: unknown[]): Promise<void> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id
       FROM transactions t
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND CAST(t.taxonomy_node_id AS VARCHAR) != ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}${filterSQL}`,
      projectSupplierId,
      winnerNodeId,
      ...filterParams
    );
    const outlierIds = rows.map(r => r.id);
    if (outlierIds.length === 0) return;

    await this.transactions.updateTransactions(
      { ids: outlierIds, taxonomyNodeId: winnerNodeId, classificationStatus: 'classified_by_qc_agent' },
      'pipeline'
    );
  }

  private async getSupplierTxnIds(projectSupplierId: string, filterSQL: string, filterParams: unknown[]): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id
       FROM transactions t
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL${filterSQL}`,
      projectSupplierId,
      ...filterParams
    );
    return rows.map(r => r.id);
  }

  private emitProgress(progress: QCProgress): void {
    this.eventBus.emit('qc:progress', progress);
  }
}
