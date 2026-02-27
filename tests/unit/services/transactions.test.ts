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

vi.mock('../../../src/main/services/changelog', () => ({
  logChange: vi.fn(),
}));

import { queryTransactions, getStats, getColumns, invalidateColumnCache } from '../../../src/main/services/transactions';

describe('TransactionsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateColumnCache();
  });

  describe('getColumns', () => {
    it('should return column names from information_schema', async () => {
      mockAll.mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
        { column_name: 'supplier_name' },
      ]);

      const columns = await getColumns();
      expect(columns).toEqual(['id', 'row_index', 'supplier_name']);
      expect(mockAll).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.columns')
      );
    });
  });

  describe('getStats', () => {
    it('should return aggregate stats', async () => {
      // getColumns call
      mockAll.mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
        { column_name: 'spend_amount' },
        { column_name: 'supplier_name' },
        { column_name: 'taxonomy_node_id' },
        { column_name: 'classification_status' },
      ]);

      // v2: single aggregation query
      mockGet.mockResolvedValueOnce({
        total_rows: 100,
        total_spend: 50000,
        unique_suppliers: 25,
        classified_rows: 80,
        unclassified_rows: 20,
      });

      const stats = await getStats();
      expect(stats.totalRows).toBe(100);
      expect(stats.totalSpend).toBe(50000);
      expect(stats.uniqueSuppliers).toBe(25);
      expect(stats.classifiedRows).toBe(80);
      expect(stats.unclassifiedRows).toBe(20);
    });

    it('should handle missing spend and supplier columns', async () => {
      mockAll.mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
      ]);

      // v2: single aggregation query with 0 expressions for missing columns
      mockGet.mockResolvedValueOnce({
        total_rows: 10,
        total_spend: 0,
        unique_suppliers: 0,
        classified_rows: 0,
        unclassified_rows: 10,
      });

      const stats = await getStats();
      expect(stats.totalRows).toBe(10);
      expect(stats.totalSpend).toBe(0);
      expect(stats.uniqueSuppliers).toBe(0);
    });
  });

  describe('queryTransactions', () => {
    beforeEach(() => {
      // Default: getColumns returns base + supplier_name + spend_amount
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema')) {
          return [
            { column_name: 'id' },
            { column_name: 'row_index' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'classification_status' },
            { column_name: 'classification_reasoning' },
            { column_name: 'created_at' },
            { column_name: 'updated_at' },
            { column_name: 'supplier_name' },
            { column_name: 'spend_amount' },
          ];
        }
        // Default query result
        return [
          {
            id: 'tx1',
            row_index: 0,
            taxonomy_node_id: 'tid1',
            classification_path: 'Indirect|IT|Software',
            classification_status: 'classified_by_ai',
            classification_reasoning: null,
            supplier_name: 'Acme',
            spend_amount: 1000,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      });
    });

    it('should return mapped transactions', async () => {
      const result = await queryTransactions();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tx1');
      expect(result[0].rowIndex).toBe(0);
      expect(result[0].taxonomyNodeId).toBe('tid1');
      expect(result[0].classificationPath).toBe('Indirect|IT|Software');
      expect(result[0].classificationStatus).toBe('classified_by_ai');
      expect(result[0].canonicalFields).toEqual({
        supplier_name: 'Acme',
        spend_amount: 1000,
      });
    });

    it('should apply supplier name filter', async () => {
      await queryTransactions({ supplierName: 'Acme' });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(selectCall).toBeDefined();
      expect(String(selectCall![0])).toContain('supplier_name = ?');
    });

    it('should apply taxonomy node filter', async () => {
      await queryTransactions({ taxonomyNodeId: 'tid1' });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('taxonomy_node_id = ?');
    });

    it('should apply spend range filter', async () => {
      await queryTransactions({ spendMin: 100, spendMax: 5000 });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('spend_amount >= ?');
      expect(String(selectCall![0])).toContain('spend_amount <= ?');
    });

    it('should return all rows when no pageSize specified', async () => {
      await queryTransactions();

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).not.toContain('LIMIT');
      expect(String(selectCall![0])).not.toContain('OFFSET');
    });

    it('should apply custom pagination', async () => {
      await queryTransactions({ page: 3, pageSize: 25 });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('LIMIT 25 OFFSET 50');
    });
  });
});
