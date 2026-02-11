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
  BrowserWindow: vi.fn(),
}));

import { dialog } from 'electron';
import { selectFile, parsePreview } from '../../../src/main/services/upload';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/csv');

describe('Upload Service', () => {
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
  // parsePreview — standard CSV
  // -------------------------------------------------------------------
  describe('parsePreview — standard CSV', () => {
    it('should parse columns correctly', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Description',
      ]);
    });

    it('should return all rows as sample rows when <= 10', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'standard.csv'));

      expect(result.sampleRows).toHaveLength(5);
      expect(result.totalRows).toBe(5);
    });

    it('should contain correct data in sample rows', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'standard.csv'));

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
  // parsePreview — special characters and quotes
  // -------------------------------------------------------------------
  describe('parsePreview — special characters and quotes', () => {
    it('should parse columns correctly', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Description',
      ]);
    });

    it('should handle apostrophes and ampersands in values', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[0].Supplier).toBe("O'Brien & Associates");
    });

    it('should handle commas within quoted fields', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[0].Description).toBe('Legal fees, consulting');
    });

    it('should handle non-ASCII characters (accented letters)', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[1].Supplier).toBe('Müller GmbH');
    });

    it('should handle escaped quotes within quoted fields', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[2].Description).toBe(
        'Catering for "Annual Gala"'
      );
    });

    it('should handle newlines within quoted fields', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.sampleRows[3].Supplier).toBe('Smith, Jones & Co.');
      expect(result.sampleRows[3].Description).toContain('spanning multiple lines');
    });

    it('should return correct total row count', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'special-chars.csv'));

      expect(result.totalRows).toBe(5);
    });
  });

  // -------------------------------------------------------------------
  // parsePreview — large file
  // -------------------------------------------------------------------
  describe('parsePreview — large file', () => {
    it('should return only 10 sample rows for a file with more than 10 rows', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.sampleRows).toHaveLength(10);
    });

    it('should report accurate totalRows count', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.totalRows).toBe(50);
    });

    it('should return all columns', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.columns).toEqual([
        'Supplier',
        'Invoice Number',
        'Amount',
        'Date',
        'Category',
      ]);
    });

    it('should have sample rows from the beginning of the file', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'large.csv'));

      expect(result.sampleRows[0].Supplier).toBe('Supplier_1');
      expect(result.sampleRows[9].Supplier).toBe('Supplier_10');
    });
  });

  // -------------------------------------------------------------------
  // parsePreview — delimiter detection
  // -------------------------------------------------------------------
  describe('parsePreview — delimiter detection', () => {
    it('should detect semicolon delimiter', () => {
      const result = parsePreview(path.join(FIXTURES_DIR, 'semicolon.csv'));

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
      const result = parsePreview(path.join(FIXTURES_DIR, 'tab-delimited.csv'));

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
  // parsePreview — error handling
  // -------------------------------------------------------------------
  describe('parsePreview — error handling', () => {
    it('should throw for an empty file path', () => {
      expect(() => parsePreview('')).toThrow('File path must not be empty');
    });

    it('should throw for a non-existent file', () => {
      expect(() =>
        parsePreview('/nonexistent/path/file.csv')
      ).toThrow('File not found');
    });

    it('should throw for an empty file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const emptyFile = path.join(tmpDir, 'empty.csv');
      fs.writeFileSync(emptyFile, '');

      try {
        expect(() => parsePreview(emptyFile)).toThrow('File is empty');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw for a file with only headers and no data rows', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const headerOnlyFile = path.join(tmpDir, 'header-only.csv');
      fs.writeFileSync(headerOnlyFile, 'Col1,Col2,Col3\n');

      try {
        expect(() => parsePreview(headerOnlyFile)).toThrow(
          'CSV file contains no data rows'
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------
  // parsePreview — encoding detection
  // -------------------------------------------------------------------
  describe('parsePreview — encoding detection', () => {
    it('should handle UTF-8 BOM', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
      const bomFile = path.join(tmpDir, 'bom.csv');
      // Write UTF-8 BOM followed by CSV content
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from('Name,Value\nAlice,100\nBob,200\n', 'utf-8');
      fs.writeFileSync(bomFile, Buffer.concat([bom, content]));

      try {
        const result = parsePreview(bomFile);
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
        const result = parsePreview(latin1File);
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
});
