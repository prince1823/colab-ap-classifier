import { v4 as uuidv4 } from 'uuid';
import type { Database, RuleStore as IRuleStore, TransactionStore as ITransactionStore, ProjectStore as IProjectStore } from '../../shared/types/services';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate, GenerateRulesResult, RuleSource } from '../../shared/types/rules';
import type { GroupedFilter } from '../../shared/types/transactions';

interface RuleRow {
  id: string;
  name: string;
  grouped_conditions: string;
  target_taxonomy_node_id: string;
  priority: number;
  is_active: boolean;
  source: string;
  created_at: string;
}

function parseGroupedConditions(raw: unknown): GroupedFilter {
  const fallback: GroupedFilter = { groupConnector: 'AND', groups: [] };
  if (!raw) return fallback;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as GroupedFilter).groups)) {
      return parsed as GroupedFilter;
    }
  } catch { /* ignore */ }
  return fallback;
}

function rowToRule(row: RuleRow): OverrideRule {
  const grouped = parseGroupedConditions(row.grouped_conditions);
  return {
    id: row.id,
    name: row.name,
    groupedConditions: grouped,
    targetTaxonomyNodeId: row.target_taxonomy_node_id,
    priorityScore: row.priority,
    isActive: row.is_active,
    source: (row.source ?? 'manual') as RuleSource,
    createdAt: row.created_at,
  };
}

// ─── Helper types for rule generation ────────────────────────────────────────

interface EligibleTxnRow {
  id: string;
  supplier_name: string;
  taxonomy_node_id: string;
  full_path: string;
  [key: string]: unknown;
}

interface CategoryGroup {
  taxonomyNodeId: string;
  fullPath: string;
  txns: EligibleTxnRow[];
  totalSpend: number;
}

// ─── Rule generation helpers (exported for testing) ──────────────────────────

export function generateSingleCategoryRule(
  supplierName: string,
  taxonomyNodeId: string,
): OverrideRuleCreate {
  return {
    name: supplierName,
    groupedConditions: {
      groupConnector: 'AND',
      groups: [{
        connector: 'AND',
        conditions: [{ field: 'supplier_name', operator: 'equals', value: supplierName }],
      }],
    },
    targetTaxonomyNodeId: taxonomyNodeId,
    source: 'auto_generated',
  };
}

export function generateMultiCategoryRules(
  supplierName: string,
  categories: CategoryGroup[],
  columnPriorities: string[],
): OverrideRuleCreate[] {
  // Sort by total spend desc — highest spend is the fallback
  const sorted = [...categories].sort((a, b) => b.totalSpend - a.totalSpend);
  const fallback = sorted[0];
  const others = sorted.slice(1);

  const rules: OverrideRuleCreate[] = [];

  for (const cat of others) {
    const detected = detectDistinguishingField(cat.txns, fallback.txns, columnPriorities);
    if (!detected) continue; // skip — no distinguishing field, fallback catches these

    rules.push({
      name: `${supplierName} | ${detected.field}=${detected.value}`,
      groupedConditions: {
        groupConnector: 'AND',
        groups: [{
          connector: 'AND',
          conditions: [
            { field: 'supplier_name', operator: 'equals', value: supplierName },
            { field: detected.field, operator: 'equals', value: detected.value },
          ],
        }],
      },
      targetTaxonomyNodeId: cat.taxonomyNodeId,
      source: 'auto_generated',
    });
  }

  // Fallback rule (supplier-only) — added last so it gets higher priority number
  rules.push({
    name: supplierName,
    groupedConditions: {
      groupConnector: 'AND',
      groups: [{
        connector: 'AND',
        conditions: [{ field: 'supplier_name', operator: 'equals', value: supplierName }],
      }],
    },
    targetTaxonomyNodeId: fallback.taxonomyNodeId,
    source: 'auto_generated',
  });

  return rules;
}

function detectDistinguishingField(
  categoryTxns: EligibleTxnRow[],
  fallbackTxns: EligibleTxnRow[],
  columnPriorities: string[],
): { field: string; value: string } | null {
  for (const col of columnPriorities) {
    const catMode = getMostCommonValue(categoryTxns, col);
    if (!catMode) continue;

    const fallbackMode = getMostCommonValue(fallbackTxns, col);
    if (catMode !== fallbackMode) {
      return { field: col, value: catMode };
    }
  }
  return null;
}

function getMostCommonValue(rows: EligibleTxnRow[], field: string): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const val = row[field];
    if (val == null || String(val).trim() === '') continue;
    const str = String(val);
    counts.set(str, (counts.get(str) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = '';
  let bestCount = 0;
  for (const [val, count] of counts) {
    if (count > bestCount) { best = val; bestCount = count; }
  }
  return best;
}

// ─── RuleStore class ─────────────────────────────────────────────────────────

export class RuleStore implements IRuleStore {
  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private project: IProjectStore,
  ) {}

  async listRules(): Promise<OverrideRule[]> {
    const rows = await this.db.all<RuleRow>(
      'SELECT * FROM override_rules ORDER BY priority ASC, created_at DESC'
    );
    return rows.map(rowToRule);
  }

  async createRule(input: OverrideRuleCreate): Promise<{ id: string }> {
    const id = uuidv4();
    let priority: number;

    if (input.priorityScore !== undefined) {
      priority = Math.round(input.priorityScore);
    } else {
      const result = await this.db.get<{ max_priority: number | null }>(
        'SELECT MAX(priority) as max_priority FROM override_rules'
      );
      priority = (result?.max_priority ?? 0) + 1;
    }

    const source = input.source ?? 'manual';

    await this.db.run(
      `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, priority, is_active, source, created_at)
       VALUES (?, ?, ?, ?, ?, TRUE, ?, CURRENT_TIMESTAMP)`,
      id, input.name, JSON.stringify(input.groupedConditions),
      input.targetTaxonomyNodeId, priority, source
    );

    return { id };
  }

  async updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.groupedConditions !== undefined) { setClauses.push('grouped_conditions = ?'); params.push(JSON.stringify(updates.groupedConditions)); }
    if (updates.targetTaxonomyNodeId !== undefined) { setClauses.push('target_taxonomy_node_id = ?'); params.push(updates.targetTaxonomyNodeId); }
    if (updates.isActive !== undefined) { setClauses.push('is_active = ?'); params.push(updates.isActive); }

    if (updates.priorityScore !== undefined) {
      setClauses.push('priority = ?');
      params.push(Math.round(updates.priorityScore));
    }

    if (setClauses.length === 0) return;

    params.push(ruleId);
    await this.db.run(
      `UPDATE override_rules SET ${setClauses.join(', ')} WHERE id = ?`,
      ...params
    );
  }

  async deleteRule(ruleId: string): Promise<void> {
    await this.db.run('DELETE FROM override_rules WHERE id = ?', ruleId);
  }

  async evaluateRules(
    transactionIds?: string[]
  ): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>> {
    const rules = await this.listRules();
    const activeRules = rules.filter((r) => r.isActive);
    const matched = new Map<string, { ruleId: string; targetTaxonomyNodeId: string }>();

    for (const rule of activeRules) {
      const matchedIds = await this.transactions.getIdsByGroupedConditions(rule.groupedConditions, transactionIds);
      for (const id of matchedIds) {
        if (!matched.has(id)) {
          matched.set(id, { ruleId: rule.id, targetTaxonomyNodeId: rule.targetTaxonomyNodeId });
        }
      }
    }

    return matched;
  }

  async generate_rules_preview(): Promise<GenerateRulesResult> {
    // 1. Load column priorities
    const columnPriorities = await this.project.getSetting('column_priorities') as string[] | null;
    if (!columnPriorities || columnPriorities.length === 0) {
      throw new Error('Column priorities must be configured before generating rules.');
    }

    // 2. Check which columns actually exist on transactions table
    // supplier_name is virtual (resolved via JOIN to project_suppliers), so exclude it
    const VIRTUAL_COLS = new Set(['supplier_name']);
    const availableColumns = await this.transactions.getColumns();
    const validPriorities = columnPriorities.filter(col => availableColumns.includes(col) && !VIRTUAL_COLS.has(col));
    const hasSpendAmount = availableColumns.includes('spend_amount');

    // 3. Build query for eligible transactions
    const selectCols = [
      't.id',
      'ps.supplier_name',
      't.taxonomy_node_id',
      'tax.full_path',
      ...(hasSpendAmount ? ['CAST(t.spend_amount AS DOUBLE) as spend_amount'] : []),
      ...validPriorities.map(col => `TRY_CAST(t."${col}" AS VARCHAR) as "${col}"`),
    ];

    const sql = `
      SELECT ${selectCols.join(', ')}
      FROM transactions t
      JOIN project_suppliers ps ON t.project_supplier_id = ps.id
      JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
      WHERE t.human_reviewed = TRUE
        AND t.classification_status != 'classified_by_rule'
        AND t.taxonomy_node_id IS NOT NULL
    `;

    const rows = await this.db.all<EligibleTxnRow>(sql);
    if (rows.length === 0) {
      return { rulesCreated: 0, suppliersProcessed: 0 };
    }

    // 4. Group by supplier_name → then by taxonomy_node_id
    const supplierMap = new Map<string, EligibleTxnRow[]>();
    for (const row of rows) {
      const key = row.supplier_name;
      if (!supplierMap.has(key)) supplierMap.set(key, []);
      supplierMap.get(key)!.push(row);
    }

    // 5. Collect suppliers already covered by rules
    const existingRuleRows = await this.db.all<{ grouped_conditions: string }>(
      'SELECT grouped_conditions FROM override_rules'
    );
    const suppliersWithRules = new Set<string>();
    for (const row of existingRuleRows) {
      const grouped = parseGroupedConditions(row.grouped_conditions);
      for (const group of grouped.groups) {
        for (const cond of group.conditions) {
          if (cond.field === 'supplier_name') {
            suppliersWithRules.add(cond.value as string);
          }
        }
      }
    }

    // 6. Generate rules per supplier
    let rulesCreated = 0;
    let suppliersProcessed = 0;

    for (const [supplierName, txns] of supplierMap) {
      if (suppliersWithRules.has(supplierName)) continue; // already has rules — skip

      // Group by taxonomy_node_id
      const catMap = new Map<string, CategoryGroup>();
      for (const txn of txns) {
        const nodeId = txn.taxonomy_node_id;
        if (!catMap.has(nodeId)) {
          catMap.set(nodeId, {
            taxonomyNodeId: nodeId,
            fullPath: txn.full_path,
            txns: [],
            totalSpend: 0,
          });
        }
        const group = catMap.get(nodeId)!;
        group.txns.push(txn);
        group.totalSpend += hasSpendAmount ? Number(txn.spend_amount ?? 0) : 1;
      }

      const categories = Array.from(catMap.values());
      let drafts: OverrideRuleCreate[];

      if (categories.length === 1) {
        drafts = [generateSingleCategoryRule(supplierName, categories[0].taxonomyNodeId)];
      } else {
        drafts = generateMultiCategoryRules(supplierName, categories, validPriorities);
      }

      for (const draft of drafts) {
        await this.createRule(draft);
        rulesCreated++;
      }

      suppliersProcessed++;
    }

    return { rulesCreated, suppliersProcessed };
  }

}

