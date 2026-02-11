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

import { queryTransactions, getStats, getColumns } from '../../../src/main/services/transactions';

describe('TransactionsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        { column_name: 'review_score' },
      ]);

      mockGet
        .mockResolvedValueOnce({ cnt: 100 })   // total rows
        .mockResolvedValueOnce({ total: 50000 }) // total spend
        .mockResolvedValueOnce({ cnt: 25 })      // unique suppliers
        .mockResolvedValueOnce({ cnt: 80 })      // classified
        .mockResolvedValueOnce({ cnt: 5 });      // flagged

      const stats = await getStats();
      expect(stats.totalRows).toBe(100);
      expect(stats.totalSpend).toBe(50000);
      expect(stats.uniqueSuppliers).toBe(25);
      expect(stats.classifiedRows).toBe(80);
      expect(stats.flaggedForReviewRows).toBe(5);
    });

    it('should handle missing spend and supplier columns', async () => {
      mockAll.mockResolvedValue([
        { column_name: 'id' },
        { column_name: 'row_index' },
      ]);

      mockGet
        .mockResolvedValueOnce({ cnt: 10 })  // total
        .mockResolvedValueOnce({ cnt: 0 })   // classified
        .mockResolvedValueOnce({ cnt: 0 });  // flagged

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
            { column_name: 'invoice_group_key' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'review_score' },
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
            invoice_group_key: 'g1',
            taxonomy_node_id: 'tid1',
            classification_path: 'Indirect|IT|Software',
            review_score: null,
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

    it('should apply review score range filter', async () => {
      await queryTransactions({ reviewScoreMin: 3, reviewScoreMax: 8 });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('review_score >= ?');
      expect(String(selectCall![0])).toContain('review_score <= ?');
    });

    it('should apply spend range filter', async () => {
      await queryTransactions({ spendMin: 100, spendMax: 5000 });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('spend_amount >= ?');
      expect(String(selectCall![0])).toContain('spend_amount <= ?');
    });

    it('should apply pagination defaults', async () => {
      await queryTransactions();

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('LIMIT 50 OFFSET 0');
    });

    it('should apply custom pagination', async () => {
      await queryTransactions({ page: 3, pageSize: 25 });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('LIMIT 25 OFFSET 50');
    });

    it('should handle exclude tail spend filter', async () => {
      mockGet.mockResolvedValue({ value: '5000' });

      await queryTransactions({ excludeTailSpend: true });

      const selectCall = mockAll.mock.calls.find((c) =>
        String(c[0]).includes('FROM transactions')
      );
      expect(String(selectCall![0])).toContain('spend_amount >= ?');
    });
  });
});
