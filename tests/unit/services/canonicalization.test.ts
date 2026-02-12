import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database service
vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    run: vi.fn(),
    all: vi.fn(),
    get: vi.fn(),
  },
}));

// NOTE: canonicalization agent mock removed — suggestMappings is no longer
// on the canonicalization service (moved to upload service / LLM-first flow).

// Mock uuid to return predictable values
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => {
    uuidCounter += 1;
    return `test-uuid-${uuidCounter}`;
  }),
}));

// Mock fs for importCSV tests
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import fs from 'fs';
import { databaseService } from '../../../src/main/services/database';
import {
  saveMappings,
  getMappings,
  getGroupingColumns,
  importCSV,
} from '../../../src/main/services/canonicalization';

const mockedDb = vi.mocked(databaseService);
const mockedFs = vi.mocked(fs);

describe('CanonicalizationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  // NOTE: suggestMappings tests removed — suggestMappings is no longer on the
  // canonicalization service. It was moved to the upload service (LLM-first flow).
  // See tests/unit/services/upload.test.ts for the new tests.

  // -------------------------------------------------------------------
  // saveMappings
  // -------------------------------------------------------------------
  describe('saveMappings', () => {
    it('should clear existing and insert new mappings', async () => {
      // No existing mappings
      mockedDb.all.mockResolvedValue([]);

      const mapping = {
        supplier_name: 'Vendor',
        spend_amount: 'Amount',
      };
      const groupingColumns = ['supplier_name', 'spend_amount'];

      await saveMappings(mapping, groupingColumns);

      // Should delete existing mappings
      expect(mockedDb.run).toHaveBeenCalledWith('DELETE FROM column_mappings');
      expect(mockedDb.run).toHaveBeenCalledWith(
        'DELETE FROM invoice_grouping_columns'
      );

      // Should insert column mappings
      expect(mockedDb.run).toHaveBeenCalledWith(
        'INSERT INTO column_mappings (canonical_name, csv_column_name) VALUES (?, ?)',
        'supplier_name',
        'Vendor'
      );
      expect(mockedDb.run).toHaveBeenCalledWith(
        'INSERT INTO column_mappings (canonical_name, csv_column_name) VALUES (?, ?)',
        'spend_amount',
        'Amount'
      );

      // Should insert grouping columns with positions
      expect(mockedDb.run).toHaveBeenCalledWith(
        'INSERT INTO invoice_grouping_columns (canonical_name, position) VALUES (?, ?)',
        'supplier_name',
        0
      );
      expect(mockedDb.run).toHaveBeenCalledWith(
        'INSERT INTO invoice_grouping_columns (canonical_name, position) VALUES (?, ?)',
        'spend_amount',
        1
      );
    });

    it('should throw on conflicting mappings', async () => {
      // Existing mappings in DB
      mockedDb.all.mockResolvedValue([
        { canonical_name: 'supplier_name', csv_column_name: 'OldVendor' },
      ]);

      const mapping = {
        supplier_name: 'NewVendor', // conflicts with existing 'OldVendor'
      };

      await expect(saveMappings(mapping, [])).rejects.toThrow(
        'Conflicting mapping for "supplier_name"'
      );
    });

    it('should allow saving when existing mapping matches the new one', async () => {
      // Existing mapping that matches
      mockedDb.all.mockResolvedValue([
        { canonical_name: 'supplier_name', csv_column_name: 'Vendor' },
      ]);

      const mapping = { supplier_name: 'Vendor' };

      await expect(saveMappings(mapping, [])).resolves.not.toThrow();
    });

    it('should save empty grouping columns', async () => {
      mockedDb.all.mockResolvedValue([]);

      await saveMappings({ supplier_name: 'Vendor' }, []);

      // Verify DELETE was called for grouping columns
      expect(mockedDb.run).toHaveBeenCalledWith(
        'DELETE FROM invoice_grouping_columns'
      );

      // No INSERT for grouping columns should have been called
      const groupingInsertCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO invoice_grouping_columns')
      );
      expect(groupingInsertCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // getMappings
  // -------------------------------------------------------------------
  describe('getMappings', () => {
    it('should return null when no mappings exist', async () => {
      mockedDb.all.mockResolvedValue([]);

      const result = await getMappings();

      expect(result).toBeNull();
    });

    it('should return mapping object from DB rows', async () => {
      mockedDb.all.mockResolvedValue([
        { canonical_name: 'supplier_name', csv_column_name: 'Vendor' },
        { canonical_name: 'spend_amount', csv_column_name: 'Amount' },
        { canonical_name: 'invoice_date', csv_column_name: 'Date' },
      ]);

      const result = await getMappings();

      expect(result).toEqual({
        supplier_name: 'Vendor',
        spend_amount: 'Amount',
        invoice_date: 'Date',
      });
    });

    it('should query the correct table', async () => {
      mockedDb.all.mockResolvedValue([]);

      await getMappings();

      expect(mockedDb.all).toHaveBeenCalledWith(
        'SELECT canonical_name, csv_column_name FROM column_mappings'
      );
    });
  });

  // -------------------------------------------------------------------
  // getGroupingColumns
  // -------------------------------------------------------------------
  describe('getGroupingColumns', () => {
    it('should return grouping columns ordered by position', async () => {
      mockedDb.all.mockResolvedValue([
        { canonical_name: 'supplier_name', position: 0 },
        { canonical_name: 'invoice_date', position: 1 },
        { canonical_name: 'po_number', position: 2 },
      ]);

      const result = await getGroupingColumns();

      expect(result).toEqual(['supplier_name', 'invoice_date', 'po_number']);
    });

    it('should return empty array when no grouping columns exist', async () => {
      mockedDb.all.mockResolvedValue([]);

      const result = await getGroupingColumns();

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // importCSV
  // -------------------------------------------------------------------
  describe('importCSV', () => {
    const csvContent =
      'Vendor,Amount,Date,Description\nAcme Corp,1500.00,2024-01-15,Office Supplies\nGlobex Inc,3200.50,2024-01-20,IT Equipment\n';
    const csvBuffer = Buffer.from(csvContent, 'utf-8');

    function setupImportMocks() {
      // Mock fs
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(csvBuffer);

      // Mock getMappings: first call for getMappings, second for existing columns query
      let allCallCount = 0;
      mockedDb.all.mockImplementation(async (sql: string) => {
        if (sql.includes('column_mappings')) {
          return [
            { canonical_name: 'supplier_name', csv_column_name: 'Vendor' },
            { canonical_name: 'spend_amount', csv_column_name: 'Amount' },
            { canonical_name: 'invoice_date', csv_column_name: 'Date' },
            {
              canonical_name: 'line_description',
              csv_column_name: 'Description',
            },
          ];
        }
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
          ];
        }
        return [];
      });

      // Mock get for supplier existence checks
      mockedDb.get.mockResolvedValue(undefined);

      // Mock run to succeed
      mockedDb.run.mockResolvedValue(undefined);
    }

    it('should import CSV rows and return the row count', async () => {
      setupImportMocks();

      const result = await importCSV('/path/to/data.csv');

      expect(result.rowsInserted).toBe(2);
    });

    it('should throw when file path is empty', async () => {
      await expect(importCSV('')).rejects.toThrow(
        'File path must not be empty'
      );
    });

    it('should throw when file does not exist', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      await expect(importCSV('/nonexistent.csv')).rejects.toThrow(
        'File not found'
      );
    });

    it('should throw when no column mappings are saved', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(csvBuffer);
      mockedDb.all.mockResolvedValue([]); // no mappings

      await expect(importCSV('/path/to/data.csv')).rejects.toThrow(
        'No column mappings found'
      );
    });

    it('should ALTER TABLE to add missing canonical columns', async () => {
      setupImportMocks();

      await importCSV('/path/to/data.csv');

      // All four canonical columns should be added since they're not in the existing columns
      const alterCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('ALTER TABLE')
      );

      // 4 canonical columns = 4 ALTER statements
      expect(alterCalls.length).toBe(4);

      // Verify canonical columns are added
      const alterSqls = alterCalls.map((c) => c[0] as string);
      expect(alterSqls).toContainEqual(
        expect.stringContaining('"supplier_name"')
      );
      expect(alterSqls).toContainEqual(
        expect.stringContaining('"spend_amount"')
      );
      expect(alterSqls).toContainEqual(
        expect.stringContaining('"invoice_date"')
      );
      expect(alterSqls).toContainEqual(
        expect.stringContaining('"line_description"')
      );
    });

    it('should INSERT rows with mapped canonical column values', async () => {
      setupImportMocks();

      await importCSV('/path/to/data.csv');

      // Find INSERT INTO transactions calls
      const insertCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO transactions')
      );

      expect(insertCalls).toHaveLength(2);

      // First row: Acme Corp, 1500.00, 2024-01-15, Office Supplies
      const firstRow = insertCalls[0];
      const firstSql = firstRow[0] as string;
      expect(firstSql).toContain('"supplier_name"');
      expect(firstSql).toContain('"spend_amount"');
      expect(firstSql).toContain('"invoice_date"');
      expect(firstSql).toContain('"line_description"');
      // Params: id, row_index, supplier_name, spend_amount, invoice_date, line_description
      expect(firstRow[1]).toBe('test-uuid-1'); // id
      expect(firstRow[2]).toBe(1); // row_index
      expect(firstRow[3]).toBe('Acme Corp'); // supplier_name
      expect(firstRow[4]).toBe('1500.00'); // spend_amount
      expect(firstRow[5]).toBe('2024-01-15'); // invoice_date
      expect(firstRow[6]).toBe('Office Supplies'); // line_description

      // Second row
      const secondRow = insertCalls[1];
      expect(secondRow[1]).toBe('test-uuid-2'); // id
      expect(secondRow[2]).toBe(2); // row_index
      expect(secondRow[3]).toBe('Globex Inc'); // supplier_name
    });

    it('should INSERT distinct suppliers into project_suppliers', async () => {
      setupImportMocks();

      await importCSV('/path/to/data.csv');

      const supplierInsertCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO project_suppliers')
      );

      // Two distinct suppliers: Acme Corp, Globex Inc
      expect(supplierInsertCalls).toHaveLength(2);

      const supplierNames = supplierInsertCalls.map((c) => c[2]);
      expect(supplierNames).toContain('Acme Corp');
      expect(supplierNames).toContain('Globex Inc');
    });

    it('should not insert duplicate suppliers', async () => {
      setupImportMocks();

      // Simulate Acme Corp already exists
      mockedDb.get.mockImplementation(async (_sql: string, ...params: unknown[]) => {
        const name = params[0];
        if (name === 'Acme Corp') {
          return { id: 'existing-id' };
        }
        return undefined;
      });

      await importCSV('/path/to/data.csv');

      const supplierInsertCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO project_suppliers')
      );

      // Only Globex Inc should be inserted
      expect(supplierInsertCalls).toHaveLength(1);
      expect(supplierInsertCalls[0][2]).toBe('Globex Inc');
    });

    it('should update transaction_count and total_spend on suppliers', async () => {
      setupImportMocks();

      await importCSV('/path/to/data.csv');

      const updateCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE project_suppliers SET transaction_count')
      );

      expect(updateCalls).toHaveLength(2);

      // Find the Acme Corp update
      const acmeUpdate = updateCalls.find((c) => c[3] === 'Acme Corp');
      expect(acmeUpdate).toBeDefined();
      expect(acmeUpdate![1]).toBe(1); // transaction_count
      expect(acmeUpdate![2]).toBe(1500.0); // total_spend

      // Find the Globex Inc update
      const globexUpdate = updateCalls.find((c) => c[3] === 'Globex Inc');
      expect(globexUpdate).toBeDefined();
      expect(globexUpdate![1]).toBe(1); // transaction_count
      expect(globexUpdate![2]).toBe(3200.5); // total_spend
    });

    it('should generate sequential row_index values', async () => {
      setupImportMocks();

      await importCSV('/path/to/data.csv');

      const insertCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO transactions')
      );

      expect(insertCalls[0][2]).toBe(1); // row_index for first row
      expect(insertCalls[1][2]).toBe(2); // row_index for second row
    });

    it('should generate unique UUIDs for each row', async () => {
      setupImportMocks();

      await importCSV('/path/to/data.csv');

      const insertCalls = mockedDb.run.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO transactions')
      );

      const ids = insertCalls.map((c) => c[1]);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]).toBe('test-uuid-1');
      expect(ids[1]).toBe('test-uuid-2');
    });
  });
});
