import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupplierService } from '../../../src/main/services/supplier-service';
import { createMockDatabase, createMockSupplierUniverse } from '../../helpers/mock-services';
import type { Database, SupplierUniverse } from '../../../src/shared/types/services';

describe('SupplierService', () => {
  let db: Database;
  let supplierUniverse: SupplierUniverse;
  let service: SupplierService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    supplierUniverse = createMockSupplierUniverse();
    service = new SupplierService(db, supplierUniverse);
  });

  describe('normalizeSupplierName', () => {
    it('should create a new project_supplier and return its id', async () => {
      // All db.get calls return undefined: no canonical match, no alias match, no universe info
      vi.mocked(db.get).mockResolvedValue(undefined);
      vi.mocked(db.run).mockResolvedValue(undefined);

      const id = await service.normalizeSupplierName('Walmart Inc');
      expect(id).toBeTruthy();
      // INSERT uses 3 params: id, supplier_name (cleaned), universe_match
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO project_suppliers'),
        expect.anything(),
        'Walmart',   // cleanSupplierName strips "Inc"
        false
      );
    });

    it('should return existing supplier id if canonical already exists', async () => {
      vi.mocked(db.get).mockResolvedValue({ id: 'existing-id' });

      const id = await service.normalizeSupplierName('Walmart Inc');
      expect(id).toBe('existing-id');
    });

    it('should return existing supplier id if raw name matches an existing alias', async () => {
      // First get (canonical lookup) returns nothing, second get (alias lookup) finds a match
      vi.mocked(db.get)
        .mockResolvedValueOnce(undefined)  // canonical lookup
        .mockResolvedValueOnce({ project_supplier_id: 'alias-matched-id' }); // alias lookup

      const id = await service.normalizeSupplierName('WALMART INC');
      expect(id).toBe('alias-matched-id');
    });
  });

  describe('listProjectSuppliers', () => {
    it('should return project suppliers with transaction aggregates', async () => {
      vi.mocked(db.all).mockResolvedValue([
        {
          id: 'sup1',
          supplier_name: 'Acme',
          confirmation_status: 'pending',
          is_tail_spend: false,
          parent_supplier_name: null,
          data_source: 'manual',
          universe_match: false,
          created_at: '2026-01-01',
          transaction_count: 5,
          total_spend: 25000,
        },
      ]);

      const suppliers = await service.listProjectSuppliers();
      expect(suppliers).toHaveLength(1);
      expect(suppliers[0].supplierName).toBe('Acme');
      expect(suppliers[0].transactionCount).toBe(5);
      expect(suppliers[0].totalSpend).toBe(25000);
    });

    it('should return empty array when no suppliers', async () => {
      vi.mocked(db.all).mockResolvedValue([]);
      const suppliers = await service.listProjectSuppliers();
      expect(suppliers).toHaveLength(0);
    });
  });

  describe('confirmSupplier', () => {
    it('should update confirmation status', async () => {
      await service.confirmSupplier('sup1', 'confirmed');

      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE project_suppliers'),
        'confirmed',
        'sup1'
      );
    });
  });

  describe('renameSupplier', () => {
    it('should update the canonical name', async () => {
      await service.renameSupplier('sup1', 'New Acme Name');

      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE project_suppliers'),
        'New Acme Name',
        'sup1'
      );
    });
  });

  describe('assignAlias', () => {
    it('should remap transactions with alias to canonical supplier', async () => {
      vi.mocked(db.get).mockResolvedValue({ id: 'sup1' });
      vi.mocked(db.run).mockResolvedValue(undefined);

      await service.assignAlias('sup1', 'WALMART INC');

      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE transactions'),
        'sup1',
        'WALMART INC'
      );
    });

    it('should throw if supplier does not exist', async () => {
      vi.mocked(db.get).mockResolvedValue(undefined);

      await expect(service.assignAlias('bad-id', 'WALMART INC'))
        .rejects.toThrow('Supplier not found');
    });
  });

  describe('mergeParents', () => {
    it('should reassign child suppliers from losing parents to survivor and delete losers', async () => {
      // Survivor exists in supplier_parents
      vi.mocked(db.get).mockResolvedValue({ id: 'parent-survivor' });
      vi.mocked(db.run).mockResolvedValue(undefined);

      await service.mergeParents('parent-survivor', ['parent-loser-1', 'parent-loser-2']);

      // Reassign child suppliers
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE project_suppliers SET parent_supplier_id = ?'),
        'parent-survivor',
        'parent-loser-1',
        'parent-loser-2'
      );
      // Delete losing parent rows
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM supplier_parents'),
        'parent-loser-1',
        'parent-loser-2'
      );
    });

    it('should preserve aliases — transactions are untouched during parent merge', async () => {
      vi.mocked(db.get).mockResolvedValue({ id: 'parent-survivor' });
      vi.mocked(db.run).mockResolvedValue(undefined);

      await service.mergeParents('parent-survivor', ['parent-loser-1']);

      // transactions table must not be touched — aliases live on original_supplier_name
      const runCalls = vi.mocked(db.run).mock.calls;
      const touchesTransactions = runCalls.some(([sql]) =>
        typeof sql === 'string' && sql.toLowerCase().includes('transactions')
      );
      expect(touchesTransactions).toBe(false);
    });

    it('should throw if survivorId is a supplier ID, not a parent ID', async () => {
      // supplier_parents lookup returns nothing — this is a supplier ID, not a parent ID
      vi.mocked(db.get).mockResolvedValue(undefined);

      await expect(service.mergeParents('supplier-id-not-parent', ['parent-loser-1']))
        .rejects.toThrow('Survivor is not a valid parent');
    });

    it('should throw if survivor is included in losingIds', async () => {
      await expect(service.mergeParents('parent-a', ['parent-a', 'parent-b']))
        .rejects.toThrow('Survivor cannot be one of the losing parents');
    });

    it('should no-op when losingIds is empty', async () => {
      await service.mergeParents('parent-survivor', []);
      expect(db.run).not.toHaveBeenCalled();
    });
  });

  describe('filterTailSpend', () => {
    it('should return supplier IDs below threshold', async () => {
      // transactionColumnExists checks for spend_amount via db.get
      vi.mocked(db.get).mockResolvedValue({ cnt: 1 });
      vi.mocked(db.all).mockResolvedValue([{ id: 'sup-small' }]);

      const ids = await service.filterTailSpend(1000);
      expect(ids).toEqual(['sup-small']);
      expect(db.all).toHaveBeenCalledWith(
        expect.stringContaining('HAVING'),
        1000
      );
    });
  });

  describe('syncToUniverse', () => {
    it('should pass categoryASupplier to upsertSupplierFull', async () => {
      // getProjectSupplier query
      vi.mocked(db.get).mockResolvedValue({
        id: 'sup1',
        supplier_name: 'Acme',
        confirmation_status: 'pending',
        is_tail_spend: false,
        parent_supplier_id: null,
        parent_name: null,
        universe_match: true,
        is_researched: true,
        category_a_supplier: true,
        supplier_info: JSON.stringify({ industry: 'Tech' }),
        mapped_taxonomy_paths: JSON.stringify(['Corporate Services|IT|Software']),
        l1_l2_path: null,
        created_at: '2026-01-01',
      });
      // getProjectAliases query
      vi.mocked(db.all).mockResolvedValue([]);

      const result = await service.syncToUniverse(['sup1']);

      expect(result.synced).toBe(1);
      expect(supplierUniverse.upsertSupplierFull).toHaveBeenCalledWith(
        'Acme',
        expect.objectContaining({
          categoryASupplier: true,
          mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
        })
      );
    });

    it('should pass categoryASupplier=false when supplier is not cat A', async () => {
      vi.mocked(db.get).mockResolvedValue({
        id: 'sup2',
        supplier_name: 'RegularCo',
        confirmation_status: 'pending',
        is_tail_spend: false,
        parent_supplier_id: null,
        parent_name: null,
        universe_match: false,
        is_researched: true,
        category_a_supplier: false,
        supplier_info: null,
        mapped_taxonomy_paths: null,
        l1_l2_path: null,
        created_at: '2026-01-01',
      });
      vi.mocked(db.all).mockResolvedValue([]);

      const result = await service.syncToUniverse(['sup2']);

      expect(result.synced).toBe(1);
      expect(supplierUniverse.upsertSupplierFull).toHaveBeenCalledWith(
        'RegularCo',
        expect.objectContaining({
          categoryASupplier: false,
        })
      );
    });

    it('should return error when universe not configured', async () => {
      vi.mocked(supplierUniverse.isOpen).mockReturnValue(false);

      const result = await service.syncToUniverse(['sup1']);

      expect(result.synced).toBe(0);
      expect(result.errors).toContain('Supplier universe not configured');
      expect(supplierUniverse.upsertSupplierFull).not.toHaveBeenCalled();
    });
  });
});
