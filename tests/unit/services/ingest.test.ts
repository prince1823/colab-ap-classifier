import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { DuckDBDatabase } from '../../../src/main/services/database';

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
import { createMockDatabase, createMockTransactionStore, createMockColumnMappingAgent, createMockSupplierService, createMockProjectStore, createMockEventBus } from '../../helpers/mock-services';
import type { Database, TransactionStore, ColumnMappingAgent, SupplierService, ProjectStore, EventBus } from '../../../src/shared/types/services';
import type { ColumnMappingResult } from '../../../src/shared/types/column-mapping';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/csv');

const MOCK_MAPPING_RESULT: ColumnMappingResult = {
  mappings: {
    supplier_name: 'Supplier',
    spend_amount: 'Amount',
    master_date: 'Date',
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
  let project: ProjectStore;
  let columnMappingAgent: ColumnMappingAgent;
  let eventBus: EventBus;
  let service: IngestService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    transactions = createMockTransactionStore();
    suppliers = createMockSupplierService();
    project = createMockProjectStore();
    columnMappingAgent = createMockColumnMappingAgent();
    eventBus = createMockEventBus();
    service = new IngestService(db, transactions, suppliers, project, columnMappingAgent, eventBus);
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
      master_date: 'Date',
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
      master_date: 'Date',
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

  describe('importCSV — master_date format detection', () => {
    const CSV_PATH = path.join(FIXTURES_DIR, 'standard.csv');
    // standard.csv Date column contains ISO dates like 2024-01-15

    const MAPPING = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      master_date: 'Date',
    };

    it('should store the detected date format via project.setSetting after a successful import', async () => {
      await service.importCSV(CSV_PATH, MAPPING);

      // standard.csv has ISO dates — should detect %Y-%m-%d, delegated to project.setSetting
      expect(project.setSetting).toHaveBeenCalledWith('master_date_format', '%Y-%m-%d');
    });

    it('should throw when date values are unrecognizable', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-date-test-'));
      const badDatesFile = path.join(tmpDir, 'bad-dates.csv');
      fs.writeFileSync(badDatesFile, 'Supplier,Amount,Date\nAcme,100,not-a-date\nBeta,200,also-invalid\n');

      try {
        await expect(
          service.importCSV(badDatesFile, MAPPING)
        ).rejects.toThrow('Could not recognize the date format');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ─── Real DB tests ───────────────────────────────────────────────────────────

function tempDbPath(): string {
  return path.join(os.tmpdir(), `ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('IngestService — importCSV (real DB)', () => {
  let realDb: DuckDBDatabase;
  let dbPath: string;
  let realService: IngestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    realDb = new DuckDBDatabase();
    dbPath = tempDbPath();
    await realDb.openDatabase(dbPath);
    const transactions = createMockTransactionStore();
    const suppliers = createMockSupplierService();
    const agent = createMockColumnMappingAgent();
    realService = new IngestService(realDb, transactions, suppliers, agent);
  });

  afterEach(async () => {
    if (realDb.isOpen()) await realDb.closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('populates upload_id on every inserted transaction row', async () => {
    const csvPath = path.resolve(__dirname, '../../fixtures/csv/standard.csv');
    const { uploadId } = await realService.importCSV(csvPath, {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
    });

    const nullRows = await realDb.all<{ cnt: number | bigint }>(
      'SELECT COUNT(*) AS cnt FROM transactions WHERE upload_id IS NULL'
    );
    expect(Number(nullRows[0].cnt)).toBe(0);

    const distinctIds = await realDb.all<{ upload_id: string }>(
      'SELECT DISTINCT upload_id FROM transactions'
    );
    expect(distinctIds).toHaveLength(1);
    expect(distinctIds[0].upload_id).toBe(uploadId);
  });
});

describe('IngestService — deleteUpload (real DB)', () => {
  let realDb: DuckDBDatabase;
  let dbPath: string;
  let realService: IngestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    realDb = new DuckDBDatabase();
    dbPath = tempDbPath();
    await realDb.openDatabase(dbPath);
    const transactions = createMockTransactionStore();
    const suppliers = createMockSupplierService();
    const agent = createMockColumnMappingAgent();
    realService = new IngestService(realDb, transactions, suppliers, agent);
  });

  afterEach(async () => {
    if (realDb.isOpen()) await realDb.closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('deletes all transactions for the upload and removes orphaned suppliers', async () => {
    await realDb.run(
      `INSERT INTO project_suppliers (id, supplier_name) VALUES ('sup-a', 'Supplier A')`
    );
    await realDb.run(
      `INSERT INTO uploads (id, file_name, column_mappings, row_count) VALUES ('upload-1', 'file1.csv', '{}', 2)`
    );
    await realDb.run(
      `INSERT INTO transactions (id, upload_id, project_supplier_id, row_index) VALUES
       ('tx-1', 'upload-1', 'sup-a', 0),
       ('tx-2', 'upload-1', 'sup-a', 1)`
    );

    await realService.deleteUpload('upload-1');

    const txRows = await realDb.all('SELECT * FROM transactions');
    expect(txRows).toHaveLength(0);

    const supplierRows = await realDb.all('SELECT * FROM project_suppliers');
    expect(supplierRows).toHaveLength(0);

    const uploadRows = await realDb.all('SELECT * FROM uploads');
    expect(uploadRows).toHaveLength(0);
  });

  it('does not delete a supplier that still has transactions from another upload', async () => {
    await realDb.run(
      `INSERT INTO project_suppliers (id, supplier_name) VALUES
       ('sup-a', 'Supplier A'),
       ('sup-b', 'Supplier B'),
       ('sup-c', 'Supplier C')`
    );
    await realDb.run(
      `INSERT INTO uploads (id, file_name, column_mappings, row_count) VALUES
       ('upload-1', 'file1.csv', '{}', 2),
       ('upload-2', 'file2.csv', '{}', 2)`
    );
    // upload-1: supplier-a and supplier-c
    // upload-2: supplier-a and supplier-b
    await realDb.run(
      `INSERT INTO transactions (id, upload_id, project_supplier_id, row_index) VALUES
       ('tx-1', 'upload-1', 'sup-a', 0),
       ('tx-2', 'upload-1', 'sup-c', 1),
       ('tx-3', 'upload-2', 'sup-a', 0),
       ('tx-4', 'upload-2', 'sup-b', 1)`
    );

    await realService.deleteUpload('upload-1');

    const txRows = await realDb.all<{ upload_id: string }>('SELECT upload_id FROM transactions');
    expect(txRows).toHaveLength(2);
    expect(txRows.every((r) => r.upload_id === 'upload-2')).toBe(true);

    const supplierIds = (await realDb.all<{ id: string }>('SELECT id FROM project_suppliers')).map((r) => r.id);
    expect(supplierIds).toContain('sup-a');
    expect(supplierIds).toContain('sup-b');
    expect(supplierIds).not.toContain('sup-c');
  });

  it('throws if any transactions in the upload are classified and makes no changes', async () => {
    await realDb.run(
      `INSERT INTO project_suppliers (id, supplier_name) VALUES ('sup-a', 'Supplier A')`
    );
    await realDb.run(
      `INSERT INTO uploads (id, file_name, column_mappings, row_count) VALUES ('upload-1', 'file1.csv', '{}', 2)`
    );
    await realDb.run(
      `INSERT INTO transactions (id, upload_id, project_supplier_id, row_index, classification_status) VALUES
       ('tx-1', 'upload-1', 'sup-a', 0, 'unclassified'),
       ('tx-2', 'upload-1', 'sup-a', 1, 'classified')`
    );

    await expect(realService.deleteUpload('upload-1')).rejects.toThrow(
      'Cannot delete upload'
    );

    // Verify nothing was deleted
    const txRows = await realDb.all('SELECT * FROM transactions');
    expect(txRows).toHaveLength(2);
  });

  it('only deletes transactions belonging to the specified upload', async () => {
    await realDb.run(
      `INSERT INTO project_suppliers (id, supplier_name) VALUES
       ('sup-a', 'Supplier A'),
       ('sup-b', 'Supplier B')`
    );
    await realDb.run(
      `INSERT INTO uploads (id, file_name, column_mappings, row_count) VALUES
       ('upload-1', 'file1.csv', '{}', 1),
       ('upload-2', 'file2.csv', '{}', 1)`
    );
    await realDb.run(
      `INSERT INTO transactions (id, upload_id, project_supplier_id, row_index) VALUES
       ('tx-1', 'upload-1', 'sup-a', 0),
       ('tx-2', 'upload-2', 'sup-b', 0)`
    );

    await realService.deleteUpload('upload-1');

    const txRows = await realDb.all<{ upload_id: string }>('SELECT upload_id FROM transactions');
    expect(txRows).toHaveLength(1);
    expect(txRows[0].upload_id).toBe('upload-2');

    const uploadRows = await realDb.all<{ id: string }>('SELECT id FROM uploads');
    expect(uploadRows).toHaveLength(1);
    expect(uploadRows[0].id).toBe('upload-2');

    const supplierIds = (await realDb.all<{ id: string }>('SELECT id FROM project_suppliers')).map((r) => r.id);
    expect(supplierIds).toContain('sup-b');
    expect(supplierIds).not.toContain('sup-a');
  });
});
