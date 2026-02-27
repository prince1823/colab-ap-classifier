import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock Electron's dialog module before importing the service
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

// Mock the column-mapping agent
vi.mock('../../../src/main/agents/column-mapping-agent', () => ({
  suggestMappings: vi.fn(),
}));

// Mock canonical-columns (now a shared module, no longer exported from the agent)
vi.mock('../../../src/shared/canonical-columns', () => ({
  CANONICAL_COLUMNS: [
    { name: 'supplier_name', relevance: 'critical', type: 'text', aliases: ['Vendor', 'Supplier'], description: 'Supplier name' },
    { name: 'spend_amount', relevance: 'critical', type: 'number', aliases: ['Amount', 'Cost'], description: 'Amount' },
    { name: 'line_description', relevance: 'critical', type: 'log_text', aliases: ['Description'], description: 'Description' },
    { name: 'gl_description', relevance: 'high', type: 'log_text', aliases: ['GL'], description: 'GL description' },
    { name: 'gl_code', relevance: 'high', type: 'category', aliases: ['Account Code'], description: 'GL code' },
    { name: 'department', relevance: 'medium', type: 'category', aliases: ['Dept'], description: 'Department' },
    { name: 'invoice_date', relevance: 'high', type: 'date', aliases: ['Date'], description: 'Invoice date' },
    { name: 'creation_date', relevance: 'low', type: 'date', aliases: ['Created'], description: 'Creation date' },
    { name: 'company', relevance: 'medium', type: 'category', aliases: ['Entity'], description: 'Company' },
    { name: 'cost_center', relevance: 'medium', type: 'category', aliases: ['Cost Center'], description: 'Cost center' },
    { name: 'po_number', relevance: 'low', type: 'text', aliases: ['PO'], description: 'PO number' },
    { name: 'supplier_address', relevance: 'low', type: 'text', aliases: ['Address'], description: 'Address' },
    { name: 'currency', relevance: 'low', type: 'category', aliases: ['Currency Code'], description: 'Currency' },
    { name: 'memo', relevance: 'low', type: 'log_text', aliases: ['Notes'], description: 'Memo' },
  ],
}));

import { dialog } from 'electron';
import { selectFile, parsePreview, parseCSVPreview } from '../../../src/main/services/upload';
import * as columnMappingAgent from '../../../src/main/agents/column-mapping-agent';
import type { ColumnMappingResult } from '../../../src/shared/types/column-mapping';

const mockedAgent = vi.mocked(columnMappingAgent);

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

describe('Upload Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAgent.suggestMappings.mockResolvedValue(MOCK_MAPPING_RESULT);
  });

  // -------------------------------------------------------------------
  // selectFile
  // -------------------------------------------------------------------
  describe('selectFile', () => {
    beforeEach(() => {
      vi.mocked(dialog.showOpenDialog).mockReset();
    });

    it('should return the selected file path', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ['/some/path/data.csv'],
      });

      const result = await selectFile();
      expect(result).toBe('/some/path/data.csv');
    });

    it('should return null when the user cancels', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await selectFile();
      expect(result).toBeNull();
    });

    it('should configure the dialog for CSV files', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      await selectFile();

      expect(dialog.showOpenDialog).toHaveBeenCalledWith(
        expect.anything(), // BrowserWindow reference
        expect.objectContaining({
          filters: expect.arrayContaining([
            expect.objectContaining({
              extensions: expect.arrayContaining(['csv']),
            }),
          ]),
          properties: ['openFile'],
        })
      );
    });
  });

  // -------------------------------------------------------------------
  // parseCSVPreview — synchronous CSV-only parsing (internal helper)
  // -------------------------------------------------------------------
  describe('parseCSVPreview — standard CSV', () => {
    it('should parse columns correctly', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
    });

    it('should return all rows as sample rows when <= 10', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(result.sampleRows).toHaveLength(5);
      expect(result.totalRows).toBe(5);
    });

    it('should contain correct data in sample rows', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(result.sampleRows[0]).toEqual({
        Supplier: 'Acme Corp',
        'Invoice Number': 'INV-001',
        Amount: '1500.00',
        Date: '2024-01-15',
        Description: 'Office Supplies',
      });

      expect(result.sampleRows[4]).toEqual({
        Supplier: 'Stark Industries',
        'Invoice Number': 'INV-005',
        Amount: '8900.75',
        Date: '2024-02-15',
        Description: 'Lab Equipment',
      });
    });
  });

  // -------------------------------------------------------------------
  // parseCSVPreview — special characters and quotes
  // -------------------------------------------------------------------
  describe('parseCSVPreview — special characters and quotes', () => {
    it('should parse columns correctly', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Description',
      ]);
    });

    it('should handle apostrophes and ampersands in values', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[0].Supplier).toBe("O'Brien & Associates");
    });

    it('should handle commas within quoted fields', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[0].Description).toBe('Legal fees, consulting');
    });

    it('should handle non-ASCII characters (accented letters)', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[1].Supplier).toBe('Müller GmbH');
    });

    it('should handle escaped quotes within quoted fields', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[2].Description).toBe(
        'Catering for "Annual Gala"'
      );
    });

    it('should handle newlines within quoted fields', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[3].Supplier).toBe('Smith, Jones & Co.');
      expect(result.sampleRows[3].Description).toContain('spanning multiple lines');
    });

    it('should return correct total row count', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.totalRows).toBe(5);
    });
  });

  // -------------------------------------------------------------------
  // parseCSVPreview — large file
  // -------------------------------------------------------------------
  describe('parseCSVPreview — large file', () => {
    it('should return only 10 sample rows for a file with more than 10 rows', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.sampleRows).toHaveLength(10);
    });

    it('should report accurate totalRows count', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.totalRows).toBe(50);
    });

    it('should return all columns', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Category',
      ]);
    });

    it('should have sample rows from the beginning of the file', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.sampleRows[0].Supplier).toBe('Supplier_1');
      expect(result.sampleRows[9].Supplier).toBe('Supplier_10');
    });
  });

  // -------------------------------------------------------------------
  // parseCSVPreview — delimiter detection
  // -------------------------------------------------------------------
  describe('parseCSVPreview — delimiter detection', () => {
    it('should detect semicolon delimiter', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'semicolon.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
      expect(result.totalRows).toBe(3);
      expect(result.sampleRows[0].Supplier).toBe('Acme Corp');
    });

    it('should detect tab delimiter', () => {
      const result = parseCSVPreview(path.join(FIXTURES_DIR, 'tab-delimited.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
      expect(result.totalRows).toBe(3);
      expect(result.sampleRows[0].Supplier).toBe('Acme Corp');
    });
  });

  // -------------------------------------------------------------------
  // parseCSVPreview — error handling
  // -------------------------------------------------------------------
  describe('parseCSVPreview — error handling', () => {
    it('should throw for an empty file path', () => {
      expect(() => parseCSVPreview('')).toThrow('File path must not be empty');
    });

    it('should throw for a non-existent file', () => {
      expect(() =>
        parseCSVPreview('/nonexistent/path/file.csv')
      ).toThrow('File not found');
    });

    it('should throw for an empty file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const emptyFile = path.join(tmpDir, 'empty.csv');
      fs.writeFileSync(emptyFile, '');

      try {
        expect(() => parseCSVPreview(emptyFile)).toThrow('File is empty');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw for a file with only headers and no data rows', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const headerOnlyFile = path.join(tmpDir, 'header-only.csv');
      fs.writeFileSync(headerOnlyFile, 'Col1,Col2,Col3\n');

      try {
        expect(() => parseCSVPreview(headerOnlyFile)).toThrow(
          'CSV file contains no data rows'
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------
  // parseCSVPreview — encoding detection
  // -------------------------------------------------------------------
  describe('parseCSVPreview — encoding detection', () => {
    it('should handle UTF-8 BOM', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const bomFile = path.join(tmpDir, 'bom.csv');
      // Write UTF-8 BOM followed by CSV content
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from('Name,Value\nAlice,100\nBob,200\n', 'utf-8');
      fs.writeFileSync(bomFile, Buffer.concat([bom, content]));

      try {
        const result = parseCSVPreview(bomFile);
        expect(result.columns).toEqual(['Name', 'Value']);
        expect(result.totalRows).toBe(2);
        expect(result.sampleRows[0].Name).toBe('Alice');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle Latin-1 encoded files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const latin1File = path.join(tmpDir, 'latin1.csv');
      // Write Latin-1 content (bytes 0x80-0xFF that are invalid standalone UTF-8)
      const content = Buffer.from(
        'Name,City\nJos\xe9,M\xe9xico\nRen\xe9,Montr\xe9al\n',
        'latin1'
      );
      fs.writeFileSync(latin1File, content);

      try {
        const result = parseCSVPreview(latin1File);
        expect(result.columns).toEqual(['Name', 'City']);
        expect(result.totalRows).toBe(2);
        // Latin-1 decoded values
        expect(result.sampleRows[0].Name).toBe('José');
        expect(result.sampleRows[0].City).toBe('México');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------
  // parsePreview — async with LLM mapping suggestions (LLM-first flow)
  // -------------------------------------------------------------------
  describe('parsePreview — LLM-first mapping suggestions', () => {
    it('should return CSV preview with mapping suggestions', async () => {
      const result = await parsePreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
      expect(result.totalRows).toBe(5);
      expect(result.sampleRows).toHaveLength(5);
      expect(result.mappingSuggestion).toEqual(MOCK_MAPPING_RESULT);
    });

    it('should call column-mapping agent with columns and sample rows', async () => {
      await parsePreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(mockedAgent.suggestMappings).toHaveBeenCalledOnce();
      const [columns, sampleData] = mockedAgent.suggestMappings.mock.calls[0];
      expect(columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
      expect(sampleData).toHaveLength(5);
      expect(sampleData[0].Supplier).toBe('Acme Corp');
    });

    it('should gracefully degrade when LLM call fails', async () => {
      mockedAgent.suggestMappings.mockRejectedValueOnce(new Error('API key missing'));

      const result = await parsePreview(path.join(FIXTURES_DIR, 'standard.csv'));

      // CSV preview should still be returned
      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
      expect(result.totalRows).toBe(5);

      // Mapping suggestion should be empty fallback
      expect(result.mappingSuggestion.mappings).toEqual({});
      expect(result.mappingSuggestion.confidence).toBe('low');
      expect(result.mappingSuggestion.unmappedClientColumns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
      expect(result.mappingSuggestion.reasoning).toContain('unavailable');
    });

    it('should still throw for invalid file paths', async () => {
      await expect(parsePreview('')).rejects.toThrow('File path must not be empty');
      await expect(parsePreview('/nonexistent.csv')).rejects.toThrow('File not found');
    });

    it('should include mapping suggestions for large files', async () => {
      const result = await parsePreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.sampleRows).toHaveLength(10);
      expect(result.totalRows).toBe(50);
      expect(result.mappingSuggestion).toEqual(MOCK_MAPPING_RESULT);

      // Agent should be called with sample rows (up to 10)
      const [, sampleData] = mockedAgent.suggestMappings.mock.calls[0];
      expect(sampleData).toHaveLength(10);
    });
  });
});
