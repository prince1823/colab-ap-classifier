import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionStore } from '../../../src/main/services/transactions';
import { createMockDatabase, createMockChangelogStore } from '../../helpers/mock-services';
import type { Database, ChangelogStore } from '../../../src/shared/types/services';

describe('TransactionStore', () => {
  let db: Database;
  let changelog: ChangelogStore;
  let store: TransactionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    changelog = createMockChangelogStore();
    store = new TransactionStore(db, changelog);
    store.invalidateColumnCache();
  });

  describe('getColumns', () => {
    it('should return column names from information_schema', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
        { column_name: 'project_supplier_id' },
      ]);

      const columns = await store.getColumns();
      expect(columns).toEqual([
        'id', 'row_index', 'project_supplier_id',
        // virtual columns appended by getColumns()
        'supplier_name', 'is_tail_spend',
        'classification_l1', 'classification_l2', 'classification_l3',
        'classification_path', 'applied_rule_name',
      ]);
      expect(db.all).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.columns')
      );
    });
  });

  describe('getStats', () => {
    it('should return aggregate stats', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
        { column_name: 'spend_amount' },
        { column_name: 'project_supplier_id' },
        { column_name: 'taxonomy_node_id' },
        { column_name: 'classification_status' },
      ]);

      vi.mocked(db.get).mockResolvedValueOnce({
        total_rows: 100,
        total_spend: 50000,
        unique_suppliers: 25,
        classified_rows: 80,
        unclassified_rows: 20,
      });

      const stats = await store.getStats();
      expect(stats.totalRows).toBe(100);
      expect(stats.totalSpend).toBe(50000);
      expect(stats.uniqueSuppliers).toBe(25);
      expect(stats.classifiedRows).toBe(80);
      expect(stats.unclassifiedRows).toBe(20);
    });

    it('should handle missing spend and supplier columns', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
      ]);

      vi.mocked(db.get).mockResolvedValueOnce({
        total_rows: 10,
        total_spend: 0,
        unique_suppliers: 0,
        classified_rows: 0,
        unclassified_rows: 10,
      });

      const stats = await store.getStats();
      expect(stats.totalRows).toBe(10);
      expect(stats.totalSpend).toBe(0);
      expect(stats.uniqueSuppliers).toBe(0);
    });
  });

  describe('queryTransactions', () => {
    beforeEach(() => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema')) {
          return [
            { column_name: 'id' },
            { column_name: 'row_index' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'classification_status' },
            { column_name: 'created_at' },
            { column_name: 'updated_at' },
            { column_name: 'project_supplier_id' },
            { column_name: 'spend_amount' },
          ];
        }
        return [
          {
            id: 'tx1',
            row_index: 0,
            taxonomy_node_id: 'tid1',
            classification_path: 'Indirect|IT|Software',
            classification_status: 'classified_by_ai',
            supplier_name: 'Acme',
            spend_amount: 1000,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      });
    });

    it('should return mapped transactions', async () => {
      const result = await store.queryTransactions();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tx1');
      expect(result[0].rowIndex).toBe(0);
      expect(result[0].taxonomyNodeId).toBe('tid1');
    });

    it('should apply supplier name filter', async () => {
      await store.queryTransactions({ supplierName: 'Acme' });

      const selectCall = vi.mocked(db.all).mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(selectCall).toBeDefined();
      expect(String(selectCall![0])).toContain('supplier_name = ?');
    });

    it('should apply taxonomy node filter', async () => {
      await store.queryTransactions({ taxonomyNodeId: 'tid1' });

      const selectCall = vi.mocked(db.all).mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('taxonomy_node_id = ?');
    });

    it('should apply spend range filter', async () => {
      await store.queryTransactions({ spendMin: 100, spendMax: 5000 });

      const selectCall = vi.mocked(db.all).mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('spend_amount AS DOUBLE) >= ?');
      expect(String(selectCall![0])).toContain('spend_amount AS DOUBLE) <= ?');
    });

    it('should apply custom pagination', async () => {
      await store.queryTransactions({ page: 3, pageSize: 25 });

      const selectCall = vi.mocked(db.all).mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('LIMIT 25 OFFSET 50');
    });
  });

  describe('applyRule', () => {
    const grouped = {
      groupConnector: 'AND' as const,
      groups: [{ connector: 'AND' as const, conditions: [{ field: 'supplier_name', operator: 'equals' as const, value: 'Acme' }] }],
    };

    it('throws if the rule id does not exist', async () => {
      vi.mocked(db.get).mockResolvedValueOnce(null); // rule not found

      await expect(store.applyRule('nonexistent-id', grouped, 'node-1'))
        .rejects.toThrow('Rule not found: nonexistent-id');
    });

    it('returns 0 and skips update when no transactions match', async () => {
      vi.mocked(db.get).mockResolvedValueOnce({ id: 'rule-1' }); // rule exists
      // getIdsByGroupedConditions → db.all returns empty
      vi.mocked(db.all).mockResolvedValueOnce([]);

      const count = await store.applyRule('rule-1', grouped, 'node-1');
      expect(count).toBe(0);
      // updateTransactions should not have been called
      const updateCall = vi.mocked(db.run).mock.calls.find(c =>
        String(c[0]).includes('UPDATE transactions')
      );
      expect(updateCall).toBeUndefined();
    });

    it('updates matching transactions with classified_by_rule status and correct source', async () => {
      vi.mocked(db.get).mockResolvedValueOnce({ id: 'rule-1' }); // rule exists
      vi.mocked(db.all)
        .mockResolvedValueOnce([{ id: 'tx-1' }, { id: 'tx-2' }]) // getIdsByGroupedConditions
        .mockResolvedValueOnce([]) // supplier names in changelog
      vi.mocked(db.get)
        .mockResolvedValueOnce({ id: 'rule-1' }) // rule exists (first call above already consumed)

      // Re-setup: rule exists check, then matched ids, then changelog queries
      vi.mocked(db.get).mockReset();
      vi.mocked(db.all).mockReset();
      vi.mocked(db.run).mockReset();

      vi.mocked(db.get).mockResolvedValueOnce({ id: 'rule-1' }); // rule lookup
      vi.mocked(db.all)
        .mockResolvedValueOnce([{ id: 'tx-1' }, { id: 'tx-2' }]) // getIdsByGroupedConditions
        .mockResolvedValueOnce([]) // supplier names for changelog
      vi.mocked(db.get).mockResolvedValueOnce(null); // taxonomy path (optional)

      const count = await store.applyRule('rule-1', grouped, 'node-1');
      expect(count).toBe(2);

      const updateCall = vi.mocked(db.run).mock.calls.find(c =>
        String(c[0]).includes('UPDATE transactions SET')
      );
      expect(updateCall).toBeDefined();
      expect(String(updateCall![0])).toContain('classification_status = ?');
      expect(String(updateCall![0])).toContain('applied_rule_id = ?');
      // Verify classified_by_rule and ruleId appear in params
      expect(updateCall!).toContain('classified_by_rule');
      expect(updateCall!).toContain('rule-1');
    });
  });
});
