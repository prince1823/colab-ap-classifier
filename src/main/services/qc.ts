import type {
  Database,
  TransactionStore as ITransactionStore,
  ProjectStore as IProjectStore,
  EventBus,
  QCRunner as IQCRunner,
  QCAgent as IQCAgent,
  SupplierUniverse,
  TaxonomyStore as ITaxonomyStore,
} from '../../shared/types/services';
import type { QCProgress, QCOutcome, QCConfig, FilterConditionQC, SpendByTaxonomyResult } from '../../shared/types/classification';
import type { TransactionFilter } from '../../shared/types/transactions';
import { buildDedupGroups } from '../utils/dedup-groups';
import { findClosestTaxonomyMatch } from '../agents/classification-agent';
import { DEFAULT_QC_RULES } from '../agents/qc-agent';
import { debugLog } from '../utils/debug-log';

const CLASSIFIED_STATUSES = `('classified_by_ai', 'classified_by_rule', 'classified_by_qc_agent')`;

export const DEFAULT_QC_CONFIG: QCConfig = {
  scope: [],
  algorithmic: { enabled: true, l3Threshold: 0.95, l2Threshold: 0.90 },
  llm: {
    enabled: true,
    gateConditions: [{ field: 'algorithmic_resolved', operator: 'is_false' }],
    rules: DEFAULT_QC_RULES,
  },
};

interface SupplierQCData {
  id: string;
  supplierName: string;
  isTailSpend: boolean;
  isResearched: boolean;
  totalSpend: number;
  transactionCount: number;
  numCategories: number;
  algorithmicResolved?: boolean;
}

export class QCRunner implements IQCRunner {
  private isRunningFlag = false;
  private isStopped = false;

  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private eventBus: EventBus,
    private qcAgent: IQCAgent,
    private supplierUniverse: SupplierUniverse,
    private project: IProjectStore,
    private taxonomy: ITaxonomyStore
  ) {}

  getIsRunning(): boolean {
    return this.isRunningFlag;
  }

  stop(): void {
    this.isStopped = true;
  }

  async getSupplierCount(filter?: TransactionFilter): Promise<number> {
    const rows = await this.db.all<{ count: number }>(
      `SELECT COUNT(DISTINCT t.project_supplier_id) as count
       FROM transactions t
       WHERE t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL`
    );
    return rows[0]?.count ?? 0;
  }

  async runQC(config?: QCConfig): Promise<void> {
    if (this.isRunningFlag) return;
    this.isRunningFlag = true;
    this.isStopped = false;

    const cfg = this.mergeWithDefaults(config);

    try {
      // Resolve scoped suppliers
      const suppliers = await this.resolveScopedSuppliers(cfg.scope);
      const total = suppliers.length;
      let processed = 0;

      debugLog('INFO', `[QC] Starting — ${total} suppliers to process`);
      this.emitProgress({
        status: 'running', totalSuppliers: total, processedSuppliers: 0,
        percentage: 0, currentSupplier: null, currentStep: 'Starting QC',
      });

      // ── Algorithmic pass ──
      if (cfg.algorithmic.enabled) {
        for (const supplier of suppliers) {
          if (this.isStopped) break;

          this.emitProgress({
            status: 'running', totalSuppliers: total, processedSuppliers: processed,
            percentage: Math.round((processed / total) * 100),
            currentSupplier: supplier.supplierName, currentStep: 'Algorithmic analysis',
          });

          const { outcome, consolidatedTo } = await this.runAlgorithmicPass(
            supplier, cfg.algorithmic.l3Threshold, cfg.algorithmic.l2Threshold
          );

          supplier.algorithmicResolved = outcome === 'consolidated' || outcome === 'clean';
          processed++;

          this.emitProgress({
            status: 'running', totalSuppliers: total, processedSuppliers: processed,
            percentage: Math.round((processed / total) * 100),
            currentSupplier: supplier.supplierName, currentStep: 'Done',
            outcome, consolidatedTo,
          });
        }
      } else {
        // Mark all as unresolved
        for (const s of suppliers) s.algorithmicResolved = false;
      }

      if (this.isStopped) {
        this.emitFinish(total, processed, true);
        return;
      }

      // ── LLM pass ──
      if (cfg.llm.enabled) {
        const llmSuppliers = this.filterByGateConditions(suppliers, cfg.llm.gateConditions);
        const rules = cfg.llm.rules || DEFAULT_QC_RULES;

        debugLog('INFO', `[QC] LLM pass — ${llmSuppliers.length} suppliers`);

        // Reset progress for LLM pass
        processed = 0;
        const llmTotal = llmSuppliers.length;

        for (const supplier of llmSuppliers) {
          if (this.isStopped) break;

          this.emitProgress({
            status: 'running', totalSuppliers: total, processedSuppliers: total - llmTotal + processed,
            percentage: Math.round(((total - llmTotal + processed) / total) * 100),
            currentSupplier: supplier.supplierName, currentStep: 'LLM review',
          });

          try {
            await this.runLLMPass(supplier, rules);
          } catch (err) {
            debugLog('ERROR', `[QC] LLM pass failed for ${supplier.supplierName}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          processed++;
        }
      }

      this.emitFinish(total, total, this.isStopped);
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

  private mergeWithDefaults(config?: QCConfig): QCConfig {
    if (!config) return DEFAULT_QC_CONFIG;
    return {
      scope: config.scope ?? [],
      algorithmic: {
        enabled: config.algorithmic?.enabled ?? true,
        l3Threshold: config.algorithmic?.l3Threshold ?? 0.95,
        l2Threshold: config.algorithmic?.l2Threshold ?? 0.90,
      },
      llm: {
        enabled: config.llm?.enabled ?? true,
        gateConditions: config.llm?.gateConditions ?? DEFAULT_QC_CONFIG.llm.gateConditions,
        rules: config.llm?.rules || DEFAULT_QC_RULES,
      },
    };
  }

  private async resolveScopedSuppliers(scope: FilterConditionQC[]): Promise<SupplierQCData[]> {
    const rows = await this.db.all<{
      id: string;
      supplier_name: string;
      is_tail_spend: boolean;
      is_researched: boolean;
      transaction_count: number;
      total_spend: number;
      num_categories: number;
    }>(
      `SELECT CAST(ps.id AS VARCHAR) as id,
              ps.supplier_name,
              COALESCE(ps.is_tail_spend, false) as is_tail_spend,
              COALESCE(ps.is_researched, false) as is_researched,
              COUNT(t.id) as transaction_count,
              COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) as total_spend,
              COUNT(DISTINCT t.taxonomy_node_id) as num_categories
       FROM project_suppliers ps
       JOIN transactions t ON t.project_supplier_id = ps.id
       WHERE t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL
       GROUP BY ps.id, ps.supplier_name, ps.is_tail_spend, ps.is_researched`
    );

    let suppliers: SupplierQCData[] = rows.map((r) => ({
      id: r.id,
      supplierName: r.supplier_name ?? '',
      isTailSpend: !!r.is_tail_spend,
      isResearched: !!r.is_researched,
      totalSpend: r.total_spend,
      transactionCount: Number(r.transaction_count),
      numCategories: Number(r.num_categories),
    }));

    // Apply scope conditions
    if (scope.length > 0) {
      suppliers = suppliers.filter((s) => this.matchesConditions(s, scope));
    }

    return suppliers;
  }

  private matchesConditions(supplier: SupplierQCData, conditions: FilterConditionQC[]): boolean {
    return conditions.every((c) => this.matchesCondition(supplier, c));
  }

  private matchesCondition(supplier: SupplierQCData, cond: FilterConditionQC): boolean {
    const fieldMap: Record<string, unknown> = {
      is_tail_spend: supplier.isTailSpend,
      is_researched: supplier.isResearched,
      total_spend: supplier.totalSpend,
      transaction_count: supplier.transactionCount,
      num_categories: supplier.numCategories,
      algorithmic_resolved: supplier.algorithmicResolved,
    };

    const val = fieldMap[cond.field];

    switch (cond.operator) {
      case 'is_true': return val === true;
      case 'is_false': return val === false || val === undefined;
      case 'equals': return val === cond.value;
      case 'not_equals': return val !== cond.value;
      case 'greater_than': return typeof val === 'number' && typeof cond.value === 'number' && val > cond.value;
      case 'less_than': return typeof val === 'number' && typeof cond.value === 'number' && val < cond.value;
      default: return true;
    }
  }

  private filterByGateConditions(suppliers: SupplierQCData[], conditions: FilterConditionQC[]): SupplierQCData[] {
    if (conditions.length === 0) return suppliers;
    return suppliers.filter((s) => this.matchesConditions(s, conditions));
  }

  private async runAlgorithmicPass(
    supplier: SupplierQCData,
    l3Threshold: number,
    l2Threshold: number
  ): Promise<{ outcome: QCOutcome; consolidatedTo?: string }> {
    let groups: SpendByTaxonomyResult[];
    try {
      groups = await this.transactions.getSpendByTaxonomy(supplier.id);
    } catch {
      return { outcome: 'skipped' };
    }

    if (groups.length <= 1) return { outcome: 'clean' };

    const totalSpend = groups.reduce((s, g) => s + g.spend, 0);
    if (totalSpend === 0) return { outcome: 'skipped' };

    // Pass 1: L3 consolidation
    const dominantL3 = groups.find((g) => g.spend / totalSpend >= l3Threshold);
    if (dominantL3) {
      await this.pullOutliersTo(supplier.id, dominantL3.taxonomyNodeId);
      return { outcome: 'consolidated', consolidatedTo: dominantL3.fullPath };
    }

    // Pass 2: L2 consolidation
    const byL2 = new Map<string, SpendByTaxonomyResult[]>();
    for (const g of groups) {
      const key = g.l2 ?? '';
      if (!byL2.has(key)) byL2.set(key, []);
      byL2.get(key)!.push(g);
    }

    for (const [, l2Nodes] of byL2) {
      const l2Spend = l2Nodes.reduce((s, g) => s + g.spend, 0);
      if (l2Spend / totalSpend < l2Threshold) continue;

      const dominantInL2 = l2Nodes.find((g) => g.spend / l2Spend >= l3Threshold);
      if (dominantInL2) {
        await this.pullOutliersTo(supplier.id, dominantInL2.taxonomyNodeId);
        return { outcome: 'consolidated', consolidatedTo: dominantInL2.fullPath };
      }
    }

    // Neither pass fired — flag for review
    const allIds = await this.getSupplierTxnIds(supplier.id);
    if (allIds.length > 0) {
      await this.transactions.updateTransactions(
        { ids: allIds, flaggedForReview: true },
        'pipeline'
      );
    }
    return { outcome: 'flagged' };
  }

  private async runLLMPass(supplier: SupplierQCData, rules: string): Promise<void> {
    const summary = await this.buildSupplierSummary(supplier);
    const result = await this.qcAgent.review({ supplierSummary: summary, rules });

    if (result.noChangeNeeded || result.recommendations.length === 0) return;

    // Get column priorities for dedup group mapping
    const columnPriorities = await this.project.getSetting('column_priorities') as string[] | null;

    // Build the same dedup groups as the summary to map group numbers → txn IDs
    const taxonomyNodes = await this.taxonomy.getNodes();
    let groups: SpendByTaxonomyResult[];
    try {
      groups = await this.transactions.getSpendByTaxonomy(supplier.id);
    } catch {
      return;
    }

    // Build a flat mapping: group number → transaction IDs
    const groupToTxnIds = new Map<number, string[]>();
    let groupOffset = 0;

    for (const spendGroup of groups) {
      const txns = await this.transactions.getTransactionsByTaxonomy(
        supplier.id, spendGroup.taxonomyNodeId, columnPriorities ?? []
      );
      const { groupToTransactionIds } = buildDedupGroups(txns, columnPriorities ?? []);
      for (const [localGroupNum, ids] of groupToTransactionIds) {
        groupToTxnIds.set(groupOffset + localGroupNum, ids);
      }
      groupOffset += groupToTransactionIds.size;
    }

    // Apply recommendations
    for (const rec of result.recommendations) {
      const txnIds: string[] = [];
      for (const gn of rec.groupNumbers) {
        const ids = groupToTxnIds.get(gn);
        if (ids) {
          txnIds.push(...ids);
        } else {
          debugLog('WARN', `[QC] Invalid group number ${gn} in LLM recommendation for ${supplier.supplierName}`);
        }
      }
      if (txnIds.length === 0) continue;

      // Resolve taxonomy path
      const matched = findClosestTaxonomyMatch(rec.toClassificationPath, taxonomyNodes);
      const targetNode = taxonomyNodes.find((n) => n.fullPath === matched);
      if (!targetNode) {
        debugLog('WARN', `[QC] Could not resolve taxonomy path "${rec.toClassificationPath}" for ${supplier.supplierName}`);
        continue;
      }

      await this.transactions.updateTransactions({
        ids: txnIds,
        taxonomyNodeId: targetNode.id,
        classificationStatus: 'classified_by_qc_agent',
        flaggedForReview: true,
      }, 'pipeline');
    }
  }

  private async buildSupplierSummary(supplier: SupplierQCData): Promise<string> {
    const sections: string[] = [];

    // Supplier context
    const supplierInfo = await this.db.get<{ parent_name: string | null }>(
      `SELECT sp.name AS parent_name
       FROM project_suppliers ps
       LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id
       WHERE ps.id = ?`,
      supplier.id
    );

    let research = null;
    if (supplier.supplierName) {
      research = await this.supplierUniverse.getSupplier(supplier.supplierName);
    }

    const contextParts: string[] = [];
    contextParts.push(`Name: ${supplier.supplierName}`);
    if (research?.supplierType) contextParts.push(`Type: ${research.supplierType}`);
    if (research?.industry) contextParts.push(`Industry: ${research.industry}`);
    if (research?.productsServices) contextParts.push(`Products/Services: ${research.productsServices}`);
    if (supplierInfo?.parent_name) contextParts.push(`Parent Company: ${supplierInfo.parent_name}`);
    contextParts.push(`Tail Spend: ${supplier.isTailSpend ? 'yes' : 'no'}`);
    contextParts.push(`Total Spend: $${supplier.totalSpend.toLocaleString()}`);
    contextParts.push(`Transaction Count: ${supplier.transactionCount}`);

    sections.push(`SUPPLIER CONTEXT\n  ${contextParts.join('\n  ')}`);

    // Current classifications with transaction groups
    const columnPriorities = await this.project.getSetting('column_priorities') as string[] | null;
    let spendGroups: SpendByTaxonomyResult[];
    try {
      spendGroups = await this.transactions.getSpendByTaxonomy(supplier.id);
    } catch {
      spendGroups = [];
    }

    const classLines: string[] = [];
    let globalGroupNum = 0;
    for (const sg of spendGroups) {
      classLines.push(`  ${sg.fullPath} — $${sg.spend.toLocaleString()} (${sg.txnCount} txns)`);

      // Get transaction groups for this classification
      const txns = await this.transactions.getTransactionsByTaxonomy(
        supplier.id, sg.taxonomyNodeId, columnPriorities ?? []
      );
      if (txns.length > 0) {
        const { groupToTransactionIds } = buildDedupGroups(txns, columnPriorities ?? []);
        for (const [localNum, ids] of groupToTransactionIds) {
          globalGroupNum++;
          const fields = txns.find((t) => ids.includes(String(t.id)));
          const fieldStr = fields
            ? Object.entries(fields)
              .filter(([k]) => k !== 'id' && (columnPriorities ?? []).includes(k))
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')
            : '';
          classLines.push(`    Group ${globalGroupNum} (${ids.length} rows): {${fieldStr}}`);
        }
      }
    }
    sections.push(`CURRENT CLASSIFICATIONS\n${classLines.join('\n')}`);

    // Company context
    let companyContext: Record<string, unknown> = {};
    try {
      companyContext = (await this.project.getSetting('company_context') as Record<string, unknown>) ?? {};
    } catch { /* empty */ }

    const ccParts: string[] = [];
    if (companyContext.industry) ccParts.push(`Industry: ${companyContext.industry}`);
    if (companyContext.description) ccParts.push(`Description: ${companyContext.description}`);
    if (companyContext.sisterCompanies) ccParts.push(`Sister Companies: ${companyContext.sisterCompanies}`);
    if (companyContext.additionalDetails) ccParts.push(`Additional Details: ${companyContext.additionalDetails}`);
    sections.push(`COMPANY CONTEXT\n  ${ccParts.join('\n  ')}`);

    // Available taxonomy
    const taxonomyNodes = await this.taxonomy.getNodes();
    const taxonomyLines = taxonomyNodes
      .filter((n) => n.depth === 3)
      .map((n) => {
        const desc = n.description ? ` - ${n.description}` : '';
        return `  ${n.fullPath}${desc}`;
      });
    sections.push(`AVAILABLE TAXONOMY\n${taxonomyLines.join('\n')}`);

    return sections.join('\n\n');
  }

  private async pullOutliersTo(projectSupplierId: string, winnerNodeId: string): Promise<void> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id
       FROM transactions t
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND CAST(t.taxonomy_node_id AS VARCHAR) != ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}`,
      projectSupplierId,
      winnerNodeId
    );
    const outlierIds = rows.map((r) => r.id);
    if (outlierIds.length === 0) return;

    await this.transactions.updateTransactions(
      { ids: outlierIds, taxonomyNodeId: winnerNodeId, classificationStatus: 'classified_by_qc_agent', flaggedForReview: true },
      'pipeline'
    );
  }

  private async getSupplierTxnIds(projectSupplierId: string): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id
       FROM transactions t
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL`,
      projectSupplierId
    );
    return rows.map((r) => r.id);
  }

  private emitProgress(progress: QCProgress): void {
    this.eventBus.emit('qc:progress', progress);
  }

  private emitFinish(total: number, processed: number, cancelled: boolean): void {
    const finalStatus = cancelled ? 'cancelled' : 'completed';
    debugLog('INFO', `[QC] ${finalStatus} — processed ${processed}/${total}`);
    this.emitProgress({
      status: finalStatus, totalSuppliers: total, processedSuppliers: processed,
      percentage: 100, currentSupplier: null,
      currentStep: cancelled ? 'Stopped' : 'Complete',
    });
  }
}
