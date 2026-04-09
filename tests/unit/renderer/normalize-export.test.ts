import { describe, it, expect } from 'vitest';
import { suppliersToCSV } from '../../../src/renderer/lib/csv-normalize';
import type { AliasData } from '../../../src/renderer/lib/csv-normalize';
import type { ProjectSupplierView, SupplierParent } from '../../../src/shared/types/suppliers';

// Tests for the Normalize-page CSV export pipeline.
//
// These cover the exact code path that runs inside NormalizeView.handleExportCsv:
//   1. The renderer fetches alias spend via `ipc.suppliers.getAllAliasesWithSpend()`
//      which returns Record<string, AliasData[]>.
//   2. That record is converted to a Map<string, AliasData[]> via Object.entries().
//   3. The map is passed to suppliersToCSV() to produce one CSV row per alias.
//
// The purpose of the recent refactor was to move alias-spend loading from a
// page-mount background loader to an on-demand fetch at export time. These
// tests lock in the contract: same input → same CSV output.

function makeSupplier(overrides: Partial<ProjectSupplierView> & { id: string; supplierName: string }): ProjectSupplierView {
  return {
    id: overrides.id,
    supplierName: overrides.supplierName,
    confirmationStatus: 'pending',
    isTailSpend: false,
    parentSupplierId: null,
    parentName: null,
    supplierInfo: null,
    mappedTaxonomyPaths: null,
    universeMatch: false,
    isResearched: false,
    l1L2Path: null,
    categoryASupplier: false,
    createdAt: '2026-04-01T12:00:00Z',
    transactionCount: 0,
    totalSpend: 0,
    aliases: [],
    ...overrides,
  };
}

describe('Normalize CSV export', () => {
  describe('Object.entries → Map conversion (mirrors handleExportCsv)', () => {
    it('converts the IPC response shape to a Map keyed by supplier id', () => {
      const ipcResponse: Record<string, AliasData[]> = {
        sup1: [
          { rawName: 'ACME CORP', spend: 1000, txnCount: 4 },
          { rawName: 'ACME CO',   spend:  250, txnCount: 1 },
        ],
        sup2: [
          { rawName: 'WALMART', spend: 5000, txnCount: 12 },
        ],
      };

      const cache = new Map(Object.entries(ipcResponse));

      expect(cache.size).toBe(2);
      expect(cache.get('sup1')).toEqual([
        { rawName: 'ACME CORP', spend: 1000, txnCount: 4 },
        { rawName: 'ACME CO',   spend:  250, txnCount: 1 },
      ]);
      expect(cache.get('sup2')).toEqual([
        { rawName: 'WALMART', spend: 5000, txnCount: 12 },
      ]);
    });

    it('produces an empty map when the project has no aliases', () => {
      const cache = new Map(Object.entries({} as Record<string, AliasData[]>));
      expect(cache.size).toBe(0);
    });
  });

  describe('suppliersToCSV (the export sink)', () => {
    it('emits one row per alias with spend + txn_count from the cache', () => {
      const suppliers = [
        makeSupplier({ id: 'sup1', supplierName: 'Acme', totalSpend: 1250, transactionCount: 5 }),
        makeSupplier({ id: 'sup2', supplierName: 'Walmart', totalSpend: 5000, transactionCount: 12 }),
      ];
      const parents: SupplierParent[] = [];
      const aliasCache = new Map<string, AliasData[]>([
        ['sup1', [
          { rawName: 'ACME CORP', spend: 1000, txnCount: 4 },
          { rawName: 'ACME CO',   spend:  250, txnCount: 1 },
        ]],
        ['sup2', [
          { rawName: 'WALMART', spend: 5000, txnCount: 12 },
        ]],
      ]);

      const csv = suppliersToCSV(suppliers, parents, aliasCache);
      const lines = csv.split('\r\n');

      // header + 3 data rows (2 for Acme, 1 for Walmart)
      expect(lines[0]).toBe('parent_name,supplier_name,alias,total_spend,transaction_count,created_at');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toBe(',Acme,ACME CORP,1000,4,2026-04-01');
      expect(lines[2]).toBe(',Acme,ACME CO,250,1,2026-04-01');
      expect(lines[3]).toBe(',Walmart,WALMART,5000,12,2026-04-01');
    });

    it('emits a single placeholder row for suppliers with no aliases (using supplier-level totals)', () => {
      const suppliers = [
        makeSupplier({ id: 'sup1', supplierName: 'Lonely Co', totalSpend: 999, transactionCount: 3 }),
      ];
      const csv = suppliersToCSV(suppliers, [], new Map());
      const lines = csv.split('\r\n');

      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe(',Lonely Co,,999,3,2026-04-01');
    });

    it('writes parent_name when present', () => {
      const suppliers = [
        makeSupplier({
          id: 'sup1',
          supplierName: 'Acme East',
          parentSupplierId: 'p1',
          parentName: 'Acme Group',
          totalSpend: 100,
          transactionCount: 1,
        }),
      ];
      const cache = new Map<string, AliasData[]>([
        ['sup1', [{ rawName: 'ACME EAST LLC', spend: 100, txnCount: 1 }]],
      ]);
      const csv = suppliersToCSV(suppliers, [], cache);
      const dataLine = csv.split('\r\n')[1];
      expect(dataLine).toBe('Acme Group,Acme East,ACME EAST LLC,100,1,2026-04-01');
    });

    it('end-to-end: simulated project-mode export (IPC response → Map → CSV)', () => {
      // This mirrors the exact handleExportCsv code path:
      //   const result = await ipc.suppliers.getAllAliasesWithSpend()
      //   const cacheForExport = new Map(Object.entries(result))
      //   const csvString = suppliersToCSV(orderedSuppliers, parents, cacheForExport)
      const suppliers = [
        makeSupplier({ id: 'sup1', supplierName: 'Acme', totalSpend: 1250, transactionCount: 5 }),
      ];
      const ipcResult: Record<string, AliasData[]> = {
        sup1: [
          { rawName: 'ACME CORP', spend: 1000, txnCount: 4 },
          { rawName: 'ACME CO',   spend:  250, txnCount: 1 },
        ],
      };

      const cacheForExport = new Map(Object.entries(ipcResult));
      const csv = suppliersToCSV(suppliers, [], cacheForExport);

      const lines = csv.split('\r\n');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('ACME CORP,1000,4');
      expect(lines[2]).toContain('ACME CO,250,1');
    });
  });
});
