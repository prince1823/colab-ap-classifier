import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleStore } from '../../../src/main/services/rules';
import { createMockDatabase, createMockTransactionStore, createMockProjectStore } from '../../helpers/mock-services';
import type { Database, TransactionStore, ProjectStore } from '../../../src/shared/types/services';

// ─── Row factories ────────────────────────────────────────────────────────────

function makeRuleRow(overrides: Partial<{
  id: string; name: string; grouped_conditions: string;
  target_taxonomy_node_id: string; group_id: string | null;
  group_priority: number | null; is_active: boolean;
  source: string; created_at: string;
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
    created_at: '2026-01-01T00:00:00',
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

function makeExistingRuleRow(supplierName: string) {
  return {
    grouped_conditions: makeSupplierOnlyConditions(supplierName),
  };
}

function makeTxnRow(supplierName: string, taxonomyNodeId: string) {
  return { id: 'tx-1', supplier_name: supplierName, taxonomy_node_id: taxonomyNodeId, full_path: 'L1|L2|L3' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RuleStore', () => {
  let db: Database;
  let transactions: TransactionStore;
  let project: ProjectStore;
  let store: RuleStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    transactions = createMockTransactionStore();
    project = createMockProjectStore();
    store = new RuleStore(db, transactions, project);
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
      // DB returns rows in the order the SQL would produce
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

      const insertCall = vi.mocked(db.run).mock.calls[0];
      const sql = insertCall[0] as string;
      expect(sql).toContain('group_id');
      const groupIdArg = insertCall.slice(1).find((_, i, arr) =>
        arr[i - 1] !== undefined && String(insertCall[0]).includes('group_id') && _ === 'g1'
      );
      expect(insertCall).toContain('g1');
    });

    it('inserts with group_id = null when not provided (ungrouped)', async () => {
      await store.createRule({
        name: 'Auto Rule',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      });

      const insertCall = vi.mocked(db.run).mock.calls[0];
      expect(insertCall).toContain(null); // group_id = null
    });

    it('does not look up or assign per-rule priority', async () => {
      await store.createRule({
        name: 'Test',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      });

      // Should not query MAX(priority) from override_rules
      const getAllCalls = vi.mocked(db.get).mock.calls.map(c => c[0] as string);
      expect(getAllCalls.every(sql => !sql.includes('MAX(priority)'))).toBe(true);
    });

    it('does not look up a default bucket', async () => {
      await store.createRule({
        name: 'Test',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      });

      const getAllCalls = vi.mocked(db.get).mock.calls.map(c => c[0] as string);
      expect(getAllCalls.every(sql => !sql.includes('is_default'))).toBe(true);
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
      // priorityScore is no longer a valid update field — passing it should be a no-op
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

      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('grouped_conditions = ?');
    });
  });

  // ─── deleteRule ─────────────────────────────────────────────────────────────

  describe('deleteRule', () => {
    it('deletes by id', async () => {
      await store.deleteRule('rule1');
      expect(db.run).toHaveBeenCalledWith('DELETE FROM override_rules WHERE id = ?', 'rule1');
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

    it('creates the rule and returns matched transaction count', async () => {
      vi.mocked(transactions.applyRule).mockResolvedValueOnce(5);

      const result = await store.createAndApplyRule(input);

      expect(result.id).toBeDefined();
      expect(result.matchedCount).toBe(5);
      expect(transactions.applyRule).toHaveBeenCalledWith(
        result.id,
        input.groupedConditions,
        input.targetTaxonomyNodeId
      );
    });

    it('passes groupId through to createRule', async () => {
      vi.mocked(transactions.applyRule).mockResolvedValueOnce(0);

      await store.createAndApplyRule({ ...input, groupId: 'g1' });

      const insertSql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(insertSql).toContain('group_id');
      expect(vi.mocked(db.run).mock.calls[0]).toContain('g1');
    });

    it('returns matchedCount of 0 when no transactions match', async () => {
      vi.mocked(transactions.applyRule).mockResolvedValueOnce(0);

      const result = await store.createAndApplyRule(input);
      expect(result.matchedCount).toBe(0);
    });

    it('propagates error if applyRule throws', async () => {
      vi.mocked(transactions.applyRule).mockRejectedValueOnce(new Error('Rule not found: abc'));

      await expect(store.createAndApplyRule(input)).rejects.toThrow('Rule not found');
    });
  });

  // ─── evaluateRules ──────────────────────────────────────────────────────────

  describe('evaluateRules', () => {
    it('matches transactions and returns ruleId + targetTaxonomyNodeId', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', grouped_conditions: makeSupplierOnlyConditions('Acme'), target_taxonomy_node_id: 'tid1', group_id: 'g1', group_priority: 1 }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1', 'tx2']);

      const result = await store.evaluateRules();
      expect(result.get('tx1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
      expect(result.get('tx2')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('returns empty map when no rules exist', async () => {
      vi.mocked(db.all).mockResolvedValue([]);
      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });

    it('returns empty map when no rules match any transaction', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', group_id: 'g1', group_priority: 1 }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue([]);

      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });

    it('first-match-wins: once a transaction is matched, later rules do not overwrite it', async () => {
      // r1 is evaluated first (higher group priority), r2 second
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', target_taxonomy_node_id: 'tid-first',  group_id: 'g1', group_priority: 10 }),
        makeRuleRow({ id: 'r2', target_taxonomy_node_id: 'tid-second', group_id: 'g2', group_priority: 1  }),
      ]);
      // Both rules match tx1
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1']);

      const result = await store.evaluateRules();
      expect(result.get('tx1')?.ruleId).toBe('r1');
      expect(result.get('tx1')?.targetTaxonomyNodeId).toBe('tid-first');
    });

    // ── Group priority determines winner ──────────────────────────────────────

    it('higher-priority group wins over lower-priority group regardless of rule specificity', async () => {
      // Low-priority group has a more specific rule (supplier + line), high-priority group has supplier-only.
      // High-priority group should still win.
      vi.mocked(db.all).mockResolvedValue([
        // High priority group — supplier-only rule (less specific)
        makeRuleRow({
          id: 'r-general',
          grouped_conditions: makeSupplierOnlyConditions('Acme'),
          target_taxonomy_node_id: 'tid-general',
          group_id: 'g-high',
          group_priority: 10,
          created_at: '2026-01-01T00:00:00',
        }),
        // Low priority group — supplier + line rule (more specific)
        makeRuleRow({
          id: 'r-specific',
          grouped_conditions: makeSupplierAndLineConditions('Acme', 'scissors'),
          target_taxonomy_node_id: 'tid-specific',
          group_id: 'g-low',
          group_priority: 1,
          created_at: '2026-03-01T00:00:00',
        }),
      ]);

      // Both rules match this transaction (it has supplier=Acme and line=scissors)
      vi.mocked(transactions.getIdsByGroupedConditions)
        .mockResolvedValueOnce(['tx1'])  // r-general matches
        .mockResolvedValueOnce(['tx1']); // r-specific matches

      const result = await store.evaluateRules();

      // Higher-priority group wins — NOT the more specific rule
      expect(result.get('tx1')?.ruleId).toBe('r-general');
      expect(result.get('tx1')?.targetTaxonomyNodeId).toBe('tid-general');
    });

    // ── Same-group tie-break ──────────────────────────────────────────────────

    it('same group: latest created_at wins when multiple rules match — specificity is irrelevant', async () => {
      // Two rules in the same group: supplier-only (older) vs supplier+line (newer).
      // Newer rule wins because of created_at, NOT because it is more specific.
      vi.mocked(db.all).mockResolvedValue([
        // Newer rule (higher created_at, listed first by ORDER BY created_at DESC)
        makeRuleRow({
          id: 'r-newer-specific',
          grouped_conditions: makeSupplierAndLineConditions('Acme', 'scissors'),
          target_taxonomy_node_id: 'tid-specific',
          group_id: 'g1',
          group_priority: 5,
          created_at: '2026-03-01T00:00:00',
        }),
        // Older rule (lower created_at)
        makeRuleRow({
          id: 'r-older-general',
          grouped_conditions: makeSupplierOnlyConditions('Acme'),
          target_taxonomy_node_id: 'tid-general',
          group_id: 'g1',
          group_priority: 5,
          created_at: '2026-01-01T00:00:00',
        }),
      ]);

      vi.mocked(transactions.getIdsByGroupedConditions)
        .mockResolvedValueOnce(['tx1'])  // r-newer-specific matches
        .mockResolvedValueOnce(['tx1']); // r-older-general would match too, but tx1 already claimed

      const result = await store.evaluateRules();

      // Newer rule wins (same group, created_at tie-break) — NOT because it is more specific
      expect(result.get('tx1')?.ruleId).toBe('r-newer-specific');
    });

    it('same group: older rule wins if it was created more recently than the specific rule', async () => {
      // Demonstrates specificity truly does not matter — a newer general rule beats an older specific rule
      vi.mocked(db.all).mockResolvedValue([
        // Newer general rule (listed first by ORDER BY created_at DESC)
        makeRuleRow({
          id: 'r-newer-general',
          grouped_conditions: makeSupplierOnlyConditions('Acme'),
          target_taxonomy_node_id: 'tid-general',
          group_id: 'g1',
          group_priority: 5,
          created_at: '2026-03-01T00:00:00',
        }),
        // Older specific rule
        makeRuleRow({
          id: 'r-older-specific',
          grouped_conditions: makeSupplierAndLineConditions('Acme', 'scissors'),
          target_taxonomy_node_id: 'tid-specific',
          group_id: 'g1',
          group_priority: 5,
          created_at: '2026-01-01T00:00:00',
        }),
      ]);

      vi.mocked(transactions.getIdsByGroupedConditions)
        .mockResolvedValueOnce(['tx1'])  // r-newer-general matches
        .mockResolvedValueOnce(['tx1']); // r-older-specific would match too

      const result = await store.evaluateRules();

      // Newer general rule wins over older specific rule — specificity is not a factor
      expect(result.get('tx1')?.ruleId).toBe('r-newer-general');
    });

    // ── Ungrouped rules ───────────────────────────────────────────────────────

    it('ungrouped rules are evaluated after all named groups', async () => {
      // Named group has a low-priority match, ungrouped has a match too.
      // Named group should win.
      vi.mocked(db.all).mockResolvedValue([
        // Named group rule (group_priority = 1 → COALESCE gives 1)
        makeRuleRow({
          id: 'r-grouped',
          target_taxonomy_node_id: 'tid-grouped',
          group_id: 'g1',
          group_priority: 1,
          created_at: '2026-01-01T00:00:00',
        }),
        // Ungrouped rule (group_priority = null → COALESCE gives 0 → evaluated last)
        makeRuleRow({
          id: 'r-ungrouped',
          target_taxonomy_node_id: 'tid-ungrouped',
          group_id: null,
          group_priority: null,
          created_at: '2026-03-01T00:00:00', // newer, but ungrouped
        }),
      ]);

      vi.mocked(transactions.getIdsByGroupedConditions)
        .mockResolvedValueOnce(['tx1'])  // r-grouped matches
        .mockResolvedValueOnce(['tx1']); // r-ungrouped also matches

      const result = await store.evaluateRules();

      // Named group wins over ungrouped even though ungrouped rule is newer
      expect(result.get('tx1')?.ruleId).toBe('r-grouped');
    });

    it('ungrouped rule matches and classifies transaction when it is the only rule', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({
          id: 'r-ungrouped',
          grouped_conditions: makeSupplierOnlyConditions('Acme'),
          target_taxonomy_node_id: 'tid-ungrouped',
          group_id: null,
          group_priority: null,
        }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1', 'tx2']);

      const result = await store.evaluateRules();
      expect(result.size).toBe(2);
      expect(result.get('tx1')).toEqual({ ruleId: 'r-ungrouped', targetTaxonomyNodeId: 'tid-ungrouped' });
      expect(result.get('tx2')).toEqual({ ruleId: 'r-ungrouped', targetTaxonomyNodeId: 'tid-ungrouped' });
    });

    it('ungrouped rules apply when no named group matches', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({
          id: 'r-grouped',
          target_taxonomy_node_id: 'tid-grouped',
          group_id: 'g1',
          group_priority: 5,
        }),
        makeRuleRow({
          id: 'r-ungrouped',
          target_taxonomy_node_id: 'tid-ungrouped',
          group_id: null,
          group_priority: null,
        }),
      ]);

      vi.mocked(transactions.getIdsByGroupedConditions)
        .mockResolvedValueOnce([])       // r-grouped does not match
        .mockResolvedValueOnce(['tx1']); // r-ungrouped matches

      const result = await store.evaluateRules();
      expect(result.get('tx1')?.ruleId).toBe('r-ungrouped');
    });

    // ── What transaction qualities are evaluated ───────────────────────────────

    it('only evaluates columns referenced in the rule conditions — nothing else', async () => {
      const conditions = makeConditions([
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
      ]);
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', grouped_conditions: conditions }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1']);

      await store.evaluateRules();

      // getIdsByGroupedConditions is called with exactly the rule's conditions — no additional fields
      const calledWith = vi.mocked(transactions.getIdsByGroupedConditions).mock.calls[0][0];
      const fields = calledWith.groups.flatMap((g: any) => g.conditions.map((c: any) => c.field));
      expect(fields).toEqual(['supplier_name']);
    });

    it('passes all condition fields in a multi-condition rule to getIdsByGroupedConditions', async () => {
      const conditions = makeConditions([
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
        { field: 'line_description', operator: 'equals', value: 'scissors' },
      ]);
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', grouped_conditions: conditions }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1']);

      await store.evaluateRules();

      const calledWith = vi.mocked(transactions.getIdsByGroupedConditions).mock.calls[0][0];
      const fields = calledWith.groups.flatMap((g: any) => g.conditions.map((c: any) => c.field));
      expect(fields).toContain('supplier_name');
      expect(fields).toContain('line_description');
      expect(fields).toHaveLength(2);
    });

    it('only evaluates active rules', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r-active',   is_active: true  }),
        makeRuleRow({ id: 'r-inactive', is_active: false }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1']);

      await store.evaluateRules();

      expect(transactions.getIdsByGroupedConditions).toHaveBeenCalledTimes(1);
    });
  });

  // ─── evaluateRules — ruleIds filter ──────────────────────────────────────────

  describe('evaluateRules — ruleIds filter', () => {
    it('empty ruleIds array returns empty map without querying transactions', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', is_active: true }),
      ]);

      const result = await store.evaluateRules(undefined, []);

      expect(result.size).toBe(0);
      expect(transactions.getIdsByGroupedConditions).not.toHaveBeenCalled();
    });

    it('ruleIds filters to only those rules, ignoring other active rules', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', target_taxonomy_node_id: 'tid1', group_id: 'g1', group_priority: 2 }),
        makeRuleRow({ id: 'r2', target_taxonomy_node_id: 'tid2', group_id: 'g1', group_priority: 1 }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx1']);

      const result = await store.evaluateRules(undefined, ['r2']);

      // Only r2 should have been evaluated — one call, not two
      expect(transactions.getIdsByGroupedConditions).toHaveBeenCalledTimes(1);
      expect(result.get('tx1')).toEqual({ ruleId: 'r2', targetTaxonomyNodeId: 'tid2' });
    });

    it('ruleIds containing an inactive rule — inactive rule is skipped', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r-inactive', is_active: false }),
      ]);

      const result = await store.evaluateRules(undefined, ['r-inactive']);

      expect(result.size).toBe(0);
      expect(transactions.getIdsByGroupedConditions).not.toHaveBeenCalled();
    });

    it('ruleIds containing an unknown rule ID — silently ignored, no error', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', is_active: true }),
      ]);

      const result = await store.evaluateRules(undefined, ['nonexistent-id']);

      expect(result.size).toBe(0);
      expect(transactions.getIdsByGroupedConditions).not.toHaveBeenCalled();
    });

    it('both ruleIds and transactionIds — specified rules evaluated against specified transactions', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', target_taxonomy_node_id: 'tid1' }),
        makeRuleRow({ id: 'r2', target_taxonomy_node_id: 'tid2' }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue(['tx5']);

      const result = await store.evaluateRules(['tx5', 'tx6', 'tx7'], ['r1']);

      // Only r1 evaluated — one call
      expect(transactions.getIdsByGroupedConditions).toHaveBeenCalledTimes(1);
      // transactionIds passed through as scopeToIds
      expect(transactions.getIdsByGroupedConditions).toHaveBeenCalledWith(
        expect.anything(),
        ['tx5', 'tx6', 'tx7']
      );
      expect(result.get('tx5')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('ruleIds with valid rules that match no transactions — returns empty map', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', is_active: true }),
      ]);
      vi.mocked(transactions.getIdsByGroupedConditions).mockResolvedValue([]);

      const result = await store.evaluateRules(undefined, ['r1']);

      expect(result.size).toBe(0);
      // Still queried — the rule was evaluated, it just matched nothing
      expect(transactions.getIdsByGroupedConditions).toHaveBeenCalledTimes(1);
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

      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('rule_groups');
      expect(vi.mocked(db.run).mock.calls[0]).toContain('Client');
      expect(vi.mocked(db.run).mock.calls[0]).toContain(5);
    });

    it('rejects priority < 1', async () => {
      await expect(store.createGroup({ name: 'Bad', priority: 0 }))
        .rejects.toThrow();
      await expect(store.createGroup({ name: 'Bad', priority: -1 }))
        .rejects.toThrow();
    });

    it('cascades existing groups up when priority is taken', async () => {
      // Priority 5 is occupied by existing-group; cascadePriorities bumps it to 6
      vi.mocked(db.all).mockResolvedValueOnce([{ id: 'existing-group', priority: 5 }]);

      await store.createGroup({ name: 'New', priority: 5 });

      // Should bump existing-group from 5→6, then insert the new group at 5
      const runCalls = vi.mocked(db.run).mock.calls;
      const bumpCall = runCalls.find(c => (c[0] as string).includes('UPDATE rule_groups') && c.includes('existing-group'));
      expect(bumpCall).toBeDefined();
      expect(bumpCall).toContain(6); // bumped to 6

      const insertCall = runCalls.find(c => (c[0] as string).includes('INSERT INTO rule_groups'));
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain(5); // new group gets priority 5
    });

    it('returns a generated id', async () => {
      vi.mocked(db.all).mockResolvedValueOnce([]); // no conflicts
      const result = await store.createGroup({ name: 'G', priority: 1 });
      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('string');
    });

    it('requires priority to be provided (TypeScript enforces, runtime validates >= 1)', async () => {
      // Even if someone bypasses TypeScript and passes undefined, the >= 1 check catches it
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
      vi.mocked(db.all).mockResolvedValueOnce([]); // no conflicts from cascade
      await store.updateGroup('g1', { priority: 3 });
      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('priority = ?');
    });

    it('rejects priority < 1 on update', async () => {
      await expect(store.updateGroup('g1', { priority: 0 })).rejects.toThrow();
    });

    it('cascades existing groups up when updating to a taken priority', async () => {
      // Priority 5 occupied by other-group; cascade bumps it to 6
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
      // Should not delete from override_rules
      expect(calls.every(sql => !sql.includes('DELETE FROM override_rules'))).toBe(true);
    });
  });

  describe('group priority reflected in rule listing', () => {
    it('rule in high-priority group is listed before rule in low-priority group', async () => {
      // Simulate DB returning rules ordered by group priority DESC
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r-in-high', name: 'High Group Rule', group_id: 'g-high', group_priority: 10, created_at: '2026-01-01T00:00:00' }),
        makeRuleRow({ id: 'r-in-low', name: 'Low Group Rule', group_id: 'g-low', group_priority: 2, created_at: '2026-03-01T00:00:00' }),
        makeRuleRow({ id: 'r-ungrouped', name: 'Ungrouped Rule', group_id: null, group_priority: null, created_at: '2026-03-15T00:00:00' }),
      ]);

      const rules = await store.listRules();

      // High-priority group rule first, even though it was created earliest
      expect(rules[0].id).toBe('r-in-high');
      // Low-priority group rule second, even though it was created after the high-priority one
      expect(rules[1].id).toBe('r-in-low');
      // Ungrouped rule last, even though it was created most recently
      expect(rules[2].id).toBe('r-ungrouped');
    });

    it('moving a rule to a higher-priority group changes its evaluation position', async () => {
      // Before: rule is ungrouped → listed last
      vi.mocked(db.all).mockResolvedValueOnce([
        makeRuleRow({ id: 'r-grouped', group_id: 'g1', group_priority: 5 }),
        makeRuleRow({ id: 'r-target', group_id: null, group_priority: null }),
      ]);

      const rulesBefore = await store.listRules();
      expect(rulesBefore[0].id).toBe('r-grouped');
      expect(rulesBefore[1].id).toBe('r-target');

      // Move r-target to group g-high (priority 10)
      await store.moveRuleToGroup('r-target', 'g-high');

      // Verify the UPDATE was issued with the right group
      const moveCalls = vi.mocked(db.run).mock.calls;
      expect(moveCalls.some(call => call.includes('r-target') && call.includes('g-high'))).toBe(true);

      // After: rule is in group g-high (priority 10) → listed first
      vi.mocked(db.all).mockResolvedValueOnce([
        makeRuleRow({ id: 'r-target', group_id: 'g-high', group_priority: 10 }),
        makeRuleRow({ id: 'r-grouped', group_id: 'g1', group_priority: 5 }),
      ]);

      const rulesAfter = await store.listRules();
      expect(rulesAfter[0].id).toBe('r-target');
      expect(rulesAfter[1].id).toBe('r-grouped');
    });
  });

  describe('reorderGroups', () => {
    it('reassigns sequential priority values from provided order', async () => {
      await store.reorderGroups(['g3', 'g1', 'g2']);

      const updateCalls = vi.mocked(db.run).mock.calls;
      // g3 should get highest priority (3), g2 should get lowest (1)
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

    it('creates rules with group_id = null (auto-generated rules are ungrouped)', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([makeTxnRow('Acme Corp', 'node-1')])
        .mockResolvedValueOnce([]);

      await store.generate_rules_preview();

      const insertCall = vi.mocked(db.run).mock.calls[0];
      // group_id should be null in the insert
      expect(insertCall).toContain(null);
      // source should be auto_generated
      expect(insertCall).toContain('auto_generated');
    });

    it('skips suppliers that already have a rule', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([makeTxnRow('Acme Corp', 'node-1'), makeTxnRow('NewCo', 'node-2')])
        .mockResolvedValueOnce([makeExistingRuleRow('Acme Corp')]);

      const result = await store.generate_rules_preview();

      expect(result.rulesCreated).toBe(1);
      expect(result.suppliersProcessed).toBe(1);
      expect(db.run).toHaveBeenCalledTimes(1);
    });

    it('returns zero counts when all suppliers already have rules', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([makeTxnRow('Acme Corp', 'node-1')])
        .mockResolvedValueOnce([makeExistingRuleRow('Acme Corp')]);

      const result = await store.generate_rules_preview();

      expect(result.rulesCreated).toBe(0);
      expect(result.suppliersProcessed).toBe(0);
      expect(db.run).not.toHaveBeenCalled();
    });

    it('creates rules for all suppliers when no existing rules', async () => {
      vi.mocked(db.all)
        .mockResolvedValueOnce([makeTxnRow('Acme Corp', 'node-1'), makeTxnRow('NewCo', 'node-2')])
        .mockResolvedValueOnce([]);

      const result = await store.generate_rules_preview();

      expect(result.rulesCreated).toBe(2);
      expect(result.suppliersProcessed).toBe(2);
    });
  });
});
