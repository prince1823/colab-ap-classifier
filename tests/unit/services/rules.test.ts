import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleStore } from '../../../src/main/services/rules';
import { createMockDatabase, createMockTransactionStore, createMockProjectStore } from '../../helpers/mock-services';
import type { Database, TransactionStore, ProjectStore } from '../../../src/shared/types/services';

function makeRuleRow(overrides: Partial<{
  id: string; name: string; grouped_conditions: string;
  target_taxonomy_node_id: string; priority: number;
  is_active: boolean; source: string; created_at: string;
}> = {}) {
  return {
    id: 'r1',
    name: 'Rule 1',
    grouped_conditions: JSON.stringify({ groupConnector: 'AND', groups: [] }),
    target_taxonomy_node_id: 'tid1',
    priority: 1,
    is_active: true,
    source: 'manual',
    created_at: '2026-01-01T00:00:00',
    ...overrides,
  };
}

function makeExistingRuleRow(supplierName: string) {
  return {
    grouped_conditions: JSON.stringify({
      groupConnector: 'AND',
      groups: [{ connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: supplierName }] }],
    }),
  };
}

function makeTxnRow(supplierName: string, taxonomyNodeId: string) {
  return { id: 'tx-1', supplier_name: supplierName, taxonomy_node_id: taxonomyNodeId, full_path: 'L1|L2|L3' };
}

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

  describe('listRules', () => {
    it('returns rules with priorityScore set to stored priority', async () => {
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', name: 'Rule 1', priority: 1 }),
        makeRuleRow({ id: 'r2', name: 'Rule 2', priority: 2 }),
      ]);

      const rules = await store.listRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].priorityScore).toBe(1);
      expect(rules[1].priorityScore).toBe(2);
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

    it('orders by priority ASC, created_at DESC (same-priority tie-break)', async () => {
      // DB returns rows in the order the SQL would (simulated here)
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r-newer', priority: 5, created_at: '2026-03-01T00:00:00' }),
        makeRuleRow({ id: 'r-older', priority: 5, created_at: '2026-01-01T00:00:00' }),
      ]);

      const rules = await store.listRules();
      // Newer rule (same priority, later created_at) should appear first
      expect(rules[0].id).toBe('r-newer');
      expect(rules[1].id).toBe('r-older');

      // Verify the SQL passes the right ORDER BY clause
      const sql = vi.mocked(db.all).mock.calls[0][0] as string;
      expect(sql).toContain('priority ASC');
      expect(sql).toContain('created_at DESC');
    });
  });

  describe('createRule', () => {
    it('auto-assigns priority as MAX+1 when not provided', async () => {
      vi.mocked(db.get).mockResolvedValue({ max_priority: 3 });

      await store.createRule({
        name: 'Test Rule',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
      });

      expect(db.get).toHaveBeenCalled();
      const insertCall = vi.mocked(db.run).mock.calls[0];
      const priorityArg = insertCall[5]; // 6th param: id, name, grouped_conditions, target_taxonomy_node_id, priority, ...
      expect(priorityArg).toBe(4);
    });

    it('uses provided priorityScore directly', async () => {
      await store.createRule({
        name: 'Custom',
        groupedConditions: { groupConnector: 'AND', groups: [] },
        targetTaxonomyNodeId: 'tid1',
        priorityScore: 7,
      });

      expect(db.get).not.toHaveBeenCalled();
      const insertCall = vi.mocked(db.run).mock.calls[0];
      const priorityArg = insertCall[5];
      expect(priorityArg).toBe(7);
    });

    it('returns an object with a generated id', async () => {
      vi.mocked(db.get).mockResolvedValue({ max_priority: 0 });

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
      vi.mocked(db.get).mockResolvedValue({ max_priority: 1 });

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

  describe('updateRule', () => {
    it('updates specified fields', async () => {
      await store.updateRule('rule1', { name: 'Updated', isActive: false });

      expect(db.run).toHaveBeenCalled();
      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('name = ?');
      expect(sql).toContain('is_active = ?');
    });

    it('does nothing with empty updates', async () => {
      await store.updateRule('rule1', {});
      expect(db.run).not.toHaveBeenCalled();
    });

    it('stores priorityScore as integer, rounding floats', async () => {
      await store.updateRule('rule1', { priorityScore: 2.7 });

      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('priority = ?');
      const params = vi.mocked(db.run).mock.calls[0].slice(1);
      const priorityArg = params[0];
      expect(priorityArg).toBe(3);
    });

    it('updates groupedConditions as JSON string', async () => {
      const newConditions = { groupConnector: 'AND' as const, groups: [] };
      await store.updateRule('rule1', { groupedConditions: newConditions });

      const sql = vi.mocked(db.run).mock.calls[0][0] as string;
      expect(sql).toContain('grouped_conditions = ?');
    });
  });

  describe('deleteRule', () => {
    it('deletes by id', async () => {
      await store.deleteRule('rule1');
      expect(db.run).toHaveBeenCalledWith('DELETE FROM override_rules WHERE id = ?', 'rule1');
    });
  });

  describe('evaluateRules', () => {
    it('matches transactions with first-match-wins', async () => {
      const grouped = {
        groupConnector: 'AND',
        groups: [{ connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }] }],
      };
      vi.mocked(db.all).mockResolvedValue([
        makeRuleRow({ id: 'r1', grouped_conditions: JSON.stringify(grouped), target_taxonomy_node_id: 'tid1' }),
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
  });

  describe('generate_rules_preview', () => {
    beforeEach(() => {
      vi.mocked(project.getSetting).mockResolvedValue(['gl_description'] as any);
      vi.mocked(transactions.getColumns).mockResolvedValue(['gl_description']);
      vi.mocked(db.get).mockResolvedValue({ max_priority: 0 });
      vi.mocked(db.run).mockResolvedValue(undefined as any);
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
