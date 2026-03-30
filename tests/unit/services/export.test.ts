import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})),
    getAllWindows: vi.fn(() => [{}]),
  },
}));

import { dialog } from 'electron';
import { ExportService } from '../../../src/main/services/export';
import { createMockDatabase } from '../../helpers/mock-services';
import type { Database } from '../../../src/shared/types/services';

describe('ExportService', () => {
  let db: Database;
  let service: ExportService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    service = new ExportService(db);
  });

  describe('exportCSV', () => {
    it('should export transactions to CSV', async () => {
      const tmpPath = `/tmp/test-export-${Date.now()}.csv`;

      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: tmpPath,
      });

      let dataCallCount = 0;
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return [
            { column_name: 'id' },
            { column_name: 'row_index' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'classification_status' },
            { column_name: 'created_at' },
            { column_name: 'updated_at' },
            { column_name: 'supplier_name' },
            { column_name: 'spend_amount' },
          ];
        }
        // First data batch returns 1 row; subsequent batches return empty to end the loop
        dataCallCount++;
        if (dataCallCount === 1) {
          return [
            {
              id: 'tx1', row_index: 0, taxonomy_node_id: 'tid1',
              classification_status: 'classified',
              created_at: '2026-01-01', updated_at: '2026-01-01',
              supplier_name: 'Acme Corp', spend_amount: 5000,
              classification_path: 'Indirect|IT|Software',
            },
          ];
        }
        return [];
      });

      try {
        const result = await service.exportCSV();
        expect(result).not.toBeNull();
        expect(result!.rowsExported).toBe(1);

        const csvContent = fs.readFileSync(tmpPath, 'utf-8');
        expect(csvContent).toContain('supplier_name');
        expect(csvContent).toContain('Acme Corp');
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });

    it('should return null when user cancels dialog', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: true,
        filePath: undefined as unknown as string,
      });

      const result = await service.exportCSV();
      expect(result).toBeNull();
    });

    it('should return JOIN-resolved parent_name, not physical original_parent_name, when both exist', async () => {
      // Scenario: user imported a CSV with a "parent_name" column, which was remapped
      // to "original_parent_name" by ingest.ts. The supplier also has a proper parent
      // assigned in supplier_parents (via FK). The export must return the FK-resolved
      // value — not the raw CSV value — in the parent_name column.
      const tmpPath = `/tmp/test-export-parent-${Date.now()}.csv`;

      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: tmpPath,
      });

      let dataCallCount = 0;
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return [
            { column_name: 'id' },
            { column_name: 'row_index' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'classification_status' },
            { column_name: 'human_reviewed' },
            { column_name: 'original_supplier_name' },
            { column_name: 'project_supplier_id' },
            { column_name: 'created_at' },
            { column_name: 'updated_at' },
            // original_parent_name: the raw CSV value, remapped by ingest
            { column_name: 'original_parent_name' },
            { column_name: 'spend_amount' },
          ];
        }
        dataCallCount++;
        if (dataCallCount === 1) {
          return [
            {
              id: 'tx1', row_index: 0,
              spend_amount: 1000,
              original_parent_name: 'Alphabet Inc',  // raw CSV value
              parent_name: 'Google LLC',              // JOIN-resolved from supplier_parents
              supplier_name: 'Google Cloud',
              classification_path: 'Indirect|IT|Software',
              classification_status: 'classified_by_ai',
            },
          ];
        }
        return [];
      });

      try {
        const result = await service.exportCSV();
        expect(result).not.toBeNull();

        const csvContent = fs.readFileSync(tmpPath, 'utf-8');
        const lines = csvContent.trim().split('\r\n');
        const headers = lines[0].split(',');
        const values = lines[1].split(',');

        // parent_name column should appear exactly once in headers
        const parentNameCount = headers.filter(h => h === 'parent_name').length;
        expect(parentNameCount).toBe(1);

        // The parent_name value in the output must be the JOIN-resolved one
        const parentNameIdx = headers.indexOf('parent_name');
        expect(values[parentNameIdx]).toBe('Google LLC');

        // The raw CSV value is preserved separately as original_parent_name
        const originalParentIdx = headers.indexOf('original_parent_name');
        expect(originalParentIdx).toBeGreaterThan(-1);
        expect(values[originalParentIdx]).toBe('Alphabet Inc');
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });

    it('should handle empty dataset', async () => {
      const tmpPath = `/tmp/test-export-empty-${Date.now()}.csv`;

      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: tmpPath,
      });

      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return [
            { column_name: 'id' },
            { column_name: 'row_index' },
            { column_name: 'taxonomy_node_id' },
            { column_name: 'classification_status' },
            { column_name: 'created_at' },
            { column_name: 'updated_at' },
          ];
        }
        return [];
      });

      try {
        const result = await service.exportCSV();
        expect(result).not.toBeNull();
        expect(result!.rowsExported).toBe(0);
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });
  });
});
