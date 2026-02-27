import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRun = vi.fn();
const mockAll = vi.fn();
const mockGet = vi.fn();

vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    run: (...args: unknown[]) => mockRun(...args),
    all: (...args: unknown[]) => mockAll(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

const mockBuildWhereClause = vi.fn();

vi.mock('../../../src/main/services/transactions', () => ({
  buildWhereClause: (...args: unknown[]) => mockBuildWhereClause(...args),
}));

import { listRules, createRule, updateRule, deleteRule, evaluateRules } from '../../../src/main/services/rules';

describe('RulesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRules', () => {
    it('should return rules sorted by priority', async () => {
      mockAll.mockResolvedValue([
        { id: '1', name: 'Rule 1', conditions: '[]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: true, created_at: '2026-01-01' },
        { id: '2', name: 'Rule 2', conditions: '[{"field":"supplier_name","operator":"equals","value":"Test"}]', target_taxonomy_node_id: 'tid2', priority_score: 2, is_active: true, created_at: '2026-01-01' },
      ]);

      const rules = await listRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].name).toBe('Rule 1');
      expect(rules[0].priorityScore).toBe(1);
      expect(rules[1].conditions).toEqual([{ field: 'supplier_name', operator: 'equals', value: 'Test' }]);
    });

    it('should parse JSON conditions from string', async () => {
      mockAll.mockResolvedValue([
        { id: '1', name: 'R', conditions: '[{"field":"gl_description","operator":"contains","value":"cloud"}]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: true, created_at: '2026-01-01' },
      ]);

      const rules = await listRules();
      expect(rules[0].conditions).toEqual([{ field: 'gl_description', operator: 'contains', value: 'cloud' }]);
    });

    it('should return empty array when no rules exist', async () => {
      mockAll.mockResolvedValue([]);
      const rules = await listRules();
      expect(rules).toHaveLength(0);
    });
  });

  describe('createRule', () => {
    it('should create a rule with auto-assigned priority', async () => {
      // getNextPriority queries MAX(priority_score) — return 2 so next is 3
      mockGet.mockResolvedValue({ max_priority: 2 });
      mockRun.mockResolvedValue(undefined);

      const result = await createRule({
        name: 'Test Rule',
        conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
        targetTaxonomyNodeId: 'tid1',
      });

      expect(result.id).toBeDefined();
      expect(mockRun).toHaveBeenCalled();
      const args = mockRun.mock.calls[0];
      // args: [sql, id, name, conditions_json, target_taxonomy_node_id, priority_score]
      expect(args[2]).toBe('Test Rule');
      expect(JSON.parse(args[3])).toEqual([{ field: 'supplier_name', operator: 'equals', value: 'Acme' }]);
      expect(args[4]).toBe('tid1');
      expect(args[5]).toBe(3); // MAX(2) + 1
    });

    it('should auto-assign priority 1 when no rules exist', async () => {
      mockGet.mockResolvedValue({ max_priority: null });
      mockRun.mockResolvedValue(undefined);

      await createRule({
        name: 'First Rule',
        conditions: [],
        targetTaxonomyNodeId: 'tid1',
      });

      const args = mockRun.mock.calls[0];
      expect(args[5]).toBe(1); // (null ?? 0) + 1
    });

    it('should use provided priority score', async () => {
      mockRun.mockResolvedValue(undefined);

      await createRule({
        name: 'Custom', conditions: [], targetTaxonomyNodeId: 'tid1', priorityScore: 5,
      });

      const args = mockRun.mock.calls[0];
      // args: [sql, id, name, conditions_json, target_taxonomy_node_id, priority_score]
      expect(args[5]).toBe(5);
      // Should NOT call mockGet when priority is provided
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should return an object with the generated id', async () => {
      mockGet.mockResolvedValue({ max_priority: 0 });
      mockRun.mockResolvedValue(undefined);

      const result = await createRule({
        name: 'R', conditions: [], targetTaxonomyNodeId: 'tid1',
      });

      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });
  });

  describe('updateRule', () => {
    it('should update specified fields', async () => {
      mockRun.mockResolvedValue(undefined);

      await updateRule('rule1', { name: 'Updated', isActive: false });

      expect(mockRun).toHaveBeenCalled();
      const sql = mockRun.mock.calls[0][0];
      expect(sql).toContain('name = ?');
      expect(sql).toContain('is_active = ?');
    });

    it('should do nothing with empty updates', async () => {
      await updateRule('rule1', {});
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should update conditions as JSON string', async () => {
      mockRun.mockResolvedValue(undefined);
      const newConditions = [{ field: 'supplier_name', operator: 'equals' as const, value: 'NewCo' }];

      await updateRule('rule1', { conditions: newConditions });

      const sql = mockRun.mock.calls[0][0];
      expect(sql).toContain('conditions = ?');
      // conditions param should be JSON-stringified
      expect(mockRun.mock.calls[0][1]).toBe(JSON.stringify(newConditions));
    });

    it('should update priority score', async () => {
      mockRun.mockResolvedValue(undefined);

      await updateRule('rule1', { priorityScore: 10 });

      const sql = mockRun.mock.calls[0][0];
      expect(sql).toContain('priority_score = ?');
      expect(mockRun.mock.calls[0][1]).toBe(10);
    });

    it('should update target taxonomy node id', async () => {
      mockRun.mockResolvedValue(undefined);

      await updateRule('rule1', { targetTaxonomyNodeId: 'new-tid' });

      const sql = mockRun.mock.calls[0][0];
      expect(sql).toContain('target_taxonomy_node_id = ?');
      expect(mockRun.mock.calls[0][1]).toBe('new-tid');
    });
  });

  describe('deleteRule', () => {
    it('should delete by id', async () => {
      mockRun.mockResolvedValue(undefined);
      await deleteRule('rule1');
      expect(mockRun).toHaveBeenCalledWith('DELETE FROM override_rules WHERE id = ?', 'rule1');
    });
  });

  describe('evaluateRules', () => {
    it('should match transactions with first-match-wins', async () => {
      // listRules returns active rules
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM override_rules')) {
          return [
            { id: 'r1', name: 'Rule 1', conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: true, created_at: '' },
          ];
        }
        if (sql.includes('FROM transactions')) {
          return [{ id: 'tx1' }, { id: 'tx2' }];
        }
        return [];
      });

      // buildWhereClause returns a SQL fragment for the rule conditions
      mockBuildWhereClause.mockReturnValue({
        sql: 'supplier_name = ?',
        params: ['Acme'],
      });

      const result = await evaluateRules();
      expect(result.get('tx1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
      expect(result.get('tx2')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('should skip rules where buildWhereClause returns null', async () => {
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM override_rules')) {
          return [
            { id: 'r1', name: 'Empty Rule', conditions: '[]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: true, created_at: '' },
          ];
        }
        return [];
      });

      mockBuildWhereClause.mockReturnValue(null);

      const result = await evaluateRules();
      expect(result.size).toBe(0);
    });

    it('should skip inactive rules', async () => {
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM override_rules')) {
          return [
            { id: 'r1', name: 'Inactive', conditions: '[{"field":"supplier_name","operator":"equals","value":"X"}]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: false, created_at: '' },
          ];
        }
        return [];
      });

      mockBuildWhereClause.mockReturnValue({ sql: 'supplier_name = ?', params: ['X'] });

      const result = await evaluateRules();
      expect(result.size).toBe(0);
      // buildWhereClause should not be called since the rule is inactive
      expect(mockBuildWhereClause).not.toHaveBeenCalled();
    });

    it('should respect first-match-wins across multiple rules', async () => {
      let callCount = 0;
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM override_rules')) {
          return [
            { id: 'r1', name: 'Rule 1', conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: true, created_at: '' },
            { id: 'r2', name: 'Rule 2', conditions: '[{"field":"supplier_name","operator":"contains","value":"Acme"}]', target_taxonomy_node_id: 'tid2', priority_score: 2, is_active: true, created_at: '' },
          ];
        }
        if (sql.includes('FROM transactions')) {
          callCount++;
          if (callCount === 1) {
            // First rule matches tx1
            return [{ id: 'tx1' }];
          }
          // Second rule matches tx1 and tx2
          return [{ id: 'tx1' }, { id: 'tx2' }];
        }
        return [];
      });

      mockBuildWhereClause.mockReturnValue({ sql: 'supplier_name = ?', params: ['Acme'] });

      const result = await evaluateRules();
      // tx1 matched by r1 first, so it stays as r1
      expect(result.get('tx1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
      // tx2 only matched by r2
      expect(result.get('tx2')).toEqual({ ruleId: 'r2', targetTaxonomyNodeId: 'tid2' });
    });

    it('should filter by transaction IDs when provided', async () => {
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM override_rules')) {
          return [
            { id: 'r1', name: 'Rule 1', conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]', target_taxonomy_node_id: 'tid1', priority_score: 1, is_active: true, created_at: '' },
          ];
        }
        if (sql.includes('FROM transactions')) {
          // Verify the SQL includes the IN clause for transactionIds
          expect(sql).toContain('AND id IN');
          return [{ id: 'tx1' }];
        }
        return [];
      });

      mockBuildWhereClause.mockReturnValue({ sql: 'supplier_name = ?', params: ['Acme'] });

      const result = await evaluateRules(['tx1', 'tx3']);
      expect(result.get('tx1')).toEqual({ ruleId: 'r1', targetTaxonomyNodeId: 'tid1' });
    });

    it('should return empty map when no rules exist', async () => {
      mockAll.mockResolvedValue([]);

      const result = await evaluateRules();
      expect(result.size).toBe(0);
    });
  });
});
