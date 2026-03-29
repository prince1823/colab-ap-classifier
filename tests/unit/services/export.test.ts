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
