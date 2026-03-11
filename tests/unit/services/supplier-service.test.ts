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
      // No existing supplier
      vi.mocked(db.get).mockResolvedValue(undefined);
      vi.mocked(db.run).mockResolvedValue(undefined);

      const id = await service.normalizeSupplierName('Acme Corp');
      expect(id).toBeTruthy();
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO project_suppliers'),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('should return existing supplier id if already normalized', async () => {
      vi.mocked(db.get).mockResolvedValue({ id: 'existing-id', supplier_name: 'Acme Corp' });

      const id = await service.normalizeSupplierName('Acme Corp');
      expect(id).toBe('existing-id');
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

  describe('addAlias', () => {
    it('should remap transactions with alias to canonical supplier', async () => {
      // Must find the canonical supplier in project_suppliers
      vi.mocked(db.get).mockResolvedValue({ id: 'sup1', supplier_name: 'Acme Corp' });
      vi.mocked(db.run).mockResolvedValue(undefined);

      await service.addAlias('Acme Corp', 'ACME');

      // Should update transactions with the alias
      expect(db.run).toHaveBeenCalled();
    });
  });

  describe('filterTailSpend', () => {
    it('should return supplier IDs below threshold', async () => {
      vi.mocked(db.all).mockResolvedValue([
        { id: 'sup-small' },
      ]);

      const ids = await service.filterTailSpend(1000);
      expect(ids).toEqual(['sup-small']);
      expect(db.all).toHaveBeenCalledWith(
        expect.stringContaining('HAVING'),
        1000
      );
    });
  });
});
