import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SupplierService } from '../../../src/main/services/supplier-service';
import { DuckDBDatabase } from '../../../src/main/services/database';
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
      vi.mocked(db.get)
        .mockResolvedValueOnce(undefined) // durable alias lookup
        .mockResolvedValueOnce({ id: 'existing-id' }) // canonical lookup
        .mockResolvedValueOnce(undefined); // alias upsert conflict check

      const id = await service.normalizeSupplierName('Walmart Inc');
      expect(id).toBe('existing-id');
    });

    it('should return existing supplier id if raw name matches an existing alias', async () => {
      vi.mocked(db.get).mockResolvedValueOnce({ project_supplier_id: 'alias-matched-id' });

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

  describe('getAllProjectAliasesWithSpend', () => {
    it('groups (project_supplier_id, original_supplier_name) rows into a per-supplier alias map with spend + txn counts', async () => {
      // hasSpendColumn() — information_schema lookup says spend_amount exists
      vi.mocked(db.get).mockResolvedValue({ cnt: 1 });
      vi.mocked(db.all).mockResolvedValue([
        { project_supplier_id: 'sup1', original_supplier_name: 'ACME CORP',  total_spend: 1000, txn_count: 4 },
        { project_supplier_id: 'sup1', original_supplier_name: 'ACME CO',    total_spend:  250, txn_count: 1 },
        { project_supplier_id: 'sup2', original_supplier_name: 'WALMART',    total_spend: 5000, txn_count: 12 },
      ]);

      const result = await service.getAllProjectAliasesWithSpend();

      expect(result).toEqual({
        sup1: [
          { rawName: 'ACME CORP', spend: 1000, txnCount: 4 },
          { rawName: 'ACME CO',   spend:  250, txnCount: 1 },
        ],
        sup2: [
          { rawName: 'WALMART', spend: 5000, txnCount: 12 },
        ],
      });

      // The query must be a single full scan with no IN (?, …, ?) clause —
      // that's the whole point of this method vs. the deleted batch one.
      const sql = vi.mocked(db.all).mock.calls[0][0] as string;
      expect(sql).toContain('FROM transactions');
      expect(sql).toContain('GROUP BY t.project_supplier_id, t.original_supplier_name');
      expect(sql).not.toMatch(/IN\s*\(/);
    });

    it('returns empty object when no transactions match', async () => {
      vi.mocked(db.get).mockResolvedValue({ cnt: 1 });
      vi.mocked(db.all).mockResolvedValue([]);
      const result = await service.getAllProjectAliasesWithSpend();
      expect(result).toEqual({});
    });

    it('falls back to spend=0 when transactions table has no spend_amount column', async () => {
      vi.mocked(db.get).mockResolvedValue({ cnt: 0 });  // hasSpendColumn → false
      vi.mocked(db.all).mockResolvedValue([
        { project_supplier_id: 'sup1', original_supplier_name: 'ACME', total_spend: 0, txn_count: 3 },
      ]);
      const result = await service.getAllProjectAliasesWithSpend();
      expect(result.sup1).toEqual([{ rawName: 'ACME', spend: 0, txnCount: 3 }]);

      const sql = vi.mocked(db.all).mock.calls[0][0] as string;
      expect(sql).not.toContain('TRY_CAST');
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

  // ── computeCsvDiff ──────────────────────────────────────────────────────────
  // DB state is set via three sequential db.all calls:
  //   1st: aliasRows    — project_supplier_aliases JOIN project_suppliers
  //   2nd: parentRows   — supplier_parents table
  //   3rd: supplierRows — all project_suppliers, including suppliers with no aliases

  describe('computeCsvDiff', () => {
    type AliasRow = {
      original_supplier_name: string;
      project_supplier_id: string;
      supplier_name: string;
      parent_supplier_id: string | null;
      parent_name: string | null;
    };
    type ParentRow = { id: string; name: string };
    type SupplierRow = { id: string; supplier_name: string };

    function setupDb(aliasRows: AliasRow[], parentRows: ParentRow[] = [], supplierRows?: SupplierRow[]) {
      const suppliers = supplierRows ?? Array.from(
        new Map(aliasRows.map((r) => [r.project_supplier_id, {
          id: r.project_supplier_id,
          supplier_name: r.supplier_name,
        }])).values()
      );
      vi.mocked(db.all)
        .mockResolvedValueOnce(aliasRows)
        .mockResolvedValueOnce(parentRows)
        .mockResolvedValueOnce(suppliers);
    }

    it('detects a supplier rename', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corporation', aliases: ['ACME CORP'], parentName: null },
      ]);

      expect(diff.renames).toHaveLength(1);
      expect(diff.renames[0]).toMatchObject({ supplierId: 's1', oldName: 'Acme Corp', newName: 'Acme Corporation' });
      expect(diff.merges).toHaveLength(0);
      expect(diff.aliasReassignments).toHaveLength(0);
    });

    it('detects no changes when CSV exactly matches DB', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
      ]);

      expect(diff.renames).toHaveLength(0);
      expect(diff.merges).toHaveLength(0);
      expect(diff.aliasReassignments).toHaveLength(0);
      expect(diff.parentChanges).toHaveLength(0);
      expect(diff.warnings.missingAliases).toHaveLength(0);
    });

    it('matches CSV aliases case-insensitively to mirror supplier normalization', async () => {
      setupDb([
        { original_supplier_name: 'ACME INC', project_supplier_id: 's1', supplier_name: 'Acme', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme', aliases: ['Acme Inc'], parentName: null },
      ]);

      expect(diff.warnings.unknownAliases).toHaveLength(0);
      expect(diff.warnings.unmatchableRows).toHaveLength(0);
      expect(diff.warnings.missingAliases).toHaveLength(0);
      expect(diff.renames).toHaveLength(0);
    });

    it('detects duplicate CSV aliases case-insensitively', async () => {
      setupDb([]);

      await expect(service.computeCsvDiff([
        { supplierName: 'Acme A', aliases: ['ACME INC'], parentName: null },
        { supplierName: 'Acme B', aliases: ['Acme Inc'], parentName: null },
      ])).rejects.toThrow('appears in both');
    });

    it('merges CSV rows that span multiple supplier alias owners', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME CORPORATION', project_supplier_id: 's2', supplier_name: 'Acme Corporation', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corporation', aliases: ['ACME CORP', 'ACME CORPORATION'], parentName: null },
      ]);

      expect(diff.merges).toHaveLength(1);
      expect(diff.merges[0]).toMatchObject({
        survivorId: 's2',
        survivorName: 'Acme Corporation',
        loserIds: ['s1'],
        loserNames: ['Acme Corp'],
      });
      expect(diff.renames).toHaveLength(0);
      expect(diff.aliasReassignments).toHaveLength(0);
    });

    it('emits a retained alias warning when an alias is absent from the CSV', async () => {
      // DB: s1 has two aliases; CSV row for s1 only lists one
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME CORP LLC', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
      ]);

      expect(diff.warnings.missingAliases).toHaveLength(1);
      expect(diff.warnings.missingAliases[0]).toMatchObject({
        alias: 'ACME CORP LLC',
        supplierName: 'Acme Corp',
      });
    });

    it('merges when moving an alias by grouping it with a different supplier owner', async () => {
      setupDb([
        { original_supplier_name: 'ACME LEGACY', project_supplier_id: 's1', supplier_name: 'Acme', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'BETA', project_supplier_id: 's2', supplier_name: 'Beta', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme', aliases: [], parentName: null },
        { supplierName: 'Beta', aliases: ['BETA', 'ACME LEGACY'], parentName: null },
      ]);

      expect(diff.merges).toHaveLength(1);
      expect(diff.merges[0]).toMatchObject({
        survivorId: 's2',
        survivorName: 'Beta',
        loserIds: ['s1'],
        loserNames: ['Acme'],
      });
      expect(diff.renames).toHaveLength(0);
      expect(diff.aliasReassignments).toHaveLength(0);
    });

    it('prefers a case-insensitive CSV supplier name match as merge survivor', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME HOLDINGS', project_supplier_id: 's2', supplier_name: 'ACME HOLDINGS', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'acme holdings', aliases: ['ACME CORP', 'ACME HOLDINGS'], parentName: null },
      ]);

      expect(diff.merges).toHaveLength(1);
      expect(diff.merges[0]).toMatchObject({
        survivorId: 's2',
        loserIds: ['s1'],
      });
      expect(diff.renames).toEqual([
        { supplierId: 's2', oldName: 'ACME HOLDINGS', newName: 'acme holdings' },
      ]);
    });

    it('prefers the supplier with the most aliases as merge survivor when no name matches', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME CO', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'BETA', project_supplier_id: 's2', supplier_name: 'Beta', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Combined Supplier', aliases: ['ACME CORP', 'ACME CO', 'BETA'], parentName: null },
      ]);

      expect(diff.merges).toHaveLength(1);
      expect(diff.merges[0]).toMatchObject({
        survivorId: 's1',
        loserIds: ['s2'],
      });
      expect(diff.renames).toEqual([
        { supplierId: 's1', oldName: 'Acme Corp', newName: 'Combined Supplier' },
      ]);
    });

    it('is idempotent after a full normalize CSV merge export is re-applied', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME CORPORATION', project_supplier_id: 's2', supplier_name: 'Acme Corporation', parent_supplier_id: null, parent_name: null },
      ]);

      const mergeDiff = await service.computeCsvDiff([
        { supplierName: 'Acme Corporation', aliases: ['ACME CORP'], parentName: null },
        { supplierName: 'Acme Corporation', aliases: ['ACME CORPORATION'], parentName: null },
      ]);

      expect(mergeDiff.merges).toHaveLength(1);

      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's2', supplier_name: 'Acme Corporation', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME CORPORATION', project_supplier_id: 's2', supplier_name: 'Acme Corporation', parent_supplier_id: null, parent_name: null },
      ]);

      const roundTripDiff = await service.computeCsvDiff([
        { supplierName: 'Acme Corporation', aliases: ['ACME CORP'], parentName: null },
        { supplierName: 'Acme Corporation', aliases: ['ACME CORPORATION'], parentName: null },
      ]);

      expect(roundTripDiff.merges).toHaveLength(0);
      expect(roundTripDiff.renames).toHaveLength(0);
      expect(roundTripDiff.aliasReassignments).toHaveLength(0);
      expect(roundTripDiff.parentChanges).toHaveLength(0);
    });

    it('throws about unknown aliases in the CSV', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
      ]);

      await expect(service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP', 'ACME NEW ENTITY'], parentName: null },
      ])).rejects.toThrow('Unknown supplier alias "ACME NEW ENTITY"');
    });

    it('throws when all CSV aliases are unknown', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
      ]);

      await expect(service.computeCsvDiff([
        { supplierName: 'New Supplier', aliases: ['NEW SUPPLIER INC'], parentName: null },
      ])).rejects.toThrow('Unknown supplier alias "NEW SUPPLIER INC"');
    });

    it('rejects renaming an alias owner to an existing supplier name', async () => {
      setupDb(
        [{ original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null }],
        [],
        [
          { id: 's1', supplier_name: 'Acme Corp' },
          { id: 's2', supplier_name: 'Beta Inc' },
        ]
      );

      await expect(service.computeCsvDiff([
        { supplierName: 'Beta Inc', aliases: ['ACME CORP'], parentName: null },
      ])).rejects.toThrow('already used by another supplier');
    });

    it('throws when the same alias appears in two CSV rows', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'BETA', project_supplier_id: 's2', supplier_name: 'Beta', parent_supplier_id: null, parent_name: null },
      ]);

      await expect(service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
        { supplierName: 'Duplicate', aliases: ['ACME CORP'], parentName: null },
      ])).rejects.toThrow('appears in both');
    });

    it('detects a parent creation when CSV parent name is new', async () => {
      setupDb(
        [{ original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null }],
        [] // no existing parents
      );

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: 'Acme Group' },
      ]);

      expect(diff.parentCreations).toHaveLength(1);
      expect(diff.parentCreations[0].name).toBe('Acme Group');
      expect(diff.parentChanges).toHaveLength(1);
      expect(diff.parentChanges[0]).toMatchObject({
        supplierId: 's1',
        oldParentName: null,
        newParentName: 'Acme Group',
      });
    });

    it('detects a parent rename when all suppliers under a DB parent move to a new name', async () => {
      setupDb(
        [{ original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: 'p1', parent_name: 'Acme Holdings' }],
        [{ id: 'p1', name: 'Acme Holdings' }]
      );

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: 'Acme Group' },
      ]);

      expect(diff.parentRenames).toHaveLength(1);
      expect(diff.parentRenames[0]).toMatchObject({ parentId: 'p1', oldName: 'Acme Holdings', newName: 'Acme Group' });
    });

    it('detects a parent assignment change when supplier parent is updated', async () => {
      setupDb(
        [{ original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: 'p1', parent_name: 'Old Group' }],
        [{ id: 'p1', name: 'Old Group' }, { id: 'p2', name: 'New Group' }]
      );

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: 'New Group' },
      ]);

      expect(diff.parentChanges).toHaveLength(1);
      expect(diff.parentChanges[0]).toMatchObject({
        supplierId: 's1',
        oldParentName: 'Old Group',
        newParentName: 'New Group',
      });
    });

    it('detects parent removal when supplier parent is cleared in CSV', async () => {
      setupDb(
        [{ original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: 'p1', parent_name: 'Acme Group' }],
        [{ id: 'p1', name: 'Acme Group' }]
      );

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
      ]);

      expect(diff.parentChanges).toHaveLength(1);
      expect(diff.parentChanges[0]).toMatchObject({
        supplierId: 's1',
        oldParentName: 'Acme Group',
        newParentName: null,
      });
    });

    it('detects a parent merge when two DB parents map to the same CSV parent name', async () => {
      setupDb(
        [
          { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: 'p1', parent_name: 'Acme Group' },
          { original_supplier_name: 'ACME HOLDINGS', project_supplier_id: 's2', supplier_name: 'Acme Holdings', parent_supplier_id: 'p2', parent_name: 'Acme Holdings Group' },
        ],
        [{ id: 'p1', name: 'Acme Group' }, { id: 'p2', name: 'Acme Holdings Group' }]
      );

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: 'Acme Group' },
        { supplierName: 'Acme Holdings', aliases: ['ACME HOLDINGS'], parentName: 'Acme Group' },
      ]);

      expect(diff.parentMerges).toHaveLength(1);
      expect(diff.parentMerges[0].loserIds).toContain('p2');
    });

    it('emits missingAliases when entire supplier is absent from the CSV', async () => {
      // DB: s1 and s2 exist; CSV only includes s1 → s2's alias is missing
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'BETA INC', project_supplier_id: 's2', supplier_name: 'Beta Inc', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
      ]);

      expect(diff.warnings.missingAliases).toHaveLength(1);
      expect(diff.warnings.missingAliases[0]).toMatchObject({
        alias: 'BETA INC',
        supplierName: 'Beta Inc',
      });
    });

    it('no missingAliases when all DB aliases are in the CSV', async () => {
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'BETA INC', project_supplier_id: 's2', supplier_name: 'Beta Inc', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
        { supplierName: 'Beta Inc', aliases: ['BETA INC'], parentName: null },
      ]);

      expect(diff.warnings.missingAliases).toHaveLength(0);
    });

    it('missing alias warning fires even with no diff ops', async () => {
      // Supplier has two aliases; CSV only lists one → warning fires even though there are no diff ops
      setupDb([
        { original_supplier_name: 'ACME CORP', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
        { original_supplier_name: 'ACME CORP LLC', project_supplier_id: 's1', supplier_name: 'Acme Corp', parent_supplier_id: null, parent_name: null },
      ]);

      const diff = await service.computeCsvDiff([
        { supplierName: 'Acme Corp', aliases: ['ACME CORP'], parentName: null },
      ]);

      expect(diff.renames).toHaveLength(0);
      expect(diff.merges).toHaveLength(0);
      expect(diff.warnings.missingAliases).toHaveLength(1);
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

function tempDbPath(): string {
  return path.join(os.tmpdir(), `supplier-alias-test-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('SupplierService durable aliases (real DB)', () => {
  let realDb: DuckDBDatabase;
  let dbPath: string;
  let service: SupplierService;

  beforeEach(async () => {
    realDb = new DuckDBDatabase();
    dbPath = tempDbPath();
    await realDb.openDatabase(dbPath);
    service = new SupplierService(realDb, createMockSupplierUniverse());
  });

  afterEach(async () => {
    if (realDb.isOpen()) await realDb.closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('records raw supplier aliases while normalizing transactions', async () => {
    await realDb.run(
      `INSERT INTO transactions (id, row_index, original_supplier_name)
       VALUES ('tx-1', 0, 'Access Display Group, Inc.')`
    );

    await service.normalizeAllTransactions();

    const tx = await realDb.get<{ project_supplier_id: string }>(
      'SELECT project_supplier_id FROM transactions WHERE id = ?',
      'tx-1'
    );
    const alias = await realDb.get<{ project_supplier_id: string; alias_key: string; source: string }>(
      'SELECT project_supplier_id, alias_key, source FROM project_supplier_aliases WHERE alias = ?',
      'Access Display Group, Inc.'
    );

    expect(tx?.project_supplier_id).toBeTruthy();
    expect(alias?.project_supplier_id).toBe(tx?.project_supplier_id);
    expect(alias?.alias_key).toBe('access display group, inc.');
    expect(alias?.source).toBe('raw_import');
  });

  it('resolves durable raw aliases before cleaned supplier-name matches', async () => {
    const rawName = 'Access Display Group, Inc.';

    await realDb.run(
      `INSERT INTO transactions (id, row_index, original_supplier_name)
       VALUES ('tx-1', 0, ? )`,
      rawName
    );
    await service.normalizeAllTransactions();

    const first = await realDb.get<{ project_supplier_id: string }>(
      'SELECT project_supplier_id FROM transactions WHERE id = ?',
      'tx-1'
    );
    expect(first?.project_supplier_id).toBeTruthy();

    await realDb.run(
      'UPDATE project_suppliers SET supplier_name = ? WHERE id = ?',
      rawName,
      first!.project_supplier_id
    );
    await realDb.run(
      `INSERT INTO project_suppliers (id, supplier_name)
       VALUES ('cleaned-supplier', 'Access Display Group')`
    );
    await realDb.run('DELETE FROM transactions WHERE id = ?', 'tx-1');
    await realDb.run(
      `INSERT INTO transactions (id, row_index, original_supplier_name)
       VALUES ('tx-2', 1, ? )`,
      rawName
    );

    await service.normalizeAllTransactions();

    const second = await realDb.get<{ project_supplier_id: string }>(
      'SELECT project_supplier_id FROM transactions WHERE id = ?',
      'tx-2'
    );
    expect(second?.project_supplier_id).toBe(first?.project_supplier_id);
  });
});
