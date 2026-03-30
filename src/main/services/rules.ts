import { v4 as uuidv4 } from 'uuid';
import type { Database, RuleStore as IRuleStore, TransactionStore as ITransactionStore, ProjectStore as IProjectStore } from '../../shared/types/services';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate, GenerateRulesResult, RuleSource, RuleGroup, RuleGroupCreate, RuleGroupUpdate } from '../../shared/types/rules';
import type { GroupedFilter } from '../../shared/types/transactions';
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';

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

// ─── RuleStore class ─────────────────────────────────────────────────────────

export class RuleStore implements IRuleStore {
  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private project: IProjectStore,
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
    const id = uuidv4();
    const groupId = input.groupId ?? null;
    const source = input.source ?? 'manual';
    const categoryASupplier = input.categoryASupplier ?? false;

    await this.db.run(
      `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, group_id, is_active, source, category_a_supplier, created_at)
       VALUES (?, ?, ?, ?, CAST(? AS VARCHAR), TRUE, ?, ?, CURRENT_TIMESTAMP)`,
      id, input.name, JSON.stringify(input.groupedConditions ?? { groupConnector: 'AND', groups: [] }),
      input.targetTaxonomyNodeId, groupId, source, categoryASupplier
    );

    return { id };
  }

  async createAndApplyRule(input: OverrideRuleCreate): Promise<{ id: string; matchedCount: number }> {
    const { id } = await this.createRule(input);
    const matchedCount = await this.transactions.applyRule(id, input.groupedConditions, input.targetTaxonomyNodeId);
    return { id, matchedCount };
  }

  async updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.groupedConditions !== undefined) { setClauses.push('grouped_conditions = ?'); params.push(JSON.stringify(updates.groupedConditions)); }
    if (updates.targetTaxonomyNodeId !== undefined) { setClauses.push('target_taxonomy_node_id = ?'); params.push(updates.targetTaxonomyNodeId); }
    if (updates.isActive !== undefined) { setClauses.push('is_active = ?'); params.push(updates.isActive); }
    if ('groupId' in updates) { setClauses.push('group_id = ?'); params.push(updates.groupId ?? null); }
    if (updates.categoryASupplier !== undefined) { setClauses.push('category_a_supplier = ?'); params.push(updates.categoryASupplier); }

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

  private async listAllRules(): Promise<OverrideRule[]> {
    // Returns ALL rules (grouped + ungrouped) ordered by group priority DESC, then created_at DESC.
    const rows = await this.db.all<RuleRow>(`
      SELECT r.*, rg.priority AS group_priority
      FROM override_rules r
      LEFT JOIN rule_groups rg ON r.group_id = rg.id
      ORDER BY COALESCE(rg.priority, 0) DESC, r.created_at DESC
    `);
    return rows.map(rowToRule);
  }

  async evaluateRules(
    transactionIds?: string[],
    ruleIds?: string[]
  ): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>> {
    // listAllRules() returns rules ordered by COALESCE(group.priority, 0) DESC, created_at DESC.
    // First-match-wins: once a transaction is matched by a rule, later rules don't overwrite it.
    // This naturally implements group-priority-based evaluation with ungrouped rules last.
    const rules = await this.listAllRules();
    let activeRules = rules.filter((r) => r.isActive);

    if (ruleIds !== undefined) {
      if (ruleIds.length === 0) return new Map();
      const idSet = new Set(ruleIds);
      activeRules = activeRules.filter((r) => idSet.has(r.id));
    }

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

  async previewRules(ruleIds: string[]): Promise<{ affectedRowCount: number; matchingRuleCount: number }> {
    const matched = await this.evaluateRules(undefined, ruleIds);
    const matchingRuleCount = new Set([...matched.values()].map((v) => v.ruleId)).size;
    return { affectedRowCount: matched.size, matchingRuleCount };
  }

  async applyRules(ruleIds: string[]): Promise<{ matchedCount: number; ruleCount: number }> {
    const matched = await this.evaluateRules(undefined, ruleIds);
    if (matched.size === 0) return { matchedCount: 0, ruleCount: 0 };

    // Group by (ruleId, targetTaxonomyNodeId) to batch updateTransactions calls.
    const batches = new Map<string, { ruleId: string; targetTaxonomyNodeId: string; ids: string[] }>();
    for (const [txId, { ruleId, targetTaxonomyNodeId }] of matched) {
      const key = `${ruleId}::${targetTaxonomyNodeId}`;
      if (!batches.has(key)) {
        batches.set(key, { ruleId, targetTaxonomyNodeId, ids: [] });
      }
      batches.get(key)!.ids.push(txId);
    }

    for (const { ruleId, targetTaxonomyNodeId, ids } of batches.values()) {
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
    // Exclude virtual columns — they're resolved via JOINs and have no physical presence
    // on transaction rows, so referencing them as t."col" in SQL would silently return NULL.
    const availableColumns = await this.transactions.getColumns();
    const validPriorities = columnPriorities.filter(col => availableColumns.includes(col) && !VIRTUAL_COLUMN_NAMES.has(col));
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

    // 6. Generate rules per supplier (auto-generated rules are ungrouped: group_id = null)
    let rulesCreated = 0;
    let suppliersProcessed = 0;

    for (const [supplierName, txns] of supplierMap) {
      if (suppliersWithRules.has(supplierName)) continue;

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
        await this.createRule(draft); // groupId defaults to null — ungrouped
        rulesCreated++;
      }

      suppliersProcessed++;
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

  async filterAndAssignToGroup(filter: GroupedFilter, targetGroupId: string | null): Promise<{ matched: number }> {
    // Load ALL rules, match server-side, then assign
    const allRules = await this.listAllRules();
    const groupRows = await this.db.all<GroupRow>('SELECT id, name, priority FROM rule_groups');
    const groupNameById = new Map<string, string>(groupRows.map(g => [g.id, g.name]));
    const matchingIds: string[] = [];

    for (const rule of allRules) {
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
const RULE_PROPERTY_FIELDS = new Set(['rule_name', 'rule_source', 'rule_is_active', 'rule_group']);

function matchRulePropertyCondition(
  propValue: string | boolean | null,
  operator: string,
  filterValue: unknown,
  field: string,
): boolean {
  // Boolean field (rule_is_active)
  if (field === 'rule_is_active') {
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
        case 'rule_is_active': propValue = rule.isActive; break;
        case 'rule_group':     propValue = rule.groupId ? (groupNameById.get(rule.groupId) ?? null) : null; break;
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
