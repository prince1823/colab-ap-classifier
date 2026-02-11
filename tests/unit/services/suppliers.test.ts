import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database service
vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    run: vi.fn(),
    all: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock uuid to return predictable values
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}));

import { databaseService } from '../../../src/main/services/database';
import {
  listSuppliers,
  getSupplierByName,
  updateSupplier,
  upsertSupplier,
} from '../../../src/main/services/suppliers';
import type { ProjectSupplier, SupplierInfo } from '../../../src/shared/types/suppliers';

const mockedDb = vi.mocked(databaseService);

/** Helper to create a fake DB row in snake_case format. */
function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'sup-1',
    supplier_name: 'Acme Corp',
    parent_supplier_id: null,
    supplier_type: 'company',
    supplier_info: null,
    category_a: false,
    category_a_taxonomy_node_id: null,
    transaction_count: 5,
    total_spend: 10000.5,
    created_at: '2025-01-01T00:00:00',
    updated_at: '2025-01-01T00:00:00',
    ...overrides,
  };
}

describe('SuppliersService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listSuppliers', () => {
    it('should return all suppliers mapped to camelCase', async () => {
      mockedDb.all.mockResolvedValue([
        makeRow(),
        makeRow({
          id: 'sup-2',
          supplier_name: 'Beta Inc',
          supplier_type: 'individual',
          category_a: true,
          transaction_count: 10,
          total_spend: 25000,
        }),
      ]);

      const result = await listSuppliers();

      expect(mockedDb.all).toHaveBeenCalledOnce();
      expect(mockedDb.all).toHaveBeenCalledWith(
        expect.stringContaining('FROM project_suppliers ORDER BY supplier_name')
      );

      expect(result).toHaveLength(2);

      expect(result[0]).toEqual<ProjectSupplier>({
        id: 'sup-1',
        supplierName: 'Acme Corp',
        parentSupplierId: null,
        supplierType: 'company',
        supplierInfo: null,
        categoryA: false,
        categoryATaxonomyNodeId: null,
        transactionCount: 5,
        totalSpend: 10000.5,
        createdAt: '2025-01-01T00:00:00',
        updatedAt: '2025-01-01T00:00:00',
      });

      expect(result[1].supplierName).toBe('Beta Inc');
      expect(result[1].supplierType).toBe('individual');
      expect(result[1].categoryA).toBe(true);
    });

    it('should return an empty array when there are no suppliers', async () => {
      mockedDb.all.mockResolvedValue([]);

      const result = await listSuppliers();

      expect(result).toEqual([]);
    });

    it('should parse supplier_info JSON', async () => {
      const info: SupplierInfo = {
        officialBusinessName: 'Acme Corporation',
        industry: 'Technology',
        websiteUrl: 'https://acme.com',
      };

      mockedDb.all.mockResolvedValue([
        makeRow({ supplier_info: JSON.stringify(info) }),
      ]);

      const result = await listSuppliers();

      expect(result[0].supplierInfo).toEqual(info);
    });

    it('should handle invalid supplier_info JSON gracefully', async () => {
      mockedDb.all.mockResolvedValue([
        makeRow({ supplier_info: '{bad json' }),
      ]);

      const result = await listSuppliers();

      expect(result[0].supplierInfo).toBeNull();
    });
  });

  describe('getSupplierByName', () => {
    it('should return a supplier when found', async () => {
      mockedDb.get.mockResolvedValue(makeRow());

      const result = await getSupplierByName('Acme Corp');

      expect(mockedDb.get).toHaveBeenCalledWith(
        expect.stringContaining('WHERE supplier_name = ?'),
        'Acme Corp'
      );

      expect(result).not.toBeNull();
      expect(result!.supplierName).toBe('Acme Corp');
      expect(result!.id).toBe('sup-1');
    });

    it('should return null when supplier is not found', async () => {
      mockedDb.get.mockResolvedValue(undefined);

      const result = await getSupplierByName('Nonexistent');

      expect(result).toBeNull();
    });

    it('should parse supplier_info JSON from a single row', async () => {
      const info: SupplierInfo = {
        description: 'A test supplier',
        naicsCode: '541511',
        naicsDescription: 'Custom Computer Programming Services',
      };

      mockedDb.get.mockResolvedValue(
        makeRow({ supplier_info: JSON.stringify(info) })
      );

      const result = await getSupplierByName('Acme Corp');

      expect(result!.supplierInfo).toEqual(info);
    });
  });

  describe('updateSupplier', () => {
    it('should update categoryA field', async () => {
      await updateSupplier('Acme Corp', { categoryA: true });

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('UPDATE project_suppliers SET');
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

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('category_a_taxonomy_node_id = ?');
      expect(params).toContain('node-123');
    });

    it('should update supplierType field', async () => {
      await updateSupplier('Acme Corp', { supplierType: 'government' });

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('supplier_type = ?');
      expect(params).toContain('government');
    });

    it('should update parentSupplierId field', async () => {
      await updateSupplier('Acme Corp', { parentSupplierId: 'parent-1' });

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('parent_supplier_id = ?');
      expect(params).toContain('parent-1');
    });

    it('should allow setting parentSupplierId to null', async () => {
      await updateSupplier('Acme Corp', { parentSupplierId: null });

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('parent_supplier_id = ?');
      expect(params).toContain(null);
    });

    it('should JSON.stringify supplierInfo when updating', async () => {
      const info: SupplierInfo = {
        officialBusinessName: 'Acme Corporation',
        industry: 'Technology',
      };

      await updateSupplier('Acme Corp', { supplierInfo: info });

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('supplier_info = ?');
      expect(params).toContain(JSON.stringify(info));
    });

    it('should update multiple fields at once', async () => {
      await updateSupplier('Acme Corp', {
        categoryA: true,
        categoryATaxonomyNodeId: 'node-456',
        supplierType: 'company',
      });

      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('category_a = ?');
      expect(sql).toContain('category_a_taxonomy_node_id = ?');
      expect(sql).toContain('supplier_type = ?');
      expect(sql).toContain('updated_at = CURRENT_TIMESTAMP');
    });

    it('should not call databaseService.run when no updates are provided', async () => {
      await updateSupplier('Acme Corp', {});

      expect(mockedDb.run).not.toHaveBeenCalled();
    });
  });

  describe('upsertSupplier', () => {
    it('should insert a new supplier when it does not exist', async () => {
      mockedDb.get.mockResolvedValue(undefined);

      await upsertSupplier({
        supplierName: 'New Supplier',
        supplierType: 'company',
        categoryA: false,
      });

      // First call: getSupplierByName check
      expect(mockedDb.get).toHaveBeenCalledOnce();

      // Second call: INSERT
      expect(mockedDb.run).toHaveBeenCalledOnce();
      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('INSERT INTO project_suppliers');
      expect(params[0]).toBe('test-uuid-1234'); // id from mocked uuid
      expect(params[1]).toBe('New Supplier');    // supplier_name
      expect(params[3]).toBe('company');         // supplier_type
      expect(params[5]).toBe(false);             // category_a
    });

    it('should use provided id instead of generating one', async () => {
      mockedDb.get.mockResolvedValue(undefined);

      await upsertSupplier({
        id: 'custom-id-999',
        supplierName: 'Custom ID Supplier',
      });

      const [, ...params] = mockedDb.run.mock.calls[0];
      expect(params[0]).toBe('custom-id-999');
    });

    it('should update an existing supplier', async () => {
      mockedDb.get.mockResolvedValue(makeRow());

      await upsertSupplier({
        supplierName: 'Acme Corp',
        categoryA: true,
        supplierType: 'government',
      });

      // get is called once for the existence check
      expect(mockedDb.get).toHaveBeenCalledOnce();

      // run is called for the updateSupplier
      expect(mockedDb.run).toHaveBeenCalled();
      const [sql] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('UPDATE project_suppliers SET');
    });

    it('should insert with default values when optional fields are omitted', async () => {
      mockedDb.get.mockResolvedValue(undefined);

      await upsertSupplier({ supplierName: 'Minimal Supplier' });

      const [sql, ...params] = mockedDb.run.mock.calls[0];
      expect(sql).toContain('INSERT INTO project_suppliers');
      expect(params[0]).toBe('test-uuid-1234'); // id
      expect(params[1]).toBe('Minimal Supplier'); // supplier_name
      expect(params[2]).toBeNull();               // parent_supplier_id
      expect(params[3]).toBeNull();               // supplier_type
      expect(params[4]).toBeNull();               // supplier_info
      expect(params[5]).toBe(false);              // category_a
      expect(params[6]).toBeNull();               // category_a_taxonomy_node_id
      expect(params[7]).toBe(0);                  // transaction_count
      expect(params[8]).toBe(0);                  // total_spend
    });

    it('should JSON.stringify supplierInfo when inserting', async () => {
      mockedDb.get.mockResolvedValue(undefined);

      const info: SupplierInfo = {
        officialBusinessName: 'New Corp',
        websiteUrl: 'https://newcorp.com',
      };

      await upsertSupplier({
        supplierName: 'New Corp',
        supplierInfo: info,
      });

      const [, ...params] = mockedDb.run.mock.calls[0];
      expect(params[4]).toBe(JSON.stringify(info));
    });

    it('should update transactionCount and totalSpend on existing supplier', async () => {
      mockedDb.get.mockResolvedValue(makeRow());

      await upsertSupplier({
        supplierName: 'Acme Corp',
        transactionCount: 42,
        totalSpend: 99999.99,
      });

      // Should have at least one run call for the extra fields update
      const runCalls = mockedDb.run.mock.calls;
      const extraUpdateCall = runCalls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('transaction_count = ?')
      );
      expect(extraUpdateCall).toBeDefined();
      expect(extraUpdateCall![0]).toContain('total_spend = ?');
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
        parentCompany: 'Parent Holdings Inc',
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

      mockedDb.all.mockResolvedValue([
        makeRow({ supplier_info: JSON.stringify(fullInfo) }),
      ]);

      const result = await listSuppliers();

      expect(result[0].supplierInfo).toEqual(fullInfo);
      expect(result[0].supplierInfo!.officialBusinessName).toBe('Full Info Corp');
      expect(result[0].supplierInfo!.naicsCode).toBe('333111');
      expect(result[0].supplierInfo!.targetMarket).toBe('Agriculture, Industrial');
    });

    it('should handle null supplier_info from the database', async () => {
      mockedDb.all.mockResolvedValue([
        makeRow({ supplier_info: null }),
      ]);

      const result = await listSuppliers();

      expect(result[0].supplierInfo).toBeNull();
    });

    it('should serialize supplierInfo to JSON when writing via update', async () => {
      const info: SupplierInfo = {
        officialBusinessName: 'Serialized Corp',
        naicsCode: '541511',
      };

      await updateSupplier('Test Supplier', { supplierInfo: info });

      const [, ...params] = mockedDb.run.mock.calls[0];
      const jsonParam = params.find(
        (p) => typeof p === 'string' && p.includes('Serialized Corp')
      );
      expect(jsonParam).toBeDefined();
      expect(JSON.parse(jsonParam as string)).toEqual(info);
    });

    it('should serialize supplierInfo to JSON when writing via upsert (insert path)', async () => {
      mockedDb.get.mockResolvedValue(undefined);

      const info: SupplierInfo = {
        description: 'Upserted supplier',
        industry: 'Finance',
      };

      await upsertSupplier({
        supplierName: 'Upsert Test',
        supplierInfo: info,
      });

      const [, ...params] = mockedDb.run.mock.calls[0];
      // supplier_info is the 5th param (index 4)
      expect(params[4]).toBe(JSON.stringify(info));
    });
  });
});
