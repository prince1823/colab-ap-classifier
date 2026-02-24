import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

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

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

import { exportCSV } from '../../../src/main/services/export';

describe('ExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('exportCSV', () => {
    it('should export transactions to CSV', async () => {
      // Mock column discovery
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
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
            { column_name: 'gl_description' },
          ];
        }
        // Transaction query
        return [
          {
            id: 'tx1',
            row_index: 0,
            invoice_group_key: 'g1',
            taxonomy_node_id: 'tid1',
            review_score: 10,
            classification_reasoning: 'Matched by supplier',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            supplier_name: 'Acme Corp',
            spend_amount: 5000,
            gl_description: 'Software license',
            classification_path: 'Indirect|IT|Software',
          },
          {
            id: 'tx2',
            row_index: 1,
            invoice_group_key: null,
            taxonomy_node_id: null,
            review_score: null,
            classification_reasoning: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            supplier_name: 'TestCo',
            spend_amount: 200,
            gl_description: 'Office supplies',
            classification_path: '',
          },
        ];
      });

      const tmpPath = `/tmp/test-export-${Date.now()}.csv`;

      try {
        const result = await exportCSV(tmpPath);
        expect(result.rowsExported).toBe(2);

        // Read and verify CSV
        const csvContent = fs.readFileSync(tmpPath, 'utf-8');
        const lines = csvContent.split('\n');

        // Header line
        expect(lines[0]).toContain('supplier_name');
        expect(lines[0]).toContain('classification_path');
        expect(lines[0]).toContain('classification_l1');
        expect(lines[0]).toContain('classification_l2');
        expect(lines[0]).toContain('classification_l3');
        expect(lines[0]).toContain('review_score');

        // First data row
        expect(lines[1]).toContain('Acme Corp');
        expect(lines[1]).toContain('Indirect|IT|Software');

        // Second data row - unclassified
        expect(lines[2]).toContain('TestCo');
      } finally {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      }
    });

    it('should handle CSV escaping for values with commas', async () => {
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
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
          ];
        }
        return [
          {
            id: 'tx1',
            row_index: 0,
            invoice_group_key: null,
            taxonomy_node_id: null,
            review_score: null,
            classification_reasoning: null,
            created_at: '',
            updated_at: '',
            supplier_name: 'Acme, Inc.',
            classification_path: '',
          },
        ];
      });

      const tmpPath = `/tmp/test-export-escape-${Date.now()}.csv`;

      try {
        const result = await exportCSV(tmpPath);
        expect(result.rowsExported).toBe(1);

        const csvContent = fs.readFileSync(tmpPath, 'utf-8');
        expect(csvContent).toContain('"Acme, Inc."');
      } finally {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      }
    });

    it('should handle empty dataset', async () => {
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return [
            { column_name: 'id' },
            { column_name: 'row_index' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'review_score' },
            { column_name: 'classification_reasoning' },
            { column_name: 'created_at' },
            { column_name: 'updated_at' },
          ];
        }
        return [];
      });

      const tmpPath = `/tmp/test-export-empty-${Date.now()}.csv`;

      try {
        const result = await exportCSV(tmpPath);
        expect(result.rowsExported).toBe(0);

        const csvContent = fs.readFileSync(tmpPath, 'utf-8');
        const lines = csvContent.trimEnd().split(/\r?\n/);
        expect(lines).toHaveLength(1); // Header only
      } finally {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      }
    });
  });
});
