import { v4 as uuidv4 } from 'uuid';
import type { Database, RuleStore as IRuleStore, TransactionStore as ITransactionStore, ProjectStore as IProjectStore, SupplierService as ISupplierService } from '../../shared/types/services';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate, GenerateRulesResult, RuleSource, RuleGroup, RuleGroupCreate, RuleGroupUpdate, ConflictRow, ConditionRow } from '../../shared/types/rules';
import type { GroupedFilter } from '../../shared/types/transactions';
import { VIRTUAL_COLUMN_NAMES, VIRTUAL_COLUMN_REGISTRY } from '../../shared/virtual-columns';

interface RuleRow {
  id: string;
  name: string;
  grouped_conditions: string;
  target_taxonomy_node_id: string;
  group_id: string | null;
  group_priority: number | null;
  is_active: boolean;
  source: string;
  category_a_supplier: boolean;
  created_at: string;
}

interface GroupRow {
  id: string;
  name: string;
  priority: number;
  created_at: string;
  rule_count?: number;
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
  return {
    id: row.id,
    name: row.name,
    groupedConditions: parseGroupedConditions(row.grouped_conditions),
    targetTaxonomyNodeId: row.target_taxonomy_node_id,
    groupId: row.group_id ?? null,
    isActive: row.is_active,
    source: (row.source ?? 'manual') as RuleSource,
    categoryASupplier: Boolean(row.category_a_supplier),
    createdAt: row.created_at,
  };
}

function rowToGroup(row: GroupRow): RuleGroup {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    createdAt: row.created_at,
    ruleCount: row.rule_count ?? 0,
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

function generateSingleCategoryRule(
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

function generateMultiCategoryRules(
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

  // Fallback rule (supplier-only) — added last
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

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Split an array into chunks of at most `size` elements. */
function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Extract supplier_name from a rule's conditions — only when safe to scope.
 * Returns null when: multiple groups, OR group, or no supplier_name 'equals' condition.
 */
export function extractSupplierNameCondition(
  input: OverrideRule | OverrideRuleCreate
): string | null {
  const groups = input.groupedConditions?.groups ?? [];
  if (groups.length !== 1) return null;
  if (groups[0].connector === 'OR') return null;
  for (const cond of groups[0].conditions) {
    if (cond.field === 'supplier_name' && cond.operator === 'equals') {
      return String(cond.value);
    }
  }
  return null;
}

/**
 * Decompose a GroupedFilter into relational rows for the rule_conditions table.
 * Called at write time and once for backfill migration.
 */
export function decomposeConditions(
  ruleId: string,
  grouped: GroupedFilter
): ConditionRow[] {
  const rows: ConditionRow[] = [];
  for (let gi = 0; gi < grouped.groups.length; gi++) {
    const group = grouped.groups[gi];
    for (let ci = 0; ci < group.conditions.length; ci++) {
      const c = group.conditions[ci];
      rows.push({
        rule_id: ruleId,
        group_idx: gi,
        condition_idx: ci,
        field: c.field,
        operator: c.operator,
        value: c.value != null ? String(c.value) : null,
        group_connector: group.groupConnector ?? grouped.groupConnector ?? 'AND',
        condition_connector: c.connector ?? group.connector ?? 'AND',
      });
    }
  }
  return rows;
}

// ─── Bulk evaluation SQL builder ────────────────────────────────────────────

const OPERATOR_JOIN_TEMPLATES: Record<string, (col: string) => string> = {
  equals:                col => `${col} = rc.value`,
  not_equals:            col => `${col} != rc.value`,
  contains:              col => `${col} ILIKE '%' || rc.value || '%'`,
  not_contains:          col => `${col} NOT ILIKE '%' || rc.value || '%'`,
  starts_with:           col => `${col} ILIKE rc.value || '%'`,
  ends_with:             col => `${col} ILIKE '%' || rc.value`,
  regex:                 col => `regexp_matches(${col}, rc.value)`,
  greater_than:          col => `TRY_CAST(${col} AS DECIMAL) > TRY_CAST(rc.value AS DECIMAL)`,
  less_than:             col => `TRY_CAST(${col} AS DECIMAL) < TRY_CAST(rc.value AS DECIMAL)`,
  greater_than_or_equal: col => `TRY_CAST(${col} AS DECIMAL) >= TRY_CAST(rc.value AS DECIMAL)`,
  less_than_or_equal:    col => `TRY_CAST(${col} AS DECIMAL) <= TRY_CAST(rc.value AS DECIMAL)`,
  is_null:               col => `${col} IS NULL`,
  is_true:               col => `${col} = TRUE`,
  is_false:              col => `${col} = FALSE`,
};

/** Map virtual column fields to their SQL expressions for filter queries. */
const FILTER_VIRTUAL_EXPRS: Record<string, string> = Object.fromEntries(
  Object.entries(VIRTUAL_COLUMN_REGISTRY).map(([name, def]) => [name, def.selectExpr])
);

const SUPPLIER_JOIN = 'LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id';
const SUPPLIER_PARENT_JOIN = 'LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id';
const TAXONOMY_JOIN = 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id';
const RULES_JOIN = 'LEFT JOIN override_rules ar ON t.applied_rule_id = ar.id';

const NULLARY_OPS = new Set(['is_null', 'is_true', 'is_false']);
const NEGATION_OPS = new Set(['not_equals', 'not_contains']);

function resolveColumnExpr(field: string): string {
  return FILTER_VIRTUAL_EXPRS[field] ?? `t."${field}"`;
}

function getRequiredJoins(fields: string[]): string {
  const needed = new Set<string>();
  for (const field of fields) {
    const def = VIRTUAL_COLUMN_REGISTRY[field];
    if (def) needed.add(def.requiredJoin);
  }
  const parts: string[] = [SUPPLIER_JOIN];
  if (needed.has('supplier_parent')) parts.push(SUPPLIER_PARENT_JOIN);
  if (needed.has('taxonomy')) parts.push(TAXONOMY_JOIN);
  if (needed.has('rules')) parts.push(RULES_JOIN);
  return parts.join('\n    ');
}

function buildFieldOperatorCTEs(
  pairs: { field: string; operator: string }[]
): string[] {
  const ctes: string[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { field, operator } = pairs[i];
    const colExpr = resolveColumnExpr(field);
    const template = OPERATOR_JOIN_TEMPLATES[operator];
    if (!template) continue;
    const predicate = template(colExpr);
    const joins = getRequiredJoins([field]);
    const isNullary = NULLARY_OPS.has(operator);
    const isNegation = NEGATION_OPS.has(operator);

    if (isNegation) {
      // Negation operators use CROSS JOIN + filter — rare (<1% of rules)
      ctes.push(`fo_${i} AS (
    SELECT rc.rule_id, rc.group_idx, rc.condition_idx, t.id AS txn_id
    FROM rule_conditions rc
    CROSS JOIN transactions t
    ${joins}
    JOIN override_rules r ON rc.rule_id = r.id AND r.is_active = TRUE
    WHERE rc.field = '${field}' AND rc.operator = '${operator}'
      AND (${colExpr} IS NULL OR ${predicate})
  )`);
    } else if (isNullary) {
      ctes.push(`fo_${i} AS (
    SELECT rc.rule_id, rc.group_idx, rc.condition_idx, t.id AS txn_id
    FROM rule_conditions rc
    JOIN transactions t ON TRUE
    ${joins}
    JOIN override_rules r ON rc.rule_id = r.id AND r.is_active = TRUE
    WHERE rc.field = '${field}' AND rc.operator = '${operator}'
      AND ${predicate}
  )`);
    } else {
      // Use WHERE for the predicate (not ON) so that ${joins} aliases (e.g. ps)
      // are available — SQL requires referenced tables to be joined earlier.
      ctes.push(`fo_${i} AS (
    SELECT rc.rule_id, rc.group_idx, rc.condition_idx, t.id AS txn_id
    FROM rule_conditions rc
    JOIN transactions t ON TRUE
    ${joins}
    JOIN override_rules r ON rc.rule_id = r.id AND r.is_active = TRUE
    WHERE rc.field = '${field}' AND rc.operator = '${operator}'
      AND ${predicate}
  )`);
    }
  }
  return ctes;
}

// ─── RuleStore class ─────────────────────────────────────────────────────────

export class RuleStore implements IRuleStore {
  private previewCache = new Map<string, {
    matched: Map<string, { ruleId: string; targetTaxonomyNodeId: string }>;
    expiresAt: number;
  }>();

  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private project: IProjectStore,
    private suppliers: ISupplierService,
  ) {}

  async listRules(): Promise<OverrideRule[]> {
    // Returns only grouped rules — ungrouped rules are loaded separately
    // via listRulesPaginated for performance (supports 1M+ ungrouped rules).
    // Use the private listAllRules() when all rules are needed (e.g. evaluateRules).
    const rows = await this.db.all<RuleRow>(`
      SELECT r.*, rg.priority AS group_priority
      FROM override_rules r
      LEFT JOIN rule_groups rg ON r.group_id = rg.id
      WHERE r.group_id IS NOT NULL
      ORDER BY COALESCE(rg.priority, 0) DESC, r.created_at DESC
    `);
    return rows.map(rowToRule);
  }

  async listRulesPaginated(opts: { limit: number; offset: number; search?: string }): Promise<{ rules: OverrideRule[]; total: number }> {
    const { limit, offset, search } = opts;
    const whereClauses = ['r.group_id IS NULL'];
    const params: unknown[] = [];

    if (search?.trim()) {
      whereClauses.push(`(LOWER(r.name) LIKE ? OR LOWER(CAST(r.grouped_conditions AS VARCHAR)) LIKE ?)`);
      const q = `%${search.trim().toLowerCase()}%`;
      params.push(q, q);
    }

    const where = whereClauses.join(' AND ');

    const countRows = await this.db.all<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM override_rules r WHERE ${where}`, ...params);
    const total = Number(countRows[0]?.cnt ?? 0);

    const rows = await this.db.all<RuleRow>(
      `SELECT r.*, NULL AS group_priority FROM override_rules r WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    return { rules: rows.map(rowToRule), total };
  }

  async getRule(id: string): Promise<OverrideRule | null> {
    const row = await this.db.get<RuleRow>(
      'SELECT r.*, NULL AS group_priority FROM override_rules r WHERE r.id = ?',
      id
    );
    return row ? rowToRule(row) : null;
  }

  async createRule(input: OverrideRuleCreate): Promise<{ id: string }> {
    // Validate FK targets
    if (input.targetTaxonomyNodeId) {
      const node = await this.db.get<{ id: string }>('SELECT id FROM taxonomy WHERE id = ?', input.targetTaxonomyNodeId);
      if (!node) throw new Error(`Taxonomy node not found: ${input.targetTaxonomyNodeId}`);
    }
    if (input.groupId) {
      const grp = await this.db.get<{ id: string }>('SELECT id FROM rule_groups WHERE id = ?', input.groupId);
      if (!grp) throw new Error(`Rule group not found: ${input.groupId}`);
    }

    const id = uuidv4();
    const groupId = input.groupId ?? null;
    const source = input.source ?? 'manual';
    const categoryASupplier = input.categoryASupplier ?? false;
    const groupedConditions = input.groupedConditions ?? { groupConnector: 'AND', groups: [] };

    // Resolve project_supplier_id from conditions
    const supplierName = extractSupplierNameCondition(input);
    const supplierId = supplierName
      ? (await this.suppliers.getProjectSupplierByName(supplierName))?.id ?? null
      : null;

    // Single transaction: rule + conditions
    await this.db.exec('BEGIN TRANSACTION');
    try {
      await this.db.run(
        `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, group_id, is_active, source, category_a_supplier, project_supplier_id, created_at)
         VALUES (?, ?, ?, ?, CAST(? AS VARCHAR), TRUE, ?, ?, ?, CURRENT_TIMESTAMP)`,
        id, input.name, JSON.stringify(groupedConditions),
        input.targetTaxonomyNodeId, groupId, source, categoryASupplier, supplierId
      );

      // Decompose and insert conditions
      const condRows = decomposeConditions(id, groupedConditions);
      for (const chunk of chunks(condRows, 500)) {
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params = chunk.flatMap(r => [
          r.rule_id, r.group_idx, r.condition_idx,
          r.field, r.operator, r.value,
          r.group_connector, r.condition_connector
        ]);
        await this.db.run(
          `INSERT INTO rule_conditions VALUES ${placeholders}`, ...params
        );
      }

      await this.db.exec('COMMIT');
    } catch (e) {
      await this.db.exec('ROLLBACK');
      throw e;
    }

    return { id };
  }

  async previewRuleConflicts(
    candidateIds: string[],
    newRuleGroupId?: string | null,
  ): Promise<{ covered: ConflictRow[]; eligibleIds: string[] }> {
    // Evaluate only rules that could block (higher priority than new rule)
    const ruleMap = await this.evaluateRulesBulk({ scopeIds: candidateIds });

    // Look up group priorities to compare
    const groupRows = await this.db.all<{ id: string; priority: number }>('SELECT id, priority FROM rule_groups');
    const groupPriorityById = new Map(groupRows.map(g => [g.id, g.priority]));
    const newRulePriority = newRuleGroupId ? (groupPriorityById.get(newRuleGroupId) ?? 0) : 0;

    // Build rule name + group maps (only for matched rules, not all 500K)
    const matchedRuleIds = new Set([...ruleMap.values()].map(v => v.ruleId));
    const ruleNameById = new Map<string, string>();
    const ruleGroupIdById = new Map<string, string | null>();
    if (matchedRuleIds.size > 0) {
      const placeholders = [...matchedRuleIds].map(() => '?').join(', ');
      const rows = await this.db.all<{ id: string; name: string; group_id: string | null }>(
        `SELECT id, name, group_id FROM override_rules WHERE id IN (${placeholders})`,
        ...matchedRuleIds
      );
      for (const row of rows) {
        ruleNameById.set(row.id, row.name);
        ruleGroupIdById.set(row.id, row.group_id);
      }
    }

    const covered: ConflictRow[] = [];
    const eligibleIds: string[] = [];

    for (const candidateId of candidateIds) {
      const match = ruleMap.get(candidateId);
      if (!match) {
        eligibleIds.push(candidateId);
        continue;
      }
      const existingGroupId = ruleGroupIdById.get(match.ruleId) ?? null;
      const existingPriority = existingGroupId ? (groupPriorityById.get(existingGroupId) ?? 0) : 0;

      if (existingPriority > newRulePriority) {
        covered.push({
          transactionId: candidateId,
          existingRuleId: match.ruleId,
          existingRuleName: ruleNameById.get(match.ruleId) ?? match.ruleId,
        });
      } else {
        eligibleIds.push(candidateId);
      }
    }

    return { covered, eligibleIds };
  }

  async createAndApplyRule(input: OverrideRuleCreate): Promise<{ id: string; matchedCount: number; skippedCount: number; changelogId?: string }> {
    // Get all transactions matching the new rule's conditions
    const allMatchingIds = await this.transactions.getIdsByGroupedConditions(
      input.groupedConditions ?? { groupConnector: 'AND', groups: [] }
    );

    // Check which are already covered by higher-priority existing rules (before creating the new rule)
    const { eligibleIds } = await this.previewRuleConflicts(allMatchingIds, input.groupId ?? null);

    // Create the rule
    const { id } = await this.createRule(input);

    // Apply only to eligible transactions
    let changelogId: string | undefined;
    if (eligibleIds.length > 0) {
      changelogId = await this.transactions.updateTransactions(
        { ids: eligibleIds, taxonomyNodeId: input.targetTaxonomyNodeId, classificationStatus: 'classified_by_rule', appliedRuleId: id },
        'rule'
      ) ?? undefined;
    }

    return {
      id,
      matchedCount: eligibleIds.length,
      skippedCount: allMatchingIds.length - eligibleIds.length,
      changelogId,
    };
  }

  async updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.groupedConditions !== undefined) {
      setClauses.push('grouped_conditions = ?');
      params.push(JSON.stringify(updates.groupedConditions));
      // Also update project_supplier_id if conditions changed
      const supplierName = extractSupplierNameCondition({ name: '', groupedConditions: updates.groupedConditions, targetTaxonomyNodeId: '' });
      const supplierId = supplierName
        ? (await this.suppliers.getProjectSupplierByName(supplierName))?.id ?? null
        : null;
      setClauses.push('project_supplier_id = ?');
      params.push(supplierId);
    }
    if (updates.targetTaxonomyNodeId !== undefined) { setClauses.push('target_taxonomy_node_id = ?'); params.push(updates.targetTaxonomyNodeId); }
    if (updates.isActive !== undefined) { setClauses.push('is_active = ?'); params.push(updates.isActive); }
    if ('groupId' in updates) { setClauses.push('group_id = ?'); params.push(updates.groupId ?? null); }
    if (updates.categoryASupplier !== undefined) { setClauses.push('category_a_supplier = ?'); params.push(updates.categoryASupplier); }

    if (setClauses.length === 0) return;

    // If conditions changed, sync rule_conditions in same transaction
    if (updates.groupedConditions !== undefined) {
      await this.db.exec('BEGIN TRANSACTION');
      try {
        params.push(ruleId);
        await this.db.run(
          `UPDATE override_rules SET ${setClauses.join(', ')} WHERE id = ?`,
          ...params
        );
        // Delete old + insert new conditions
        await this.db.run('DELETE FROM rule_conditions WHERE rule_id = ?', ruleId);
        const condRows = decomposeConditions(ruleId, updates.groupedConditions);
        for (const chunk of chunks(condRows, 500)) {
          const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
          const chunkParams = chunk.flatMap(r => [
            r.rule_id, r.group_idx, r.condition_idx,
            r.field, r.operator, r.value,
            r.group_connector, r.condition_connector
          ]);
          await this.db.run(
            `INSERT INTO rule_conditions VALUES ${placeholders}`, ...chunkParams
          );
        }
        await this.db.exec('COMMIT');
      } catch (e) {
        await this.db.exec('ROLLBACK');
        throw e;
      }
    } else {
      params.push(ruleId);
      await this.db.run(
        `UPDATE override_rules SET ${setClauses.join(', ')} WHERE id = ?`,
        ...params
      );
    }
  }

  async deleteRule(ruleId: string): Promise<void> {
    await this.db.run('DELETE FROM rule_conditions WHERE rule_id = ?', ruleId);
    await this.db.run('DELETE FROM override_rules WHERE id = ?', ruleId);
  }

  async listRulesByGroup(groupId: string, limit: number, offset: number): Promise<{ rules: OverrideRule[]; total: number }> {
    const countRows = await this.db.all<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM override_rules WHERE group_id = ?', groupId
    );
    const total = Number(countRows[0]?.cnt ?? 0);

    const rows = await this.db.all<RuleRow>(
      `SELECT r.*, rg.priority AS group_priority FROM override_rules r
       LEFT JOIN rule_groups rg ON r.group_id = rg.id
       WHERE r.group_id = ?
       ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      groupId, limit, offset
    );
    return { rules: rows.map(rowToRule), total };
  }

  async setCategoryA(ruleId: string, value: boolean): Promise<void> {
    await this.updateRule(ruleId, { categoryASupplier: value });
  }

  async reassignSupplierRules(losingIds: string[], survivorId: string): Promise<void> {
    if (losingIds.length === 0) return;
    const placeholders = losingIds.map(() => '?').join(', ');
    await this.db.run(
      `UPDATE override_rules SET project_supplier_id = ? WHERE project_supplier_id IN (${placeholders})`,
      survivorId, ...losingIds
    );
  }

  private async listAllRules(): Promise<OverrideRule[]> {
    const rows = await this.db.all<RuleRow>(`
      SELECT r.*, rg.priority AS group_priority
      FROM override_rules r
      LEFT JOIN rule_groups rg ON r.group_id = rg.id
      ORDER BY COALESCE(rg.priority, 0) DESC, r.created_at DESC
    `);
    return rows.map(rowToRule);
  }

  /**
   * Legacy N+1 evaluation — retained for backward compatibility.
   * Prefer evaluateRulesBulk() for new code paths.
   */
  async evaluateRules(
    transactionIds?: string[],
    ruleIds?: string[]
  ): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>> {
    return this.evaluateRulesBulk({
      scopeIds: transactionIds,
      ruleIds,
    });
  }

  /**
   * Bulk rule evaluation using SQL CTEs — replaces the N+1 per-rule loop.
   * One CTE per distinct (field, operator) pair, joined in a single pass.
   */
  async evaluateRulesBulk(
    opts: { scopeTable?: string; scopeIds?: string[]; ruleIds?: string[] } = {}
  ): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>> {
    // 1. Get distinct (field, operator) pairs from active rules
    let pairsQuery = `
      SELECT DISTINCT rc.field, rc.operator
      FROM rule_conditions rc
      JOIN override_rules r ON rc.rule_id = r.id
      WHERE r.is_active = TRUE
    `;
    const pairsParams: unknown[] = [];

    if (opts.ruleIds && opts.ruleIds.length > 0) {
      const placeholders = opts.ruleIds.map(() => '?').join(', ');
      pairsQuery += ` AND r.id IN (${placeholders})`;
      pairsParams.push(...opts.ruleIds);
    }

    const pairs = await this.db.all<{ field: string; operator: string }>(pairsQuery, ...pairsParams);
    if (pairs.length === 0) return new Map();

    // 2. Generate equi-JOIN CTEs
    const ctes = buildFieldOperatorCTEs(pairs);
    if (ctes.length === 0) return new Map();

    // 3. Build scope constraint
    let scopeJoin = '';
    const scopeParams: unknown[] = [];
    if (opts.scopeTable) {
      scopeJoin = `JOIN ${opts.scopeTable} _scope ON t.id = _scope.id`;
    } else if (opts.scopeIds && opts.scopeIds.length > 0) {
      // Use a temp table approach for large ID sets to avoid parameter limits
      const runId = uuidv4().replace(/-/g, '').slice(0, 8);
      const tempName = `_scope_${runId}`;
      await this.db.run(`CREATE TEMP TABLE ${tempName} (id VARCHAR PRIMARY KEY)`);
      for (const chunk of chunks(opts.scopeIds, 10_000)) {
        const ph = chunk.map(() => '(?)').join(',');
        await this.db.run(`INSERT INTO ${tempName} VALUES ${ph}`, ...chunk);
      }
      scopeJoin = `JOIN ${tempName} _scope ON t.id = _scope.id`;
      // We'll clean up the temp table after the query
    }

    // 4. Build rule ID filter for CTEs
    let ruleFilter = '';
    if (opts.ruleIds && opts.ruleIds.length > 0) {
      ruleFilter = ` AND r.id IN (${opts.ruleIds.map(() => '?').join(', ')})`;
    }

    // 5. Inject scope join + rule filter into each CTE
    const scopedCtes = ctes.map(cte => {
      let result = cte;
      if (scopeJoin) {
        // Add scope JOIN after the transactions join clause (including its ON predicate if any)
        result = result.replace(
          /((?:CROSS JOIN|JOIN) transactions t(?:\s+ON\s+[^\n]+)?)/,
          `$1\n    ${scopeJoin}`
        );
      }
      if (ruleFilter) {
        result = result.replace(
          /AND r\.is_active = TRUE/,
          `AND r.is_active = TRUE${ruleFilter}`
        );
      }
      return result;
    });

    // 6. Build union of all CTEs
    const cteNames = scopedCtes.map((_, i) => `fo_${i}`);
    const unionAll = cteNames.map(n => `SELECT rule_id, group_idx, condition_idx, txn_id FROM ${n}`).join('\n    UNION ALL\n    ');

    // 7. Build full evaluation query
    const sql = `WITH
  ${scopedCtes.join(',\n  ')},

  condition_evals AS (
    ${unionAll}
  ),

  group_evals AS (
    SELECT
      ce.rule_id, ce.txn_id, ce.group_idx,
      rc_meta.group_connector,
      -- OR group matches if ANY condition matches; AND group requires ALL.
      -- rc_meta.has_or_within is derived from condition_connector, which
      -- decomposeConditions() writes per-condition at rule-creation time.
      CASE
        WHEN rc_meta.has_or_within THEN COUNT(*) >= 1
        ELSE COUNT(*) = MAX(rc_meta.total_conditions)
      END AS group_matched
    FROM condition_evals ce
    JOIN (
      SELECT rule_id, group_idx, group_connector,
             COUNT(*) AS total_conditions,
             BOOL_OR(condition_connector = 'OR') AS has_or_within
      FROM rule_conditions
      GROUP BY rule_id, group_idx, group_connector
    ) rc_meta ON ce.rule_id = rc_meta.rule_id
            AND ce.group_idx = rc_meta.group_idx
    GROUP BY ce.rule_id, ce.txn_id, ce.group_idx, rc_meta.group_connector,
             rc_meta.total_conditions, rc_meta.has_or_within
  ),

  rule_group_counts AS (
    -- Needed because group_evals only contains rows for (txn, group) pairs
    -- where at least one condition matched. An AND-rule must match EVERY
    -- group, so we count matched groups vs total groups in the rule rather
    -- than BOOL_AND over present rows (which silently ignores missing groups).
    SELECT rule_id, COUNT(DISTINCT group_idx) AS total_groups
    FROM rule_conditions GROUP BY rule_id
  ),

  rule_evals AS (
    SELECT ge.rule_id, ge.txn_id,
      COUNT(DISTINCT CASE WHEN ge.group_matched THEN ge.group_idx END) AS matched_groups,
      rgc.total_groups,
      BOOL_OR(ge.group_connector = 'OR') AS has_or_connector
    FROM group_evals ge
    JOIN rule_group_counts rgc ON ge.rule_id = rgc.rule_id
    GROUP BY ge.rule_id, ge.txn_id, rgc.total_groups
  ),

  rule_matches AS (
    SELECT rule_id, txn_id FROM rule_evals
    WHERE CASE WHEN has_or_connector THEN matched_groups >= 1
               ELSE matched_groups = total_groups END
  )

SELECT DISTINCT ON (rm.txn_id)
  rm.txn_id, rm.rule_id, r.target_taxonomy_node_id
FROM rule_matches rm
JOIN override_rules r ON rm.rule_id = r.id
LEFT JOIN rule_groups rg ON r.group_id = rg.id
ORDER BY rm.txn_id, COALESCE(rg.priority, 0) DESC, r.created_at DESC`;

    const allParams: unknown[] = [];
    // Add ruleIds params for each CTE that has the filter
    if (opts.ruleIds && opts.ruleIds.length > 0) {
      for (let i = 0; i < cteNames.length; i++) {
        allParams.push(...opts.ruleIds);
      }
    }

    try {
      const rows = await this.db.all<{ txn_id: string; rule_id: string; target_taxonomy_node_id: string }>(sql, ...allParams);
      const matched = new Map<string, { ruleId: string; targetTaxonomyNodeId: string }>();
      for (const row of rows) {
        matched.set(row.txn_id, { ruleId: row.rule_id, targetTaxonomyNodeId: row.target_taxonomy_node_id });
      }
      return matched;
    } finally {
      // Clean up temp scope table if we created one
      if (!opts.scopeTable && opts.scopeIds && opts.scopeIds.length > 0 && scopeJoin) {
        const tempName = scopeJoin.match(/JOIN (\S+)/)?.[1];
        if (tempName) {
          try { await this.db.run(`DROP TABLE IF EXISTS ${tempName}`); } catch { /* ignore */ }
        }
      }
    }
  }

  async previewRules(ruleIds: string[]): Promise<{ token: string; affectedRowCount: number; matchingRuleCount: number }> {
    const matched = await this.evaluateRulesBulk({ ruleIds });
    const token = uuidv4();
    this.previewCache.set(token, { matched, expiresAt: Date.now() + 5 * 60_000 });
    // Evict expired entries
    for (const [k, v] of this.previewCache) {
      if (v.expiresAt < Date.now()) this.previewCache.delete(k);
    }
    const matchingRuleCount = new Set([...matched.values()].map((v) => v.ruleId)).size;
    return { token, affectedRowCount: matched.size, matchingRuleCount };
  }

  async applyRules(ruleIds: string[], token?: string): Promise<{ matchedCount: number; ruleCount: number }> {
    const cached = token ? this.previewCache.get(token) : undefined;
    const matched = cached?.matched ?? await this.evaluateRulesBulk({ ruleIds });
    if (token) this.previewCache.delete(token);

    if (matched.size === 0) return { matchedCount: 0, ruleCount: 0 };

    // Batch by targetNodeId for fewer, larger UPDATEs
    const byNode = new Map<string, { ruleId: string; ids: string[] }>();
    for (const [txId, { ruleId, targetTaxonomyNodeId }] of matched) {
      const key = `${ruleId}::${targetTaxonomyNodeId}`;
      if (!byNode.has(key)) {
        byNode.set(key, { ruleId, ids: [] });
      }
      byNode.get(key)!.ids.push(txId);
    }

    for (const [key, { ruleId, ids }] of byNode) {
      const targetTaxonomyNodeId = key.split('::')[1];
      await this.transactions.updateTransactions(
        { ids, taxonomyNodeId: targetTaxonomyNodeId, classificationStatus: 'classified_by_rule', appliedRuleId: ruleId },
        'rule'
      );
    }

    const ruleCount = new Set([...matched.values()].map((v) => v.ruleId)).size;
    return { matchedCount: matched.size, ruleCount };
  }

  async generate_rules_preview(): Promise<GenerateRulesResult> {
    // 1. Load column priorities
    const columnPriorities = await this.project.getSetting('column_priorities') as string[] | null;
    if (!columnPriorities || columnPriorities.length === 0) {
      throw new Error('Column priorities must be configured before generating rules.');
    }

    // 2. Check which columns actually exist on transactions table.
    const availableColumns = await this.transactions.getColumns();
    const validPriorities = columnPriorities.filter(col => availableColumns.includes(col) && !VIRTUAL_COLUMN_NAMES.has(col));
    const hasSpendAmount = availableColumns.includes('spend_amount');

    // 3. Get distinct supplier names with eligible transactions (not all txns)
    const supplierNames = await this.db.all<{ supplier_name: string; project_supplier_id: string }>(
      `SELECT DISTINCT ps.supplier_name, ps.id AS project_supplier_id
       FROM transactions t
       JOIN project_suppliers ps ON t.project_supplier_id = ps.id
       WHERE t.human_reviewed = TRUE
         AND t.classification_status != 'classified_by_rule'
         AND t.taxonomy_node_id IS NOT NULL`
    );
    if (supplierNames.length === 0) {
      return { rulesCreated: 0, suppliersProcessed: 0 };
    }

    // 4. Get covered suppliers via SQL (not JS parse) — uses project_supplier_id FK
    const coveredRows = await this.db.all<{ project_supplier_id: string }>(
      `SELECT DISTINCT project_supplier_id FROM override_rules WHERE project_supplier_id IS NOT NULL`
    );
    const coveredSupplierIds = new Set(coveredRows.map(r => r.project_supplier_id));

    // 5. Generate rules per uncovered supplier
    let rulesCreated = 0;
    let suppliersProcessed = 0;
    const allDrafts: Array<{ draft: OverrideRuleCreate; supplierId: string | null }> = [];

    const selectCols = [
      't.id',
      'ps.supplier_name',
      't.taxonomy_node_id',
      'tax.full_path',
      ...(hasSpendAmount ? ['CAST(t.spend_amount AS DOUBLE) as spend_amount'] : []),
      ...validPriorities.map(col => `TRY_CAST(t."${col}" AS VARCHAR) as "${col}"`),
    ];

    for (const { supplier_name: supplierName, project_supplier_id: supplierId } of supplierNames) {
      if (coveredSupplierIds.has(supplierId)) continue;

      // Query only this supplier's eligible transactions
      const txns = await this.db.all<EligibleTxnRow>(
        `SELECT ${selectCols.join(', ')}
         FROM transactions t
         JOIN project_suppliers ps ON t.project_supplier_id = ps.id
         JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
         WHERE ps.id = ?
           AND t.human_reviewed = TRUE
           AND t.classification_status != 'classified_by_rule'
           AND t.taxonomy_node_id IS NOT NULL`,
        supplierId
      );
      if (txns.length === 0) continue;

      const catMap = new Map<string, CategoryGroup>();
      for (const txn of txns) {
        const nodeId = txn.taxonomy_node_id;
        if (!catMap.has(nodeId)) {
          catMap.set(nodeId, { taxonomyNodeId: nodeId, fullPath: txn.full_path, txns: [], totalSpend: 0 });
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
        allDrafts.push({ draft, supplierId });
      }
      suppliersProcessed++;
    }

    // 6. Batch INSERT all rules + conditions in a single transaction
    if (allDrafts.length > 0) {
      await this.db.exec('BEGIN TRANSACTION');
      try {
        for (const chunk of chunks(allDrafts, 200)) {
          const ruleValues = chunk.map(({ draft, supplierId }) => {
            const id = uuidv4();
            // Store id on draft for condition decomposition
            (draft as OverrideRuleCreate & { _id?: string })._id = id;
            return `('${id}', '${draft.name.replace(/'/g, "''")}', '${JSON.stringify(draft.groupedConditions).replace(/'/g, "''")}', '${draft.targetTaxonomyNodeId}', NULL, TRUE, '${draft.source ?? 'auto_generated'}', FALSE, ${supplierId ? `'${supplierId}'` : 'NULL'}, CURRENT_TIMESTAMP)`;
          }).join(', ');
          await this.db.exec(
            `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, group_id, is_active, source, category_a_supplier, project_supplier_id, created_at) VALUES ${ruleValues}`
          );

          // Insert conditions
          const allCondRows: ConditionRow[] = [];
          for (const { draft } of chunk) {
            const id = (draft as OverrideRuleCreate & { _id?: string })._id!;
            allCondRows.push(...decomposeConditions(id, draft.groupedConditions));
          }
          for (const condChunk of chunks(allCondRows, 500)) {
            const placeholders = condChunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const params = condChunk.flatMap(r => [
              r.rule_id, r.group_idx, r.condition_idx,
              r.field, r.operator, r.value,
              r.group_connector, r.condition_connector
            ]);
            await this.db.run(`INSERT INTO rule_conditions VALUES ${placeholders}`, ...params);
          }
        }
        await this.db.exec('COMMIT');
        rulesCreated = allDrafts.length;
      } catch (e) {
        await this.db.exec('ROLLBACK');
        throw e;
      }
    }

    return { rulesCreated, suppliersProcessed };
  }

  // ─── Group operations ────────────────────────────────────────────────────────

  async listGroups(): Promise<RuleGroup[]> {
    const rows = await this.db.all<GroupRow>(`
      SELECT rg.*, COUNT(r.id) AS rule_count
      FROM rule_groups rg
      LEFT JOIN override_rules r ON r.group_id = rg.id
      GROUP BY rg.id, rg.name, rg.priority, rg.created_at
      ORDER BY rg.priority DESC
    `);
    return rows.map(rowToGroup);
  }

  async createGroup(input: RuleGroupCreate): Promise<{ id: string }> {
    if (input.priority == null || input.priority < 1) {
      throw new Error('Group priority must be >= 1');
    }
    // Cascade: if requested priority is already taken, bump existing groups at that priority and above upward
    await this.cascadePriorities(input.priority);

    const id = uuidv4();
    await this.db.run(
      'INSERT INTO rule_groups (id, name, priority, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      id, input.name, input.priority
    );
    return { id };
  }

  private async cascadePriorities(targetPriority: number, excludeGroupId?: string): Promise<void> {
    // Find all groups at or above the target priority, ordered by priority ASC
    const condition = excludeGroupId
      ? 'WHERE priority >= ? AND id != ?'
      : 'WHERE priority >= ?';
    const params = excludeGroupId
      ? [targetPriority, excludeGroupId]
      : [targetPriority];
    const conflicts = await this.db.all<{ id: string; priority: number }>(
      `SELECT id, priority FROM rule_groups ${condition} ORDER BY priority ASC`, ...params
    );
    if (conflicts.length === 0) return;
    // Only cascade if the exact target priority is occupied
    if (conflicts[0].priority !== targetPriority) return;
    // Bump each consecutive group up by 1 (work top-down to avoid unique constraint violations)
    let nextExpected = targetPriority;
    const toBump: { id: string; newPriority: number }[] = [];
    for (const g of conflicts) {
      if (g.priority !== nextExpected) break; // gap found, no more cascading needed
      toBump.push({ id: g.id, newPriority: g.priority + 1 });
      nextExpected = g.priority + 1;
    }
    // Apply in reverse order (highest first) to avoid unique constraint violations
    for (let i = toBump.length - 1; i >= 0; i--) {
      await this.db.run('UPDATE rule_groups SET priority = ? WHERE id = ?', toBump[i].newPriority, toBump[i].id);
    }
  }

  async updateGroup(groupId: string, updates: RuleGroupUpdate): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.priority !== undefined) {
      if (updates.priority < 1) throw new Error('Group priority must be >= 1');
      // Cascade: bump existing groups at the target priority upward
      await this.cascadePriorities(updates.priority, groupId);
      setClauses.push('priority = ?');
      params.push(updates.priority);
    }

    if (setClauses.length === 0) return;

    params.push(groupId);
    await this.db.run(
      `UPDATE rule_groups SET ${setClauses.join(', ')} WHERE id = ?`,
      ...params
    );
  }

  async deleteGroup(groupId: string): Promise<void> {
    // Ungroup all rules in this group (set group_id = NULL) before deleting
    await this.db.run('UPDATE override_rules SET group_id = NULL WHERE group_id = ?', groupId);
    await this.db.run('DELETE FROM rule_groups WHERE id = ?', groupId);
  }

  async reorderGroups(orderedIds: string[]): Promise<void> {
    // Drop unique index so sequential UPDATEs don't hit transient conflicts.
    // Wrap updates in BEGIN/COMMIT so a mid-loop failure rolls back to the
    // original priorities — ensuring CREATE UNIQUE INDEX in finally always
    // lands on clean, non-duplicate data.
    await this.db.exec('DROP INDEX IF EXISTS idx_rule_groups_priority');
    try {
      await this.db.exec('BEGIN');
      try {
        const total = orderedIds.length;
        for (let i = 0; i < total; i++) {
          await this.db.run(
            'UPDATE rule_groups SET priority = ? WHERE id = ?',
            total - i, orderedIds[i]
          );
        }
        await this.db.exec('COMMIT');
      } catch (err) {
        await this.db.exec('ROLLBACK');
        throw err;
      }
    } finally {
      await this.db.exec('CREATE UNIQUE INDEX idx_rule_groups_priority ON rule_groups(priority)');
    }
  }

  async moveRuleToGroup(ruleId: string, targetGroupId: string | null): Promise<void> {
    await this.db.run(
      'UPDATE override_rules SET group_id = CAST(? AS VARCHAR) WHERE id = ?',
      targetGroupId, ruleId
    );
  }

  async assignToGroup(ruleIds: string[], groupId: string | null): Promise<void> {
    if (ruleIds.length === 0) return;
    const placeholders = ruleIds.map(() => '?').join(', ');
    await this.db.run(
      `UPDATE override_rules SET group_id = CAST(? AS VARCHAR) WHERE id IN (${placeholders})`,
      groupId, ...ruleIds
    );
  }

  async getCatARuleForSupplier(supplierName: string): Promise<OverrideRule | null> {
    // Use project_supplier_id FK for indexed lookup instead of parsing all Cat A rules' JSON
    const supplier = await this.suppliers.getProjectSupplierByName(supplierName);
    if (!supplier) return null;

    const row = await this.db.get<RuleRow>(
      `SELECT r.*, NULL AS group_priority FROM override_rules r
       WHERE r.category_a_supplier = TRUE AND r.project_supplier_id = ?
       LIMIT 1`,
      supplier.id
    );
    return row ? rowToRule(row) : null;
  }

  async filterAndAssignToGroup(filter: GroupedFilter, targetGroupId: string | null): Promise<{ matched: number }> {
    // Analyze filter: can we push it entirely to SQL?
    const { propertyClauses, hasContentFilters } = analyzeFilterConditions(filter);

    if (!hasContentFilters && propertyClauses.length > 0) {
      // Fast path: pure SQL update — no JS loading needed
      const sqlWhere = propertyClauses.join(' AND ');
      const countResult = await this.db.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM override_rules WHERE ${sqlWhere}`
      );
      await this.db.run(
        `UPDATE override_rules SET group_id = CAST(? AS VARCHAR) WHERE ${sqlWhere}`,
        targetGroupId
      );
      return { matched: countResult?.cnt ?? 0 };
    }

    // Slow path: pre-filter with SQL, then in-memory match for content filters
    const sqlWhere = propertyClauses.length ? propertyClauses.join(' AND ') : '1=1';
    const preFiltered = await this.db.all<RuleRow>(
      `SELECT r.*, rg.priority AS group_priority FROM override_rules r
       LEFT JOIN rule_groups rg ON r.group_id = rg.id
       WHERE ${sqlWhere}
       ORDER BY COALESCE(rg.priority, 0) DESC, r.created_at DESC`
    );
    const rules = preFiltered.map(rowToRule);

    const groupRows = await this.db.all<GroupRow>('SELECT id, name, priority FROM rule_groups');
    const groupNameById = new Map<string, string>(groupRows.map(g => [g.id, g.name]));
    const matchingIds: string[] = [];

    for (const rule of rules) {
      if (matchesRuleFilter(rule, filter, groupNameById)) {
        matchingIds.push(rule.id);
      }
    }

    if (matchingIds.length === 0) {
      return { matched: 0 };
    }

    await this.assignToGroup(matchingIds, targetGroupId);
    return { matched: matchingIds.length };
  }
}

// ─── Server-side rule filter matching ─────────────────────────────────────────

/** Rule property field names — dispatched to property matching instead of condition extraction */
const RULE_PROPERTY_FIELDS = new Set(['rule_name', 'rule_source', 'rule_is_active', 'rule_group', 'rule_category_a']);

function matchRulePropertyCondition(
  propValue: string | boolean | null,
  operator: string,
  filterValue: unknown,
  field: string,
): boolean {
  // Boolean fields (rule_is_active, rule_category_a)
  if (field === 'rule_is_active' || field === 'rule_category_a') {
    if (operator === 'is_true')  return propValue === true;
    if (operator === 'is_false') return propValue === false;
    return false;
  }

  // Group field — null means Ungrouped
  if (field === 'rule_group') {
    const effective = propValue === null ? 'ungrouped' : String(propValue).toLowerCase();
    const fv = String(filterValue ?? '').toLowerCase();
    if (operator === 'is_null')    return propValue === null;
    if (operator === 'equals')     return effective === fv;
    if (operator === 'not_equals') return effective !== fv;
    if (operator === 'in_list') {
      const listVals = Array.isArray(filterValue)
        ? filterValue.map(v => String(v).toLowerCase())
        : fv.split(',').map(v => v.trim());
      return listVals.includes(effective);
    }
    return false;
  }

  // String fields (rule_name, rule_source)
  if (propValue === null) {
    return operator === 'is_null' || operator === 'not_equals' || operator === 'not_contains';
  }
  const rv = String(propValue).toLowerCase();
  const fv = String(filterValue ?? '').toLowerCase();
  switch (operator) {
    case 'equals':       return rv === fv;
    case 'not_equals':   return rv !== fv;
    case 'contains':     return rv.includes(fv);
    case 'not_contains': return !rv.includes(fv);
    case 'starts_with':  return rv.startsWith(fv);
    case 'ends_with':    return rv.endsWith(fv);
    case 'in_list': {
      const listVals = Array.isArray(filterValue)
        ? filterValue.map(v => String(v).toLowerCase())
        : fv.split(',').map(v => v.trim());
      return listVals.includes(rv);
    }
    default: return false;
  }
}

function matchesRuleFilter(
  rule: OverrideRule,
  filter: GroupedFilter,
  groupNameById: Map<string, string> = new Map(),
): boolean {
  if (!filter.groups.length) return false;

  // Extract all condition values from the rule's groupedConditions, keyed by field name
  const ruleConditionsByField = new Map<string, string[]>();
  for (const g of rule.groupedConditions?.groups ?? []) {
    for (const c of g.conditions) {
      if (!c.field) continue;
      const existing = ruleConditionsByField.get(c.field) ?? [];
      existing.push(String(c.value ?? '').toLowerCase());
      ruleConditionsByField.set(c.field, existing);
    }
  }

  const matchCondition = (field: string, operator: string, value: unknown): boolean => {
    // Dispatch: rule property fields use property matching
    if (RULE_PROPERTY_FIELDS.has(field)) {
      let propValue: string | boolean | null;
      switch (field) {
        case 'rule_name':      propValue = rule.name; break;
        case 'rule_source':    propValue = rule.source; break;
        case 'rule_is_active':   propValue = rule.isActive; break;
        case 'rule_category_a':  propValue = rule.categoryASupplier; break;
        case 'rule_group':       propValue = rule.groupId ? (groupNameById.get(rule.groupId) ?? null) : null; break;
        default:               propValue = null;
      }
      return matchRulePropertyCondition(propValue, operator, value, field);
    }

    // Transaction condition field matching (existing logic)
    const val = String(value ?? '').toLowerCase();
    const ruleValues = ruleConditionsByField.get(field);

    if (!ruleValues || ruleValues.length === 0) {
      return operator === 'not_contains' || operator === 'not_equals' || operator === 'is_null';
    }

    switch (operator) {
      case 'equals':
        return ruleValues.some(rv => rv === val);
      case 'not_equals':
        return ruleValues.every(rv => rv !== val);
      case 'contains':
        return ruleValues.some(rv => rv.includes(val));
      case 'not_contains':
        return ruleValues.every(rv => !rv.includes(val));
      case 'starts_with':
        return ruleValues.some(rv => rv.startsWith(val));
      case 'ends_with':
        return ruleValues.some(rv => rv.endsWith(val));
      case 'regex':
        try { const re = new RegExp(val, 'i'); return ruleValues.some(rv => re.test(rv)); }
        catch { return false; }
      case 'in_list': {
        const listVals = Array.isArray(value) ? value.map(v => String(v).toLowerCase()) : val.split(',').map(v => v.trim());
        return ruleValues.some(rv => listVals.includes(rv));
      }
      default:
        return false;
    }
  };

  // Evaluate each group's conditions
  const groupResults = filter.groups.map(g => {
    const conditions = g.conditions.filter(c => c.field && (c.value != null || ['is_null', 'is_true', 'is_false'].includes(c.operator)));
    if (conditions.length === 0) return true;
    let groupResult = matchCondition(conditions[0].field, conditions[0].operator, conditions[0].value);
    for (let i = 1; i < conditions.length; i++) {
      const connector = conditions[i - 1].connector || g.connector;
      const condResult = matchCondition(conditions[i].field, conditions[i].operator, conditions[i].value);
      if (connector === 'OR') groupResult = groupResult || condResult;
      else groupResult = groupResult && condResult;
    }
    return groupResult;
  });

  if (groupResults.length <= 1) return groupResults[0] ?? false;
  let result = groupResults[0];
  for (let i = 1; i < groupResults.length; i++) {
    const connector = filter.groups[i].groupConnector || filter.groupConnector;
    if (connector === 'OR') result = result || groupResults[i];
    else result = result && groupResults[i];
  }
  return result;
}

// ─── SQL fast path for filterAndAssignToGroup ────────────────────────────────

/** Mapping from rule property filter fields to SQL column expressions */
const RULE_PROPERTY_SQL: Record<string, string> = {
  rule_name: 'r.name',
  rule_source: 'r.source',
  rule_is_active: 'r.is_active',
  rule_category_a: 'r.category_a_supplier',
  rule_group: 'r.group_id',
};

/**
 * Analyze a GroupedFilter to separate property-based conditions (translatable to SQL)
 * from content-based conditions (require in-memory matching).
 */
function analyzeFilterConditions(filter: GroupedFilter): {
  propertyClauses: string[];
  hasContentFilters: boolean;
} {
  const propertyClauses: string[] = [];
  let hasContentFilters = false;

  for (const group of filter.groups) {
    for (const cond of group.conditions) {
      if (!cond.field) continue;
      const sqlCol = RULE_PROPERTY_SQL[cond.field];
      if (!sqlCol) {
        hasContentFilters = true;
        continue;
      }

      // Translate property condition to SQL
      const val = String(cond.value ?? '');
      switch (cond.field) {
        case 'rule_is_active':
          propertyClauses.push(`${sqlCol} = ${cond.operator === 'is_true'}`);
          break;
        case 'rule_category_a':
          propertyClauses.push(`${sqlCol} = ${cond.operator === 'is_true'}`);
          break;
        case 'rule_name':
          if (cond.operator === 'contains') propertyClauses.push(`LOWER(${sqlCol}) LIKE LOWER('%${val.replace(/'/g, "''")}%')`);
          else if (cond.operator === 'equals') propertyClauses.push(`LOWER(${sqlCol}) = LOWER('${val.replace(/'/g, "''")}')`);
          break;
        case 'rule_source':
          if (cond.operator === 'equals') propertyClauses.push(`${sqlCol} = '${val.replace(/'/g, "''")}'`);
          else if (cond.operator === 'in_list') {
            const vals = Array.isArray(cond.value) ? cond.value : val.split(',').map(v => v.trim());
            propertyClauses.push(`${sqlCol} IN (${vals.map(v => `'${String(v).replace(/'/g, "''")}'`).join(', ')})`);
          }
          break;
        case 'rule_group':
          if (cond.operator === 'is_null') propertyClauses.push(`${sqlCol} IS NULL`);
          else if (cond.operator === 'equals') propertyClauses.push(`${sqlCol} = '${val.replace(/'/g, "''")}'`);
          break;
        default:
          hasContentFilters = true;
      }
    }
  }

  return { propertyClauses, hasContentFilters };
}
