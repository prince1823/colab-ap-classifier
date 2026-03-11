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
    it('should parse columns correctly', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));
      expect(result.columns).toEqual([
        'Supplier', 'Invoice Number', 'Amount', 'Date', 'Description',
      ]);
    });

    it('should return all rows as sample rows when <= 10', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));
      expect(result.sampleRows).toHaveLength(5);
      expect(result.totalRows).toBe(5);
    });
  });

  describe('parseCSVPreview — special characters', () => {
    it('should handle apostrophes and ampersands', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));
      expect(result.sampleRows[0].Supplier).toBe("O'Brien & Associates");
    });

    it('should handle commas within quoted fields', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));
      expect(result.sampleRows[0].Description).toBe('Legal fees, consulting');
    });
  });

  describe('parseCSVPreview — large file', () => {
    it('should return only 10 sample rows', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));
      expect(result.sampleRows).toHaveLength(10);
    });

    it('should report accurate totalRows count', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));
      expect(result.totalRows).toBe(50);
    });
  });

  describe('parseCSVPreview — delimiter detection', () => {
    it('should detect semicolon delimiter', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'semicolon.csv'));
      expect(result.columns).toEqual([
        'Supplier', 'Invoice Number', 'Amount', 'Date', 'Description',
      ]);
    });

    it('should detect tab delimiter', () => {
      const result = service.parseCSVPreview(path.join(FIXTURES_DIR, 'tab-delimited.csv'));
      expect(result.columns).toEqual([
        'Supplier', 'Invoice Number', 'Amount', 'Date', 'Description',
      ]);
    });
  });

  describe('parseCSVPreview — error handling', () => {
    it('should throw for an empty file path', () => {
      expect(() => service.parseCSVPreview('')).toThrow('File path must not be empty');
    });

    it('should throw for a non-existent file', () => {
      expect(() => service.parseCSVPreview('/nonexistent/path/file.csv')).toThrow('File not found');
    });

    it('should throw for an empty file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
      const emptyFile = path.join(tmpDir, 'empty.csv');
      fs.writeFileSync(emptyFile, '');
      try {
        expect(() => service.parseCSVPreview(emptyFile)).toThrow('File is empty');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('parseCSVPreview — encoding detection', () => {
    it('should handle UTF-8 BOM', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
      const bomFile = path.join(tmpDir, 'bom.csv');
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from('Name,Value\nAlice,100\nBob,200\n', 'utf-8');
      fs.writeFileSync(bomFile, Buffer.concat([bom, content]));
      try {
        const result = service.parseCSVPreview(bomFile);
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
});
