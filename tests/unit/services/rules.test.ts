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

vi.mock('../../../src/main/services/colabip', () => ({
  readRulePack: vi.fn(),
}));

vi.mock('../../../src/main/services/taxonomy', () => ({
  getNodes: vi.fn(),
}));

vi.mock('../../../src/main/services/suppliers', () => ({
  listSuppliers: vi.fn(),
}));

import { listRules, createRule, updateRule, deleteRule, importFromColabip, evaluateRules, syncRulesFromSources } from '../../../src/main/services/rules';
import { readRulePack } from '../../../src/main/services/colabip';
import * as taxonomyService from '../../../src/main/services/taxonomy';
import * as supplierService from '../../../src/main/services/suppliers';

describe('RulesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRules', () => {
    it('should return rules sorted by priority', async () => {
      mockAll.mockResolvedValue([
        { id: '1', name: 'Rule 1', source: 'project', conditions: '[]', target_taxonomy_node_id: 'tid1', priority_score: 100, is_active: true, imported_at: null, created_at: '2026-01-01' },
        { id: '2', name: 'Rule 2', source: 'taxonomy', conditions: '[{"field":"supplier_name","operator":"equals","value":"Test"}]', target_taxonomy_node_id: 'tid2', priority_score: 200, is_active: true, imported_at: null, created_at: '2026-01-01' },
      ]);

      const rules = await listRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].name).toBe('Rule 1');
      expect(rules[1].conditions).toEqual([{ field: 'supplier_name', operator: 'equals', value: 'Test' }]);
    });
  });

  describe('createRule', () => {
    it('should create a rule with auto-assigned priority', async () => {
      mockGet.mockResolvedValue({ cnt: 2 });
      mockRun.mockResolvedValue(undefined);

      const result = await createRule({
        name: 'Test Rule',
        conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
        targetTaxonomyNodeId: 'tid1',
      });

      expect(result.id).toBeDefined();
      expect(mockRun).toHaveBeenCalled();
      const args = mockRun.mock.calls[0];
      expect(args[2]).toBe('Test Rule');
      expect(args[3]).toBe('project');
    });

    it('should use provided priority score', async () => {
      mockRun.mockResolvedValue(undefined);

      await createRule({
        name: 'Custom', conditions: [], targetTaxonomyNodeId: 'tid1', priorityScore: 150,
      });

      const args = mockRun.mock.calls[0];
      expect(args[6]).toBe(150);
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
  });

  describe('deleteRule', () => {
    it('should delete by id', async () => {
      mockRun.mockResolvedValue(undefined);
      await deleteRule('rule1');
      expect(mockRun).toHaveBeenCalledWith('DELETE FROM override_rules WHERE id = ?', 'rule1');
    });
  });

  describe('importFromColabip', () => {
    it('should import rules and match taxonomy paths', async () => {
      vi.mocked(readRulePack).mockResolvedValue([
        { name: 'IT Rule', conditions: [{ field: 'gl_description', operator: 'contains', value: 'software' }], targetPath: 'Indirect|IT|Software', priorityScore: 0 },
      ]);
      vi.mocked(taxonomyService.getNodes).mockResolvedValue([
        { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT' },
      ]);
      mockGet.mockResolvedValue({ cnt: 0 });
      mockRun.mockResolvedValue(undefined);

      const result = await importFromColabip('general');

      expect(result.imported).toBe(1);
    });
  });

  describe('evaluateRules', () => {
    it('should match transactions with first-match-wins', async () => {
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM override_rules')) {
          return [
            { id: 'r1', name: 'Rule 1', source: 'project', conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]', target_taxonomy_node_id: 'tid1', priority_score: 100, is_active: true, imported_at: null, created_at: '' },
          ];
        }
        if (sql.includes('FROM transactions')) {
          return [{ id: 'tx1' }, { id: 'tx2' }];
        }
        return [];
      });

      const result = await evaluateRules();
      expect(result.get('tx1')).toBe('r1');
      expect(result.get('tx2')).toBe('r1');
    });
  });

  describe('syncRulesFromSources', () => {
    it('should delete and rebuild taxonomy/supplier rules', async () => {
      mockRun.mockResolvedValue(undefined);
      mockGet.mockResolvedValue({ cnt: 0 });
      vi.mocked(supplierService.listSuppliers).mockResolvedValue([
        {
          id: 's1', supplierName: 'Cat A Supplier', parentSupplierId: null,
          supplierInfo: null, categoryA: true,
          categoryATaxonomyNodeId: 'tid1', transactionCount: 10, totalSpend: 5000,
          createdAt: '', updatedAt: '',
        },
      ]);

      await syncRulesFromSources();

      expect(mockRun).toHaveBeenCalledWith(
        "DELETE FROM override_rules WHERE source IN ('taxonomy', 'supplier')"
      );
      // Should have created a supplier rule
      const insertCalls = mockRun.mock.calls.filter((c) => String(c[0]).includes('INSERT'));
      expect(insertCalls.length).toBe(1);
    });
  });
});
