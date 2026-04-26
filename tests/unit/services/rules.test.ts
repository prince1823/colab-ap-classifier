import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleStore } from '../../../src/main/services/rules';
import { createMockDatabase, createMockTransactionStore, createMockProjectStore, createMockSupplierService } from '../../helpers/mock-services';
import type { Database, TransactionStore, ProjectStore, SupplierService } from '../../../src/shared/types/services';

// ─── Row factories ────────────────────────────────────────────────────────────

function makeRuleRow(overrides: Partial<{
  id: string; name: string; grouped_conditions: string;
  target_taxonomy_node_id: string; group_id: string | null;
  group_priority: number | null; is_active: boolean;
  source: string; category_a_supplier: boolean; created_at: string;
  project_supplier_id: string | null;
}> = {}) {
  return {
    id: 'r1',
    name: 'Rule 1',
    grouped_conditions: JSON.stringify({ groupConnector: 'AND', groups: [] }),
    target_taxonomy_node_id: 'tid1',
    group_id: null,
    group_priority: null,
    is_active: true,
    source: 'manual',
    category_a_supplier: false,
    created_at: '2026-01-01T00:00:00',
    project_supplier_id: null,
    ...overrides,
  };
}

function makeConditions(conditions: { field: string; operator: string; value: string }[]) {
  return JSON.stringify({
    groupConnector: 'AND',
    groups: [{ connector: 'AND', conditions }],
  });
}

function makeSupplierOnlyConditions(supplierName: string) {
  return makeConditions([{ field: 'supplier_name', operator: 'equals', value: supplierName }]);
}

function makeSupplierAndLineConditions(supplierName: string, lineDesc: string) {
  return makeConditions([
    { field: 'supplier_name', operator: 'equals', value: supplierName },
    { field: 'line_description', operator: 'equals', value: lineDesc },
  ]);
}

function makeTxnRow(supplierName: string, taxonomyNodeId: string) {
  return { id: 'tx-1', supplier_name: supplierName, taxonomy_node_id: taxonomyNodeId, full_path: 'L1|L2|L3' };
}

/**
 * Mock `db.all` for evaluateRulesBulk. The method calls db.all twice:
 *  1. pairs query → distinct (field, operator) pairs from rule_conditions
 *  2. full CTE evaluation → matched { txn_id, rule_id, target_taxonomy_node_id } rows
 * Pass empty pairs to simulate no rules / no conditions.
 */
function mockBulkEval(
  db: Database,
  pairs: { field: string; operator: string }[],
  results: { txn_id: string; rule_id: string; target_taxonomy_node_id: string }[],
) {
  vi.mocked(db.all)
    .mockResolvedValueOnce(pairs as any)  // pairs query
    .mockResolvedValueOnce(results as any);  // CTE eval result
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RuleStore', () => {
  let db: Database;
  let transactions: TransactionStore;
  let project: ProjectStore;
  let suppliers: SupplierService;
  let store: RuleStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    transactions = createMockTransactionStore();
    project = createMockProjectStore();
    suppliers = createMockSupplierService();
    store = new RuleStore(db, transactions, project, suppliers);

    // Default: FK validation returns a row (valid FK target)
    vi.mocked(db.get).mockResolvedValue({ id: 'tid1' });
  });

  // ─── listRules ──────────────────────────────────────────────────────────────

  describe('listRules', () => {
    it('returns rules with groupId set', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', group_id: 'g1', group_priority: 2 }),
        makeRuleRow({ id: 'r2', group_id: null, group_priority: null }),
      ]);

      const rules = await store.listRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].groupId).toBe('g1');
      expect(rules[1].groupId).toBeNull();
    });

    it('does not include priorityScore on returned rules', async () => {
      vi.mocked(db.all).mockResolvedValue([makeRuleRow()]);
      const rules = await store.listRules();
      expect((rules[0] as any).priorityScore).toBeUndefined();
    });

    it('parses grouped_conditions JSON', async () => {
      const grouped = {
        groupConnector: 'AND',
        groups: [{ connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }] }],
      };
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ grouped_conditions: JSON.stringify(grouped) }),
      ]);

      const rules = await store.listRules();
      expect(rules[0].groupedConditions).toEqual(grouped);
    });

    it('returns empty array when no rules exist', async () => {
      vi.mocked(db.all).mockResolvedValue([]);
      const rules = await store.listRules();
      expect(rules).toHaveLength(0);
    });

    it('orders by COALESCE(group.priority, 0) DESC, created_at DESC', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'high-group', group_id: 'g1', group_priority: 10, created_at: '2026-01-01T00:00:00' }),
        makeRuleRow({ id: 'low-group',  group_id: 'g2', group_priority: 1,  created_at: '2026-03-01T00:00:00' }),
        makeRuleRow({ id: 'ungrouped',  group_id: null, group_priority: null, created_at: '2026-03-01T00:00:00' }),
      ]);

      const rules = await store.listRules();
      expect(rules[0].id).toBe('high-group');
      expect(rules[1].id).toBe('low-group');
      expect(rules[2].id).toBe('ungrouped');

      const sql = vi.mocked(db.all).mock.calls[0][0] as string;
      expect(sql).toMatch(/COALESCE.*priority.*0/i);
      expect(sql).toContain('DESC');
      expect(sql).toContain('created_at DESC');
    });

    it('does not order by priority ASC (old per-rule priority is gone)', async () => {
      vi.mocked(db.all).mockResolvedValue([]);
      await store.listRules();
      const sql = vi.mocked(db.all).mock.calls[0][0] as string;
      expect(sql).not.toMatch(/ORDER BY priority ASC/i);
    });
  });

  // ─── createRule ─────────────────────────────────────────────────────────────

  describe('createRule', () => {
    it('inserts with group_id from input', async () => {
      await store.createRule({
        name: 'Test Rule',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
        groupId: 'g1',
      });

      const runCalls = vi.mocked(db.run).mock.calls;
      const insertCall = runCalls.find(c => (c[0] as string).includes('INSERT INTO override_rules'));
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain('g1');
    });

    it('inserts with group_id = null when not provided (ungrouped)', async () => {
      await store.createRule({
        name: 'Auto Rule',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      });

      const runCalls = vi.mocked(db.run).mock.calls;
      const insertCall = runCalls.find(c => (c[0] as string).includes('INSERT INTO override_rules'));
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain(null); // group_id = null
    });

    it('returns an object with a generated id', async () => {
      const result = await store.createRule({
        name: 'R',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      });

      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });

    it('allows duplicate names without throwing', async () => {
      await expect(store.createRule({
        name: 'Duplicate Name',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      })).resolves.not.toThrow();

      await expect(store.createRule({
        name: 'Duplicate Name',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid2',
      })).resolves.not.toThrow();
    });

    it('validates taxonomy FK — throws when node not found', async () => {
      vi.mocked(db.get).mockResolvedValue(undefined); // FK lookup returns nothing

      await expect(store.createRule({
        name: 'Bad FK',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'nonexistent',
      })).rejects.toThrow('Taxonomy node not found');
    });

    it('validates group FK — throws when group not found', async () => {
      vi.mocked(db.get)
        .mockResolvedValueOnce({ id: 'tid1' })  // taxonomy FK ok
        .mockResolvedValueOnce(undefined);        // group FK not found

      await expect(store.createRule({
        name: 'Bad Group',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
        groupId: 'nonexistent-group',
      })).rejects.toThrow('Rule group not found');
    });

    it('resolves project_supplier_id from supplier_name condition', async () => {
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue({
        id: 'sup-123', supplierName: 'Acme',
      } as any);

      await store.createRule({
        name: 'Acme Rule',
        groupedConditions: {
          groupConnector: 'AND',
          groups: [{ connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }] }],
        },
        targetTaxonomyNodeId: 'tid1',
      });

      expect(suppliers.getProjectSupplierByName).toHaveBeenCalledWith('Acme');
      const runCalls = vi.mocked(db.run).mock.calls;
      const insertCall = runCalls.find(c => (c[0] as string).includes('INSERT INTO override_rules'));
      expect(insertCall).toContain('sup-123');
    });

    it('writes to rule_conditions in same transaction (#24)', async () => {
      await store.createRule({
        name: 'Test',
        groupedConditions: {
          groupConnector: 'AND',
          groups: [{ connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }] }],
        },
        targetTaxonomyNodeId: 'tid1',
      });

      // Should have BEGIN, INSERT override_rules, INSERT rule_conditions, COMMIT
      const execCalls = vi.mocked(db.exec).mock.calls.map(c => c[0] as string);
      expect(execCalls).toContain('BEGIN TRANSACTION');
      expect(execCalls).toContain('COMMIT');

      const runCalls = vi.mocked(db.run).mock.calls.map(c => c[0] as string);
      expect(runCalls.some(sql => sql.includes('INSERT INTO override_rules'))).toBe(true);
      expect(runCalls.some(sql => sql.includes('INSERT INTO rule_conditions'))).toBe(true);
    });
  });

  // ─── updateRule ─────────────────────────────────────────────────────────────

  describe('updateRule', () => {
    it('updates specified fields', async () => {
      await store.updateRule('rule1', { name: 'Updated', isActive: false });

      expect(db.run).toHaveBeenCalled();
      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('name = ?');
      expect(sql).toContain('is_active = ?');
    });

    it('updates groupId', async () => {
      await store.updateRule('rule1', { groupId: 'g2' });

      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('group_id = ?');
      expect(vi.mocked(db.run).mock.calls[0]).toContain('g2');
    });

    it('sets groupId to null (ungroup)', async () => {
      await store.updateRule('rule1', { groupId: null });

      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('group_id = ?');
      expect(vi.mocked(db.run).mock.calls[0]).toContain(null);
    });

    it('does not accept priorityScore (removed field)', async () => {
      await store.updateRule('rule1', { priorityScore: 5 } as any);
      expect(db.run).not.toHaveBeenCalled();
    });

    it('does nothing with empty updates', async () => {
      await store.updateRule('rule1', {});
      expect(db.run).not.toHaveBeenCalled();
    });

    it('updates groupedConditions as JSON string', async () => {
      const newConditions = { groupConnector: 'AND' as const, groups: [] };
      await store.updateRule('rule1', { groupedConditions: newConditions });

      const runCalls = vi.mocked(db.run).mock.calls.map(c => c[0] as string);
      expect(runCalls.some(sql => sql.includes('grouped_conditions = ?'))).toBe(true);
    });

    it('syncs rule_conditions when conditions change (#29)', async () => {
      const newConditions = {
        groupConnector: 'AND' as const,
        groups: [{ connector: 'AND' as const, conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Beta' }] }],
      };
      await store.updateRule('rule1', { groupedConditions: newConditions });

      // Transaction wrapping
      const execCalls = vi.mocked(db.exec).mock.calls.map(c => c[0] as string);
      expect(execCalls).toContain('BEGIN TRANSACTION');
      expect(execCalls).toContain('COMMIT');

      // Deletes old + inserts new conditions
      const runCalls = vi.mocked(db.run).mock.calls.map(c => c[0] as string);
      expect(runCalls.some(sql => sql.includes('DELETE FROM rule_conditions WHERE rule_id'))).toBe(true);
      expect(runCalls.some(sql => sql.includes('INSERT INTO rule_conditions'))).toBe(true);
    });
  });

  // ─── deleteRule ─────────────────────────────────────────────────────────────

  describe('deleteRule', () => {
    it('deletes rule_conditions first, then override_rules', async () => {
      await store.deleteRule('rule1');

      const calls = vi.mocked(db.run).mock.calls.map(c => [c[0], c[1]]);
      expect(calls[0]).toEqual(['DELETE FROM rule_conditions WHERE rule_id = ?', 'rule1']);
      expect(calls[1]).toEqual(['DELETE FROM override_rules WHERE id = ?', 'rule1']);
    });
  });

  // ─── createAndApplyRule ────────────────────────────────────────────────────

  describe('createAndApplyRule', () => {
    const input = {
      name: 'Acme Rule',
      groupedConditions: {
        groupConnector: 'AND' as const,
        groups: [{ connector: 'AND' as const, conditions: [{ field: 'supplier_name', operator: 'equals' as const, value: 'Acme' }] }],
      },
      targetTaxonomyNodeId: 'node-1',
    };

    it('creates the rule and applies to all matching transactions when no higher-priority rules exist', async () => {
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValueOnce(['tx-1', 'tx-2', 'tx-3']);
      // evaluateRulesBulk: no pairs → no existing rules match
      vi.mocked(db.all).mockResolvedValueOnce([]); // pairs query → empty
      // previewRuleConflicts also calls db.all for group priorities
      vi.mocked(db.all).mockResolvedValueOnce([]); // group priorities
      vi.mocked(transactions.updateTransactions).mockResolvedValueOnce('changelog-1');

      const result = await store.createAndApplyRule(input);

      expect(result.id).toBeDefined();
      expect(result.matchedCount).toBe(3);
      expect(result.skippedCount).toBe(0);
      expect(result.changelogId).toBe('changelog-1');
    });

    it('returns matchedCount of 0 and skippedCount of 0 when no transactions match conditions', async () => {
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValueOnce([]);
      vi.mocked(db.all).mockResolvedValue([]); // evaluateRulesBulk and group priorities

      const result = await store.createAndApplyRule(input);
      expect(result.matchedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(transactions.updateTransactions).not.toHaveBeenCalled();
    });

    it('propagates error if getIdsByGroupedConditions throws', async () => {
      vi.mocked(transactions.getIdsByGroupedConditions).mockRejectedValueOnce(new Error('DB error'));

      await expect(store.createAndApplyRule(input)).rejects.toThrow('DB error');
    });
  });

  // ─── previewRuleConflicts ────────────────────────────────────────────────────

  describe('previewRuleConflicts', () => {
    it('returns empty covered and all ids as eligible when no existing rules match', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([])  // evaluateRulesBulk pairs → empty
        .mockResolvedValueOnce([]); // group priorities

      const result = await store.previewRuleConflicts(['tx-1', 'tx-2']);

      expect(result.covered).toEqual([]);
      expect(result.eligibleIds).toEqual(['tx-1', 'tx-2']);
    });

    it('returns covered rows with existing rule name for matched transactions', async () => {
      // evaluateRulesBulk returns tx-1 matched by r1
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
      );
      // group priorities
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'g1', priority: 5 }]);
      // matched rule metadata lookup
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'r1', name: 'Marketing Rule', group_id: 'g1' }]);

      const result = await store.previewRuleConflicts(['tx-1', 'tx-2']);

      expect(result.covered).toEqual([
        { transactionId: 'tx-1', existingRuleId: 'r1', existingRuleName: 'Marketing Rule' },
      ]);
      expect(result.eligibleIds).toEqual(['tx-2']);
    });

    it('returns empty arrays when candidateIds is empty', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([])  // pairs
        .mockResolvedValueOnce([]); // group priorities

      const result = await store.previewRuleConflicts([]);

      expect(result.covered).toEqual([]);
      expect(result.eligibleIds).toEqual([]);
    });

    it('new rule in higher-priority group supersedes ungrouped rule — no conflict', async () => {
      // evaluateRulesBulk returns tx-1 matched by ungrouped rule
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r-ungrouped', target_taxonomy_node_id: 'tid1' }],
      );
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'g-high', priority: 3 }]); // group priorities
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'r-ungrouped', name: 'Ungrouped', group_id: null }]); // metadata

      const result = await store.previewRuleConflicts(['tx-1', 'tx-2'], 'g-high');

      // tx-1 eligible because new group priority 3 > ungrouped priority 0
      expect(result.covered).toEqual([]);
      expect(result.eligibleIds).toEqual(['tx-1', 'tx-2']);
    });

    it('new rule in lower-priority group is blocked by higher-priority existing rule', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r-high', target_taxonomy_node_id: 'tid1' }],
      );
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'g-high', priority: 5 }, { id: 'g-low', priority: 1 }]);
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'r-high', name: 'High Priority Rule', group_id: 'g-high' }]);

      const result = await store.previewRuleConflicts(['tx-1'], 'g-low');

      expect(result.covered).toEqual([
        { transactionId: 'tx-1', existingRuleId: 'r-high', existingRuleName: 'High Priority Rule' },
      ]);
      expect(result.eligibleIds).toEqual([]);
    });

    it('new rule at same priority as existing rule is allowed (equal priority = no conflict)', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r-same', target_taxonomy_node_id: 'tid1' }],
      );
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'g-a', priority: 3 }, { id: 'g-b', priority: 3 }]);
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'r-same', name: 'Same', group_id: 'g-a' }]);

      const result = await store.previewRuleConflicts(['tx-1'], 'g-b');

      expect(result.covered).toEqual([]);
      expect(result.eligibleIds).toEqual(['tx-1']);
    });
  });

  // ─── evaluateRulesBulk ────────────────────────────────────────────────────

  describe('evaluateRulesBulk', () => {
    it('returns empty map when no active rules (pairs query returns empty) (#9)', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]); // pairs → empty

      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });

    it('simple supplier_name equals — single CTE match (#1)', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [
          { txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
          { txn_id: 'tx-2', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
        ],
      );

      const result = await store.evaluateRules();
      expect(result.get('tx-1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
      expect(result.get('tx-2')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('higher priority group wins over lower (#2)', async () => {
      // DISTINCT ON in SQL returns only the winning rule per txn
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r-high', target_taxonomy_node_id: 'tid-high' }],
      );

      const result = await store.evaluateRules();
      expect(result.get('tx-1')?.ruleId).toBe('r-high');
      expect(result.get('tx-1')?.targetTaxonomyNodeId).toBe('tid-high');
    });

    it('same group — created_at tiebreak (#3)', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r-newer', target_taxonomy_node_id: 'tid-newer' }],
      );

      const result = await store.evaluateRules();
      expect(result.get('tx-1')?.ruleId).toBe('r-newer');
    });

    it('AND within group — both conditions must match (#4)', async () => {
      // Two distinct (field, operator) pairs for AND conditions
      mockBulkEval(db,
        [
          { field: 'supplier_name', operator: 'equals' },
          { field: 'gl_description', operator: 'equals' },
        ],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
      );

      const result = await store.evaluateRules();
      expect(result.get('tx-1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('AND partial match — one condition fails → zero matches (#5)', async () => {
      mockBulkEval(db,
        [
          { field: 'supplier_name', operator: 'equals' },
          { field: 'gl_description', operator: 'equals' },
        ],
        [], // no matches — incomplete AND group
      );

      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });

    it('OR across groups — either group passes (#6)', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [
          { txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
          { txn_id: 'tx-2', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
        ],
      );

      const result = await store.evaluateRules();
      expect(result.size).toBe(2);
    });

    it('ungrouped vs grouped — grouped wins (#8)', async () => {
      // SQL DISTINCT ON with COALESCE(rg.priority, 0) DESC ensures grouped wins
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r-grouped', target_taxonomy_node_id: 'tid-grouped' }],
      );

      const result = await store.evaluateRules();
      expect(result.get('tx-1')?.ruleId).toBe('r-grouped');
    });

    it('zero-match rule — nonexistent supplier → 0 matches, no false positives (#9)', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [], // no transactions match nonexistent supplier
      );

      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });

    it('unmatched transactions absent from results (#10)', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
        // tx-2, tx-3 etc. not in results
      );

      const result = await store.evaluateRules();
      expect(result.size).toBe(1);
      expect(result.has('tx-2')).toBe(false);
    });

    it('inactive rule ignored — is_active filter in SQL (#23)', async () => {
      // The SQL includes WHERE r.is_active = TRUE in the CTEs.
      // If no active rules have conditions, pairs query returns empty.
      vi.mocked(db.all).mockResolvedValueOnce([]); // no active rule pairs

      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });

    it('scoped evaluation via scopeIds — creates temp table (#30)', async () => {
      // pairs query
      vi.mocked(db.all).mockResolvedValueOnce([{ field: 'supplier_name', operator: 'equals' }]);
      // CTE result — only scoped transactions in result
      vi.mocked(db.all).mockResolvedValueOnce([
        { txn_id: 'tx-scoped', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
      ]);

      const result = await store.evaluateRulesBulk({ scopeIds: ['tx-scoped', 'tx-other'] });

      // Should create temp table for scope
      const runCalls = vi.mocked(db.run).mock.calls.map(c => c[0] as string);
      expect(runCalls.some(sql => sql.includes('CREATE TEMP TABLE'))).toBe(true);

      expect(result.get('tx-scoped')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('scoped evaluation via scopeTable — joins against it (#30)', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([{ field: 'supplier_name', operator: 'equals' }]);
      vi.mocked(db.all).mockResolvedValueOnce([
        { txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
      ]);

      const result = await store.evaluateRulesBulk({ scopeTable: 'tmp_my_scope' });

      // The SQL should contain a JOIN against the scope table
      const evalCall = vi.mocked(db.all).mock.calls[1];
      const sql = evalCall[0] as string;
      expect(sql).toContain('tmp_my_scope');

      expect(result.size).toBe(1);
    });

    it('ruleIds filter — only specified rules evaluated (#22)', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([{ field: 'supplier_name', operator: 'equals' }]);
      vi.mocked(db.all).mockResolvedValueOnce([
        { txn_id: 'tx-1', rule_id: 'r2', target_taxonomy_node_id: 'tid2' },
      ]);

      const result = await store.evaluateRulesBulk({ ruleIds: ['r2'] });

      // Pairs query should include ruleIds filter
      const pairsCall = vi.mocked(db.all).mock.calls[0];
      const pairsSql = pairsCall[0] as string;
      expect(pairsSql).toContain('IN');
      expect(pairsCall.slice(1)).toContain('r2');

      expect(result.get('tx-1')?.ruleId).toBe('r2');
    });

    it('empty ruleIds array returns empty map without executing CTE', async () => {
      // evaluateRules with empty ruleIds passes through to evaluateRulesBulk
      // which will get no pairs back for non-existent rule IDs
      vi.mocked(db.all).mockResolvedValueOnce([]); // pairs → empty for empty filter

      const result = await store.evaluateRules(undefined, []);
      expect(result.size).toBe(0);
    });

    it('contains operator — ILIKE CTE (#13)', async () => {
      mockBulkEval(db,
        [{ field: 'gl_description', operator: 'contains' }],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
      );

      const result = await store.evaluateRules();
      expect(result.get('tx-1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('OR-within-group folds condition_connector between adjacent conditions (regression)', async () => {
      // Guard against the bug where group_evals treated every group as AND,
      // silently dropping OR-rules during bulk classification.
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
      );

      await store.evaluateRules();

      const evalCall = vi.mocked(db.all).mock.calls[1];
      const sql = evalCall[0] as string;
      // The bulk evaluator must use the connector stored on the previous
      // condition row, matching buildGroupedWhereClause/filter-builder semantics.
      expect(sql).toContain('condition_connector');
      expect(sql).toMatch(/prev_condition\.condition_connector\s*=\s*'OR'/);
      expect(sql).toMatch(/step\.result\s+OR\s+next_condition\.condition_matched/);
    });
  });

  // ─── listRulesByGroup ──────────────────────────────────────────────────────

  describe('listRulesByGroup', () => {
    it('returns paginated rules for a specific group', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([{ cnt: 3 }])  // count query
        .mockResolvedValueOnce([               // rules query
          makeRuleRow({ id: 'r1', group_id: 'g1' }),
          makeRuleRow({ id: 'r2', group_id: 'g1' }),
        ]);

      const result = await store.listRulesByGroup('g1', 2, 0);
      expect(result.total).toBe(3);
      expect(result.rules).toHaveLength(2);
      expect(result.rules[0].id).toBe('r1');
    });
  });

  // ─── reassignSupplierRules ─────────────────────────────────────────────────

  describe('reassignSupplierRules', () => {
    it('bulk updates project_supplier_id for supplier merges', async () => {
      await store.reassignSupplierRules(['losing-1', 'losing-2'], 'survivor');

      const call = vi.mocked(db.run).mock.calls[0];
      const sql = call[0] as string;
      expect(sql).toContain('UPDATE override_rules SET project_supplier_id');
      expect(call).toContain('survivor');
      expect(call).toContain('losing-1');
      expect(call).toContain('losing-2');
    });

    it('no-ops when losingIds is empty', async () => {
      await store.reassignSupplierRules([], 'survivor');
      expect(db.run).not.toHaveBeenCalled();
    });
  });

  // ─── previewRules ──────────────────────────────────────────────────────────

  describe('previewRules', () => {
    it('returns token + counts', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [
          { txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
          { txn_id: 'tx-2', rule_id: 'r1', target_taxonomy_node_id: 'tid1' },
        ],
      );

      const result = await store.previewRules(['r1']);

      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(result.affectedRowCount).toBe(2);
      expect(result.matchingRuleCount).toBe(1);
    });
  });

  // ─── applyRules ────────────────────────────────────────────────────────────

  describe('applyRules', () => {
    it('uses cached token to skip re-evaluation', async () => {
      // First: preview to get token
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
      );
      const preview = await store.previewRules(['r1']);

      // Clear mocks — applyRules should NOT call db.all again
      vi.mocked(db.all).mockClear();

      const result = await store.applyRules(['r1'], preview.token);

      expect(db.all).not.toHaveBeenCalled(); // no re-evaluation
      expect(result.matchedCount).toBe(1);
      expect(result.ruleCount).toBe(1);
      expect(transactions.updateTransactions).toHaveBeenCalled();
    });

    it('re-evaluates when no token provided', async () => {
      mockBulkEval(db,
        [{ field: 'supplier_name', operator: 'equals' }],
        [{ txn_id: 'tx-1', rule_id: 'r1', target_taxonomy_node_id: 'tid1' }],
      );

      const result = await store.applyRules(['r1']);

      expect(db.all).toHaveBeenCalled(); // had to evaluate
      expect(result.matchedCount).toBe(1);
    });

    it('returns zero counts when no matches', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]); // pairs → empty

      const result = await store.applyRules(['r1']);

      expect(result.matchedCount).toBe(0);
      expect(result.ruleCount).toBe(0);
    });
  });

  // ─── Rule groups ─────────────────────────────────────────────────────────────

  describe('listGroups', () => {
    it('returns groups ordered by priority DESC', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { id: 'g1', name: 'Client', priority: 10, created_at: '2026-01-01T00:00:00' },
        { id: 'g2', name: 'Analyst', priority: 5,  created_at: '2026-01-01T00:00:00' },
      ]);

      const groups = await store.listGroups();
      expect(groups[0].id).toBe('g1');
      expect(groups[1].id).toBe('g2');

      const sql = vi.mocked(db.all).mock.calls[0][0] as string;
      expect(sql).toContain('priority DESC');
    });
  });

  describe('createGroup', () => {
    it('creates a group with the given name and priority', async () => {
      await store.createGroup({ name: 'Client', priority: 5 });

      const runCalls = vi.mocked(db.run).mock.calls;
      const insertCall = runCalls.find(c => (c[0] as string).includes('INSERT INTO rule_groups'));
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain('Client');
      expect(insertCall).toContain(5);
    });

    it('rejects priority < 1', async () => {
      await expect(store.createGroup({ name: 'Bad', priority: 0 }))
        .rejects.toThrow();
      await expect(store.createGroup({ name: 'Bad', priority: -1 }))
        .rejects.toThrow();
    });

    it('cascades existing groups up when priority is taken', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'existing-group', priority: 5 }]);

      await store.createGroup({ name: 'New', priority: 5 });

      const runCalls = vi.mocked(db.run).mock.calls;
      const bumpCall = runCalls.find(c => (c[0] as string).includes('UPDATE rule_groups') && c.includes('existing-group'));
      expect(bumpCall).toBeDefined();
      expect(bumpCall).toContain(6);

      const insertCall = runCalls.find(c => (c[0] as string).includes('INSERT INTO rule_groups'));
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain(5);
    });

    it('returns a generated id', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]);
      const result = await store.createGroup({ name: 'G', priority: 1 });
      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('string');
    });

    it('requires priority to be provided (TypeScript enforces, runtime validates >= 1)', async () => {
      await expect(store.createGroup({ name: 'No Priority', priority: undefined as any }))
        .rejects.toThrow();
      await expect(store.createGroup({ name: 'No Priority', priority: null as any }))
        .rejects.toThrow();
    });
  });

  describe('updateGroup', () => {
    it('updates name', async () => {
      await store.updateGroup('g1', { name: 'New Name' });
      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('name = ?');
    });

    it('updates priority', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]);
      await store.updateGroup('g1', { priority: 3 });
      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('priority = ?');
    });

    it('rejects priority < 1 on update', async () => {
      await expect(store.updateGroup('g1', { priority: 0 })).rejects.toThrow();
    });

    it('cascades existing groups up when updating to a taken priority', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'other-group', priority: 5 }]);

      await store.updateGroup('g1', { priority: 5 });

      const runCalls = vi.mocked(db.run).mock.calls;
      const bumpCall = runCalls.find(c => (c[0] as string).includes('UPDATE rule_groups') && c.includes('other-group'));
      expect(bumpCall).toBeDefined();
      expect(bumpCall).toContain(6);
    });

    it('does nothing with empty updates', async () => {
      await store.updateGroup('g1', {});
      expect(db.run).not.toHaveBeenCalled();
    });
  });

  describe('deleteGroup', () => {
    it('sets group_id = NULL on all rules in the group before deleting', async () => {
      await store.deleteGroup('g1');

      const calls = vi.mocked(db.run).mock.calls.map(c => c[0] as string);
      const ungroup = calls.find(sql => sql.includes('group_id') && sql.includes('NULL'));
      expect(ungroup).toBeDefined();

      const del = calls.find(sql => sql.includes('DELETE') && sql.includes('rule_groups'));
      expect(del).toBeDefined();
    });

    it('ungroups rules before deleting, not deletes them', async () => {
      await store.deleteGroup('g1');

      const calls = vi.mocked(db.run).mock.calls.map(c => c[0] as string);
      expect(calls.every(sql => !sql.includes('DELETE FROM override_rules'))).toBe(true);
    });
  });

  describe('reorderGroups', () => {
    it('reassigns sequential priority values from provided order', async () => {
      await store.reorderGroups(['g3', 'g1', 'g2']);

      const updateCalls = vi.mocked(db.run).mock.calls;
      expect(updateCalls.some(call => call.includes('g3') && call.includes(3))).toBe(true);
      expect(updateCalls.some(call => call.includes('g2') && call.includes(1))).toBe(true);
    });
  });

  describe('assignToGroup', () => {
    it('sets group_id on all provided rule ids', async () => {
      await store.assignToGroup(['r1', 'r2'], 'g1');

      const calls = vi.mocked(db.run).mock.calls;
      expect(calls.some(call => call.includes('r1') && call.includes('g1'))).toBe(true);
      expect(calls.some(call => call.includes('r2') && call.includes('g1'))).toBe(true);
    });

    it('sets group_id = null to ungroup rules', async () => {
      await store.assignToGroup(['r1'], null);

      const calls = vi.mocked(db.run).mock.calls;
      expect(calls.some(call => call.includes('r1') && call.includes(null))).toBe(true);
    });
  });

  // ─── generate_rules_preview ──────────────────────────────────────────────────

  describe('generate_rules_preview', () => {
    beforeEach(() => {
      vi.mocked(project.getSetting).mockResolvedValue(['gl_description'] as any);
      vi.mocked(transactions.getColumns).mockResolvedValue(['gl_description']);
      vi.mocked(db.run).mockResolvedValue(undefined as any);
    });

    it('returns zero counts when no eligible suppliers', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([]) // no distinct supplier names
        .mockResolvedValueOnce([]); // covered

      const result = await store.generate_rules_preview();
      expect(result.rulesCreated).toBe(0);
      expect(result.suppliersProcessed).toBe(0);
    });

    it('skips suppliers that already have a rule (covered check via project_supplier_id)', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([
          { supplier_name: 'Acme Corp', project_supplier_id: 'sup-1' },
          { supplier_name: 'NewCo', project_supplier_id: 'sup-2' },
        ]) // distinct suppliers
        .mockResolvedValueOnce([{ project_supplier_id: 'sup-1' }]) // Acme already covered
        .mockResolvedValueOnce([makeTxnRow('NewCo', 'node-2')]); // NewCo txns

      const result = await store.generate_rules_preview();

      expect(result.suppliersProcessed).toBe(1); // only NewCo
    });
  });

  // ─── getCatARuleForSupplier ───────────────────────────────────────────────────

  describe('getCatARuleForSupplier', () => {
    it('returns null when supplier not found', async () => {
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue(null);

      const result = await store.getCatARuleForSupplier('Unknown Corp');
      expect(result).toBeNull();
    });

    it('returns the rule when a cat A rule exists via project_supplier_id FK', async () => {
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue({ id: 'sup-1' } as any);
      vi.mocked(db.get).mockResolvedValue(
        makeRuleRow({ id: 'cat-a-rule', category_a_supplier: true, project_supplier_id: 'sup-1' })
      );

      const result = await store.getCatARuleForSupplier('Acme Corp');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('cat-a-rule');
      expect(suppliers.getProjectSupplierByName).toHaveBeenCalledWith('Acme Corp');
    });

    it('returns null when no cat A rule exists for supplier', async () => {
      vi.mocked(suppliers.getProjectSupplierByName).mockResolvedValue({ id: 'sup-1' } as any);
      vi.mocked(db.get).mockResolvedValue(undefined); // no matching rule

      const result = await store.getCatARuleForSupplier('Acme Corp');
      expect(result).toBeNull();
    });
  });
});
