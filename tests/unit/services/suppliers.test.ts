import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database services (v2: both databaseService and supplierUniverseService)
vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    run: vi.fn(),
    all: vi.fn(),
    get: vi.fn(),
  },
  supplierUniverseService: {
    run: vi.fn(),
    all: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock uuid to return predictable values
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}));

import { databaseService, supplierUniverseService } from '../../../src/main/services/database';
import {
  listProjectSuppliers,
  getSupplierByName,
  getSuppliersByNames,
  updateSupplier,
  upsertSupplier,
} from '../../../src/main/services/suppliers';
import type { SupplierInfo, ProjectSupplierView } from '../../../src/shared/types/suppliers';

const mockedDb = vi.mocked(databaseService);
const mockedUniverse = vi.mocked(supplierUniverseService);

/** Helper to create a fake supplier_universe.db row (snake_case columns). */
function makeUniverseRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'sup-1',
    supplier_name: 'Acme Corp',
    aliases: null,
    parent_supplier_id: null,
    parent_name: null,
    supplier_info: null,
    category_a: false,
    category_a_taxonomy_node_id: null,
    created_at: '2025-01-01T00:00:00',
    updated_at: '2025-01-01T00:00:00',
    ...overrides,
  };
}

/** Helper to create a fake project DB transaction aggregate row. */
function makeProjectRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    supplier_name: 'Acme Corp',
    transaction_count: 5,
    total_spend: 10000.5,
    ...overrides,
  };
}

describe('SuppliersService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listProjectSuppliers', () => {
    it('should return all project suppliers with enriched universe data', async () => {
      // First call: column-existence check for supplier_name
      mockedDb.all.mockResolvedValueOnce([{ column_name: 'supplier_name' }]);
      // Second call: transaction aggregates from the project DB
      mockedDb.all.mockResolvedValueOnce([
        makeProjectRow(),
        makeProjectRow({
          supplier_name: 'Beta Inc',
          transaction_count: 10,
          total_spend: 25000,
        }),
      ]);

      // supplierUniverseService.all returns matching supplier universe rows
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow(),
        makeUniverseRow({
          id: 'sup-2',
          supplier_name: 'Beta Inc',
          category_a: true,
        }),
      ]);

      const result = await listProjectSuppliers();

      // Project DB queried: first for column check, then for transaction aggregates
      expect(mockedDb.all).toHaveBeenCalledTimes(2);
      expect(mockedDb.all).toHaveBeenCalledWith(
        expect.stringContaining('FROM transactions')
      );

      // Supplier universe queried for enrichment
      expect(mockedUniverse.all).toHaveBeenCalledOnce();
      expect(mockedUniverse.all).toHaveBeenCalledWith(
        expect.stringContaining('FROM suppliers WHERE supplier_name IN'),
        'Acme Corp',
        'Beta Inc'
      );

      expect(result).toHaveLength(2);

      expect(result[0]).toEqual<ProjectSupplierView>({
        supplierName: 'Acme Corp',
        transactionCount: 5,
        totalSpend: 10000.5,
        supplierInfo: null,
        parentName: null,
        categoryA: false,
        categoryATaxonomyNodeId: null,
        isResearched: true,
      });

      expect(result[1].supplierName).toBe('Beta Inc');
      expect(result[1].categoryA).toBe(true);
      expect(result[1].isResearched).toBe(true);
    });

    it('should return an empty array when there are no suppliers in transactions', async () => {
      mockedDb.all.mockResolvedValue([]);

      const result = await listProjectSuppliers();

      expect(result).toEqual([]);
      // Should not even query the universe if there are no project suppliers
      expect(mockedUniverse.all).not.toHaveBeenCalled();
    });

    it('should mark suppliers as not researched when missing from universe', async () => {
      mockedDb.all.mockResolvedValue([
        makeProjectRow({ supplier_name: 'Unknown Vendor' }),
      ]);

      // Universe has no match for this supplier
      mockedUniverse.all.mockResolvedValue([]);

      const result = await listProjectSuppliers();

      expect(result).toHaveLength(1);
      expect(result[0].supplierName).toBe('Unknown Vendor');
      expect(result[0].isResearched).toBe(false);
      expect(result[0].supplierInfo).toBeNull();
      expect(result[0].parentName).toBeNull();
      expect(result[0].categoryA).toBe(false);
    });

    it('should parse supplier_info JSON from universe data', async () => {
      const info: SupplierInfo = {
        officialBusinessName: 'Acme Corporation',
        industry: 'Technology',
        websiteUrl: 'https://acme.com',
      };

      mockedDb.all.mockResolvedValue([makeProjectRow()]);
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow({ supplier_info: JSON.stringify(info) }),
      ]);

      const result = await listProjectSuppliers();

      expect(result[0].supplierInfo).toEqual(info);
    });

    it('should handle invalid supplier_info JSON gracefully', async () => {
      mockedDb.all.mockResolvedValue([makeProjectRow()]);
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow({ supplier_info: '{bad json' }),
      ]);

      const result = await listProjectSuppliers();

      expect(result[0].supplierInfo).toBeNull();
    });
  });

  describe('getSupplierByName', () => {
    it('should return a supplier when found in the universe', async () => {
      mockedUniverse.get.mockResolvedValue(makeUniverseRow());

      const result = await getSupplierByName('Acme Corp');

      expect(mockedUniverse.get).toHaveBeenCalledWith(
        expect.stringContaining('WHERE supplier_name = ?'),
        'Acme Corp'
      );

      expect(result).not.toBeNull();
      expect(result!.supplierName).toBe('Acme Corp');
      expect(result!.id).toBe('sup-1');
    });

    it('should return null when supplier is not found', async () => {
      mockedUniverse.get.mockResolvedValue(undefined);

      const result = await getSupplierByName('Nonexistent');

      expect(result).toBeNull();
    });

    it('should parse supplier_info JSON from a single row', async () => {
      const info: SupplierInfo = {
        description: 'A test supplier',
        naicsCode: '541511',
        naicsDescription: 'Custom Computer Programming Services',
      };

      mockedUniverse.get.mockResolvedValue(
        makeUniverseRow({ supplier_info: JSON.stringify(info) })
      );

      const result = await getSupplierByName('Acme Corp');

      expect(result!.supplierInfo).toEqual(info);
    });
  });

  describe('getSuppliersByNames', () => {
    it('should return a map of suppliers keyed by name', async () => {
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow({ supplier_name: 'Acme Corp' }),
        makeUniverseRow({ id: 'sup-2', supplier_name: 'Beta Inc', category_a: true }),
      ]);

      const result = await getSuppliersByNames(['Acme Corp', 'Beta Inc']);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get('Acme Corp')!.supplierName).toBe('Acme Corp');
      expect(result.get('Beta Inc')!.categoryA).toBe(true);
    });

    it('should return an empty map for an empty names array', async () => {
      const result = await getSuppliersByNames([]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      // Should not even query the universe
      expect(mockedUniverse.all).not.toHaveBeenCalled();
    });

    it('should handle partial matches (only some names found)', async () => {
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow({ supplier_name: 'Acme Corp' }),
      ]);

      const result = await getSuppliersByNames(['Acme Corp', 'Missing Inc']);

      expect(result.size).toBe(1);
      expect(result.has('Acme Corp')).toBe(true);
      expect(result.has('Missing Inc')).toBe(false);
    });
  });

  describe('updateSupplier', () => {
    it('should update categoryA field in supplier universe', async () => {
      await updateSupplier('Acme Corp', { categoryA: true });

      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('UPDATE suppliers SET');
      expect(sql).toContain('category_a = ?');
      expect(sql).toContain('updated_at = CURRENT_TIMESTAMP');
      expect(sql).toContain('WHERE supplier_name = ?');
      expect(params).toContain(true);
      expect(params[params.length - 1]).toBe('Acme Corp');
    });

    it('should update categoryATaxonomyNodeId field', async () => {
      await updateSupplier('Acme Corp', {
        categoryATaxonomyNodeId: 'node-123',
      });

      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('category_a_taxonomy_node_id = ?');
      expect(params).toContain('node-123');
    });

    it('should update parentSupplierId field', async () => {
      await updateSupplier('Acme Corp', { parentSupplierId: 'parent-1' });

      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('parent_supplier_id = ?');
      expect(params).toContain('parent-1');
    });

    it('should allow setting parentSupplierId to null', async () => {
      await updateSupplier('Acme Corp', { parentSupplierId: null });

      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('parent_supplier_id = ?');
      expect(params).toContain(null);
    });

    it('should JSON.stringify supplierInfo when updating', async () => {
      const info: SupplierInfo = {
        officialBusinessName: 'Acme Corporation',
        industry: 'Technology',
      };

      await updateSupplier('Acme Corp', { supplierInfo: info });

      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('supplier_info = ?');
      expect(params).toContain(JSON.stringify(info));
    });

    it('should update multiple fields at once', async () => {
      await updateSupplier('Acme Corp', {
        categoryA: true,
        categoryATaxonomyNodeId: 'node-456',
      });

      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('category_a = ?');
      expect(sql).toContain('category_a_taxonomy_node_id = ?');
      expect(sql).toContain('updated_at = CURRENT_TIMESTAMP');
    });

    it('should not call supplierUniverseService.run when no updates are provided', async () => {
      await updateSupplier('Acme Corp', {});

      expect(mockedUniverse.run).not.toHaveBeenCalled();
    });
  });

  describe('upsertSupplier', () => {
    it('should insert a new supplier when it does not exist', async () => {
      mockedUniverse.get.mockResolvedValue(undefined);

      await upsertSupplier('New Supplier', {
        categoryA: false,
      });

      // First call: getSupplierByName check
      expect(mockedUniverse.get).toHaveBeenCalledOnce();

      // Second call: INSERT into suppliers (supplier_universe.db)
      expect(mockedUniverse.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('INSERT INTO suppliers');
      expect(params[0]).toBe('test-uuid-1234'); // id from mocked uuid
      expect(params[1]).toBe('New Supplier');    // supplier_name
      expect(params[2]).toBeNull();              // aliases
      expect(params[6]).toBe(false);             // category_a
    });

    it('should update an existing supplier', async () => {
      mockedUniverse.get.mockResolvedValue(makeUniverseRow());

      await upsertSupplier('Acme Corp', {
        categoryA: true,
      });

      // get is called once for the existence check
      expect(mockedUniverse.get).toHaveBeenCalledOnce();

      // run is called for the updateSupplier path
      expect(mockedUniverse.run).toHaveBeenCalled();
      const [sql] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('UPDATE suppliers SET');
    });

    it('should insert with default values when optional fields are omitted', async () => {
      mockedUniverse.get.mockResolvedValue(undefined);

      await upsertSupplier('Minimal Supplier', {});

      const [sql, ...params] = mockedUniverse.run.mock.calls[0];
      expect(sql).toContain('INSERT INTO suppliers');
      expect(params[0]).toBe('test-uuid-1234');    // id
      expect(params[1]).toBe('Minimal Supplier');  // supplier_name
      expect(params[2]).toBeNull();                // aliases
      expect(params[3]).toBeNull();                // parent_supplier_id
      expect(params[4]).toBeNull();                // parent_name
      expect(params[5]).toBeNull();                // supplier_info
      expect(params[6]).toBe(false);               // category_a
      expect(params[7]).toBeNull();                // category_a_taxonomy_node_id
    });

    it('should JSON.stringify supplierInfo when inserting', async () => {
      mockedUniverse.get.mockResolvedValue(undefined);

      const info: SupplierInfo = {
        officialBusinessName: 'New Corp',
        websiteUrl: 'https://newcorp.com',
      };

      await upsertSupplier('New Corp', {
        supplierInfo: info,
      });

      const [, ...params] = mockedUniverse.run.mock.calls[0];
      // supplier_info is the 6th param (index 5) — after id, supplier_name, aliases, parent_supplier_id, parent_name
      expect(params[5]).toBe(JSON.stringify(info));
    });
  });

  describe('JSON serialization/deserialization', () => {
    it('should deserialize complex supplierInfo with all fields', async () => {
      const fullInfo: SupplierInfo = {
        officialBusinessName: 'Full Info Corp',
        description: 'A comprehensive supplier',
        websiteUrl: 'https://fullinfo.com',
        industry: 'Manufacturing',
        productsServices: 'Industrial equipment',
        supplierAddress: '123 Main St, City, State 12345',
        serviceType: 'Product & Service',
        naicsCode: '333111',
        naicsDescription: 'Farm Machinery and Equipment Manufacturing',
        sicCode: '3523',
        primaryBusinessModel: 'B2B',
        primaryRevenueStreams: 'Equipment sales, Service contracts',
        serviceCategories: 'Manufacturing, Maintenance',
        targetMarket: 'Agriculture, Industrial',
      };

      mockedDb.all.mockResolvedValue([makeProjectRow()]);
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow({ supplier_info: JSON.stringify(fullInfo) }),
      ]);

      const result = await listProjectSuppliers();

      expect(result[0].supplierInfo).toEqual(fullInfo);
      expect(result[0].supplierInfo!.officialBusinessName).toBe('Full Info Corp');
      expect(result[0].supplierInfo!.naicsCode).toBe('333111');
      expect(result[0].supplierInfo!.targetMarket).toBe('Agriculture, Industrial');
    });

    it('should handle null supplier_info from the universe database', async () => {
      mockedDb.all.mockResolvedValue([makeProjectRow()]);
      mockedUniverse.all.mockResolvedValue([
        makeUniverseRow({ supplier_info: null }),
      ]);

      const result = await listProjectSuppliers();

      expect(result[0].supplierInfo).toBeNull();
    });

    it('should serialize supplierInfo to JSON when writing via update', async () => {
      const info: SupplierInfo = {
        officialBusinessName: 'Serialized Corp',
        naicsCode: '541511',
      };

      await updateSupplier('Test Supplier', { supplierInfo: info });

      const [, ...params] = mockedUniverse.run.mock.calls[0];
      const jsonParam = params.find(
        (p) => typeof p === 'string' && p.includes('Serialized Corp')
      );
      expect(jsonParam).toBeDefined();
      expect(JSON.parse(jsonParam as string)).toEqual(info);
    });

    it('should serialize supplierInfo to JSON when writing via upsert (insert path)', async () => {
      mockedUniverse.get.mockResolvedValue(undefined);

      const info: SupplierInfo = {
        description: 'Upserted supplier',
        industry: 'Finance',
      };

      await upsertSupplier('Upsert Test', {
        supplierInfo: info,
      });

      const [, ...params] = mockedUniverse.run.mock.calls[0];
      // supplier_info is the 6th param (index 5): id, supplier_name, aliases, parent_supplier_id, parent_name, supplier_info
      expect(params[5]).toBe(JSON.stringify(info));
    });
  });
});
