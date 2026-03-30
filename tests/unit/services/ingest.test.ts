import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})),
    getAllWindows: vi.fn(() => [{}]),
  },
}));

import { dialog } from 'electron';
import { IngestService } from '../../../src/main/services/ingest';
import { createMockDatabase, createMockTransactionStore, createMockColumnMappingAgent, createMockSupplierService } from '../../helpers/mock-services';
import type { Database, TransactionStore, ColumnMappingAgent, SupplierService } from '../../../src/shared/types/services';
import type { ColumnMappingResult } from '../../../src/shared/types/column-mapping';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/csv');

const MOCK_MAPPING_RESULT: ColumnMappingResult = {
  mappings: {
    supplier_name: 'Supplier',
    spend_amount: 'Amount',
    invoice_date: 'Date',
    line_description: 'Description',
  },
  confidence: 'high',
  unmappedClientColumns: ['Invoice Number'],
  importantUnmappedColumns: [],
  unmappedCanonicalColumns: ['gl_description', 'gl_code'],
  reasoning: 'Mapped based on column names',
};

describe('IngestService', () => {
  let db: Database;
  let transactions: TransactionStore;
  let suppliers: SupplierService;
  let columnMappingAgent: ColumnMappingAgent;
  let service: IngestService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    transactions = createMockTransactionStore();
    suppliers = createMockSupplierService();
    columnMappingAgent = createMockColumnMappingAgent();
    service = new IngestService(db, transactions, suppliers, columnMappingAgent);
    vi.mocked(columnMappingAgent.suggestMappings).mockResolvedValue(MOCK_MAPPING_RESULT);
  });

  describe('selectFile', () => {
    it('should return the selected file path', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ['/some/path/data.csv'],
      });

      const result = await service.selectFile();
      expect(result).toBe('/some/path/data.csv');
    });

    it('should return null when the user cancels', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await service.selectFile();
      expect(result).toBeNull();
    });
  });

  describe('parseCSVPreview — standard CSV', () => {
    it('should parse columns correctly', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));
      expect(result.columns).toEqual([
        'Supplier', 'Invoice Number', 'Amount', 'Date', 'Description',
      ]);
    });

    it('should return all rows as sample rows when <= 10', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));
      expect(result.sampleRows).toHaveLength(5);
      expect(result.totalRows).toBe(5);
    });
  });

  describe('parseCSVPreview — special characters', () => {
    it('should handle apostrophes and ampersands', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));
      expect(result.sampleRows[0].Supplier).toBe("O'Brien & Associates");
    });

    it('should handle commas within quoted fields', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));
      expect(result.sampleRows[0].Description).toBe('Legal fees, consulting');
    });
  });

  describe('parseCSVPreview — large file', () => {
    it('should return only 10 sample rows', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));
      expect(result.sampleRows).toHaveLength(10);
    });

    it('should report accurate totalRows count', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));
      expect(result.totalRows).toBe(50);
    });
  });

  describe('parseCSVPreview — delimiter detection', () => {
    it('should detect semicolon delimiter', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'semicolon.csv'));
      expect(result.columns).toEqual([
        'Supplier', 'Invoice Number', 'Amount', 'Date', 'Description',
      ]);
    });

    it('should detect tab delimiter', async () => {
      const result = await service.parseCSVPreview(path.join(FIXTURES_DIR, 'tab-delimited.csv'));
      expect(result.columns).toEqual([
        'Supplier', 'Invoice Number', 'Amount', 'Date', 'Description',
      ]);
    });
  });

  describe('parseCSVPreview — error handling', () => {
    it('should throw for an empty file path', async () => {
      await expect(service.parseCSVPreview('')).rejects.toThrow('File path must not be empty');
    });

    it('should throw for a non-existent file', async () => {
      await expect(service.parseCSVPreview('/nonexistent/path/file.csv')).rejects.toThrow('File not found');
    });

    it('should throw for an empty file', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
      const emptyFile = path.join(tmpDir, 'empty.csv');
      fs.writeFileSync(emptyFile, '');
      try {
        await expect(service.parseCSVPreview(emptyFile)).rejects.toThrow('File is empty');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('parseCSVPreview — encoding detection', () => {
    it('should handle UTF-8 BOM', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
      const bomFile = path.join(tmpDir, 'bom.csv');
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from('Name,Value\nAlice,100\nBob,200\n', 'utf-8');
      fs.writeFileSync(bomFile, Buffer.concat([bom, content]));
      try {
        const result = await service.parseCSVPreview(bomFile);
        expect(result.columns).toEqual(['Name', 'Value']);
        expect(result.totalRows).toBe(2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('suggestMappings', () => {
    it('should return mapping result from column-mapping agent', async () => {
      const columns = ['Supplier', 'Invoice Number', 'Amount'];
      const sampleRows = [{ Supplier: 'Acme', 'Invoice Number': '001', Amount: '100' }];
      const result = await service.suggestMappings(columns, sampleRows);
      expect(result).toEqual(MOCK_MAPPING_RESULT);
      expect(columnMappingAgent.suggestMappings).toHaveBeenCalled();
    });
  });

  describe('importCSV — mapping validation', () => {
    const CSV_PATH = path.join(FIXTURES_DIR, 'standard.csv');
    // standard.csv columns: Supplier, Invoice Number, Amount, Date, Description

    const VALID_MAPPING = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
    };

    it('should throw when a required canonical column is missing from the mapping', async () => {
      const { spend_amount: _, ...missingSupplier } = VALID_MAPPING;
      await expect(service.importCSV(CSV_PATH, missingSupplier)).rejects.toThrow(
        'Required canonical column "spend_amount" is missing from the mapping'
      );
    });

    it('should throw when the same CSV column is assigned to multiple canonical columns', async () => {
      const duplicateMapping = {
        ...VALID_MAPPING,
        line_description: 'Supplier', // 'Supplier' already used by supplier_name
      };
      await expect(service.importCSV(CSV_PATH, duplicateMapping)).rejects.toThrow(
        'CSV column "Supplier" is assigned to multiple canonical columns'
      );
    });

    it('should allow changing which CSV column a canonical maps to', async () => {
      // Re-map supplier_name to a different CSV column — should not throw
      const remappedMapping = {
        ...VALID_MAPPING,
        supplier_name: 'Description', // changed from 'Supplier'
      };
      await expect(service.importCSV(CSV_PATH, remappedMapping)).resolves.toMatchObject({
        rowsInserted: expect.any(Number),
        uploadId: expect.any(String),
      });
    });
  });

  describe('importCSV — virtual column name guard', () => {
    const CSV_PATH = path.join(FIXTURES_DIR, 'standard.csv');

    const BASE_MAPPING = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
    };

    it('should remap parent_name to original_parent_name in SQL, not store it as a physical column', async () => {
      // A user manually maps their CSV "Description" column to the canonical name "parent_name".
      // parent_name is a virtual column (JOIN-resolved) — it must never become a physical column.
      const mappingWithParentName = {
        ...BASE_MAPPING,
        parent_name: 'Description',
      };

      await service.importCSV(CSV_PATH, mappingWithParentName);

      // The ALTER TABLE call should use "original_parent_name", not "parent_name"
      const alterCalls = vi.mocked(db.run).mock.calls
        .filter(([sql]) => typeof sql === 'string' && sql.includes('ALTER TABLE'));

      const columnNames = alterCalls.map(([sql]) => {
        const match = (sql as string).match(/ADD COLUMN "([^"]+)"/);
        return match?.[1];
      });

      expect(columnNames).toContain('original_parent_name');
      expect(columnNames).not.toContain('parent_name');
    });

    it('should also remap supplier_name to original_supplier_name (existing behaviour preserved)', async () => {
      await service.importCSV(CSV_PATH, BASE_MAPPING);

      const alterCalls = vi.mocked(db.run).mock.calls
        .filter(([sql]) => typeof sql === 'string' && sql.includes('ALTER TABLE'));

      const columnNames = alterCalls.map(([sql]) => {
        const match = (sql as string).match(/ADD COLUMN "([^"]+)"/);
        return match?.[1];
      });

      expect(columnNames).toContain('original_supplier_name');
      expect(columnNames).not.toContain('supplier_name');
    });
  });
});
