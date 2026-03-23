import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleStore } from '../../../src/main/services/rules';
import { createMockDatabase, createMockTransactionStore, createMockProjectStore } from '../../helpers/mock-services';
import type { Database, TransactionStore, ProjectStore } from '../../../src/shared/types/services';

// Minimal transaction rows for generate_rules_preview tests
function makeTxnRow(supplierName: string, taxonomyNodeId: string) {
  return { id: 'tx-1', supplier_name: supplierName, taxonomy_node_id: taxonomyNodeId, full_path: 'L1|L2|L3' };
}

// Existing rule row with a supplier_name condition in grouped_conditions JSON
function makeExistingRuleRow(supplierName: string) {
  return {
    name: supplierName,
    grouped_conditions: JSON.stringify({
      groupConnector: 'AND',
      groups: [{ connector: 'AND', conditions: [{ field: 'supplier_name', operator: 'equals', value: supplierName }] }],
    }),
  };
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
    it('should return rules sorted by priority', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { id: '1', name: 'Rule 1', conditions: '[]', target_taxonomy_node_id: 'tid1', priority: 1, is_active: true, created_at: '2026-01-01' },
        { id: '2', name: 'Rule 2', conditions: '[{"field":"supplier_name","operator":"equals","value":"Test"}]', target_taxonomy_node_id: 'tid2', priority: 2, is_active: true, created_at: '2026-01-01' },
      ]);

      const rules = await store.listRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].name).toBe('Rule 1');
      expect(rules[0].priorityScore).toBe(1);
      expect(rules[1].conditions).toEqual([{ field: 'supplier_name', operator: 'equals', value: 'Test' }]);
    });

    it('should parse JSON conditions from string', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { id: '1', name: 'R', conditions: '[{"field":"gl_description","operator":"contains","value":"cloud"}]', target_taxonomy_node_id: 'tid1', priority_score: 1, source: 'project', is_active: true, created_at: '2026-01-01' },
      ]);

      const rules = await store.listRules();
      expect(rules[0].conditions).toEqual([{ field: 'gl_description', operator: 'contains', value: 'cloud' }]);
    });

    it('should return empty array when no rules exist', async () => {
      vi.mocked(db.all).mockResolvedValue([]);
      const rules = await store.listRules();
      expect(rules).toHaveLength(0);
    });
  });

  describe('createRule', () => {
    it('should create a rule with auto-assigned priority', async () => {
      vi.mocked(db.get).mockResolvedValue({ max_priority: 2 });

      const result = await store.createRule({
        name: 'Test Rule',
        conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
        targetTaxonomyNodeId: 'tid1',
      });

      expect(result.id).toBeDefined();
      expect(db.run).toHaveBeenCalled();
    });

    it('should use provided priority score', async () => {
      await store.createRule({
        name: 'Custom', conditions: [], targetTaxonomyNodeId: 'tid1', priorityScore: 5,
      });

      expect(db.run).toHaveBeenCalled();
      expect(db.get).not.toHaveBeenCalled();
    });

    it('should return an object with the generated id', async () => {
      vi.mocked(db.get).mockResolvedValue({ max_priority: 0 });

      const result = await store.createRule({
        name: 'R', conditions: [], targetTaxonomyNodeId: 'tid1',
      });

      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });
  });

  describe('updateRule', () => {
    it('should update specified fields', async () => {
      await store.updateRule('rule1', { name: 'Updated', isActive: false });

      expect(db.run).toHaveBeenCalled();
      const sql = vi.mocked(db.run).mock.calls[0][0];
      expect(sql).toContain('name = ?');
      expect(sql).toContain('is_active = ?');
    });

    it('should do nothing with empty updates', async () => {
      await store.updateRule('rule1', {});
      expect(db.run).not.toHaveBeenCalled();
    });

    it('should update conditions as JSON string', async () => {
      const newConditions = [{ field: 'supplier_name', operator: 'equals' as const, value: 'NewCo' }];
      await store.updateRule('rule1', { conditions: newConditions });

      const sql = vi.mocked(db.run).mock.calls[0][0];
      expect(sql).toContain('conditions = ?');
    });
  });

  describe('deleteRule', () => {
    it('should delete by id', async () => {
      await store.deleteRule('rule1');
      expect(db.run).toHaveBeenCalledWith('DELETE FROM override_rules WHERE id = ?', 'rule1');
    });
  });

  describe('generate_rules_preview', () => {
    beforeEach(() => {
      vi.mocked(project.getSetting).mockResolvedValue(['gl_description'] as any);
      vi.mocked(transactions.getColumns).mockResolvedValue(['gl_description']);
      vi.mocked(db.get).mockResolvedValue({ max_priority: 0 });
      vi.mocked(db.run).mockResolvedValue(undefined as any);
    });

    it('skips suppliers that already have a rule and only creates rules for new ones', async () => {
      // db.all called twice: (1) eligible transactions, (2) existing rules
      vi.mocked(db.all)
        .mockResolvedValueOnce([
          makeTxnRow('Acme Corp', 'node-1'),
          makeTxnRow('NewCo', 'node-2'),
        ])
        .mockResolvedValueOnce([makeExistingRuleRow('Acme Corp')]);

      const result = await store.generate_rules_preview();

      expect(result.rulesCreated).toBe(1);
      expect(result.suppliersProcessed).toBe(1);
      // createRule is called once (only for NewCo)
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
        .mockResolvedValueOnce([]); // no existing rules

      const result = await store.generate_rules_preview();

      expect(result.rulesCreated).toBe(2);
      expect(result.suppliersProcessed).toBe(2);
    });
  });

  describe('evaluateRules', () => {
    it('should match transactions with first-match-wins', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { id: 'r1', name: 'Rule 1', conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]', target_taxonomy_node_id: 'tid1', priority: 1, source: 'project', is_active: true, created_at: '' },
      ]);
      vi.mocked(transactions.getIdsByConditions).mockResolvedValue(['tx1', 'tx2']);

      const result = await store.evaluateRules();
      expect(result.get('tx1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
      expect(result.get('tx2')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
      expect(transactions.getIdsByConditions).toHaveBeenCalledWith(
        [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
        undefined
      );
    });

    it('should return empty map when no rules exist', async () => {
      vi.mocked(db.all).mockResolvedValue([]);

      const result = await store.evaluateRules();
      expect(result.size).toBe(0);
    });
  });
});
