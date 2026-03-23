import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { cleanSupplierName } from '../../../src/main/utils/supplier-name';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => [{}]) },
}));

describe('cleanSupplierName', () => {
  describe('whitespace', () => {
    it('trims leading and trailing whitespace', () => {
      expect(cleanSupplierName('  Walmart  ')).toBe('Walmart');
    });

    it('collapses internal whitespace', () => {
      expect(cleanSupplierName('Walmart   Stores')).toBe('Walmart Stores');
    });
  });

  describe('suffix stripping', () => {
    it('strips common suffixes case-insensitively', () => {
      expect(cleanSupplierName('Walmart Inc')).toBe('Walmart');
      expect(cleanSupplierName('Walmart INC')).toBe('Walmart');
      expect(cleanSupplierName('Walmart inc.')).toBe('Walmart');
      expect(cleanSupplierName('Walmart LLC')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Ltd')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Ltd.')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Limited')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Corp')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Corp.')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Corporation')).toBe('Walmart');
      expect(cleanSupplierName('Walmart Incorporated')).toBe('Walmart');
    });

    it('strips compound suffixes', () => {
      expect(cleanSupplierName('Infosys Pvt Ltd')).toBe('Infosys');
      expect(cleanSupplierName('Infosys Pvt. Ltd.')).toBe('Infosys');
      expect(cleanSupplierName('Infosys Private Limited')).toBe('Infosys');
      expect(cleanSupplierName('Infosys Pte Ltd')).toBe('Infosys');
      expect(cleanSupplierName('Infosys Pty Ltd')).toBe('Infosys');
      expect(cleanSupplierName('Infosys Sdn Bhd')).toBe('Infosys');
    });

    it('strips punctuated suffixes', () => {
      expect(cleanSupplierName('Shopify L.L.C.')).toBe('Shopify');
      expect(cleanSupplierName('Shopify L.L.C')).toBe('Shopify');
      expect(cleanSupplierName('Shopify P.L.C.')).toBe('Shopify');
      expect(cleanSupplierName('Shopify GmbH')).toBe('Shopify');
      expect(cleanSupplierName('Shopify AG')).toBe('Shopify');
    });

    it('handles comma before suffix', () => {
      expect(cleanSupplierName('Shopify, Inc.')).toBe('Shopify');
      expect(cleanSupplierName('Shopify, LLC')).toBe('Shopify');
    });

    it('strips longest matching suffix first', () => {
      // "Pvt Ltd" should match before just "Ltd"
      expect(cleanSupplierName('Infosys Pvt Ltd')).toBe('Infosys');
    });
  });

  describe('<5 character guard', () => {
    it('keeps suffix if stripping would leave fewer than 5 characters', () => {
      // "Aco" → 3 chars after strip — keep suffix
      expect(cleanSupplierName('Aco Inc')).toBe('Aco Inc');
      // "Acme" → 4 chars after strip — keep suffix
      expect(cleanSupplierName('Acme Inc')).toBe('Acme Inc');
    });

    it('strips suffix if result is exactly 5 characters', () => {
      // "Acmex" → 5 chars — strip allowed
      expect(cleanSupplierName('Acmex Inc')).toBe('Acmex');
    });

    it('strips suffix if result is more than 5 characters', () => {
      expect(cleanSupplierName('Walmart Inc')).toBe('Walmart');
    });
  });

  describe('case preservation', () => {
    it('preserves original casing of the meaningful part', () => {
      expect(cleanSupplierName('WALMART Inc')).toBe('WALMART');
      expect(cleanSupplierName('Walmart Inc')).toBe('Walmart');
    });

    it('two variants clean to the same lowercase form', () => {
      const a = cleanSupplierName('WALMART Inc').toLowerCase();
      const b = cleanSupplierName('walmart inc').toLowerCase();
      expect(a).toBe(b);
    });
  });

  describe('no suffix', () => {
    it('returns name unchanged when no suffix present', () => {
      expect(cleanSupplierName('Walmart')).toBe('Walmart');
      expect(cleanSupplierName('Amazon')).toBe('Amazon');
    });
  });
});

// ─── Pipeline integration test ────────────────────────────────────────────────

import { DuckDBDatabase } from '../../../src/main/services/database';
import { SupplierService } from '../../../src/main/services/supplier-service';
import { createMockSupplierUniverse } from '../../helpers/mock-services';

/**
 * Verifies that normalizeAllTransactions() groups raw supplier name variants
 * into the correct canonical project_suppliers entries via cleanSupplierName.
 *
 * Raw names imported:                  Expected canonical supplier:
 *   "Walmart Inc", "WALMART LLC",
 *   "Walmart Corporation"           →  "Walmart"
 *   "Infosys Pvt Ltd",
 *   "INFOSYS PTE LTD"               →  "Infosys"  (first seen wins casing)
 *   "Acme Inc"                      →  "Acme Inc" (<5 char guard keeps suffix)
 */
describe('normalizeAllTransactions — pipeline', () => {
  let testDir: string;
  let db: DuckDBDatabase;
  let service: SupplierService;

  const RAW_NAMES = [
    'Walmart Inc',
    'WALMART LLC',
    'Walmart Corporation',
    'Infosys Pvt Ltd',
    'INFOSYS PTE LTD',
    'Acme Inc',
  ];

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'normalize-test-'));
    db = new DuckDBDatabase();
    await db.openDatabase(path.join(testDir, 'test.c91'));

    // Seed one transaction per raw name (original_supplier_name set, project_supplier_id null)
    for (let i = 0; i < RAW_NAMES.length; i++) {
      await db.run(
        'INSERT INTO transactions (id, original_supplier_name) VALUES (?, ?)',
        `tx-${i}`,
        RAW_NAMES[i]
      );
    }

    service = new SupplierService(db, createMockSupplierUniverse());
  });

  afterEach(async () => {
    await db.closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('groups suffix variants under one canonical supplier', async () => {
    await service.normalizeAllTransactions();

    const suppliers = await db.all<{ supplier_name: string }>(
      'SELECT supplier_name FROM project_suppliers ORDER BY supplier_name'
    );
    const names = suppliers.map(s => s.supplier_name);

    const lower = names.map(n => n.toLowerCase());
    // Three Walmart variants → one supplier; two Infosys variants → one supplier
    // Case-insensitive: first-seen wins casing so canonical may be any variant's case
    expect(lower).toContain('walmart');
    expect(lower).toContain('infosys');
    // "Acme Inc" guard kicks in — suffix kept, canonical name is "Acme Inc"
    expect(names).toContain('Acme Inc');
    // No duplicates
    expect(lower.filter(n => n === 'walmart')).toHaveLength(1);
    expect(lower.filter(n => n === 'infosys')).toHaveLength(1);
  });

  it('all transactions are linked to a supplier after normalization', async () => {
    await service.normalizeAllTransactions();

    const unlinked = await db.all(
      'SELECT id FROM transactions WHERE project_supplier_id IS NULL'
    );
    expect(unlinked).toHaveLength(0);
  });

  it('all walmart variants map to the same supplier id', async () => {
    await service.normalizeAllTransactions();

    const rows = await db.all<{ project_supplier_id: string }>(
      `SELECT DISTINCT t.project_supplier_id
       FROM transactions t
       WHERE lower(t.original_supplier_name) LIKE '%walmart%'`
    );
    expect(rows).toHaveLength(1);
  });

  it('aliases are derived correctly from transactions', async () => {
    await service.normalizeAllTransactions();

    const walmart = await db.get<{ id: string }>(
      `SELECT id FROM project_suppliers WHERE lower(supplier_name) = 'walmart'`
    );
    expect(walmart).toBeDefined();

    const aliases = await service.getProjectAliases(walmart!.id);
    // All three raw names are aliases (none equal the canonical "Walmart")
    expect(aliases).toContain('Walmart Inc');
    expect(aliases).toContain('WALMART LLC');
    expect(aliases).toContain('Walmart Corporation');
    expect(aliases).toHaveLength(3);
  });
});

// ─── Alias matching ───────────────────────────────────────────────────────────

describe('alias matching — case-insensitive lookup against canonical name', () => {
  let testDir: string;
  let db: DuckDBDatabase;
  let service: SupplierService;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-match-test-'));
    db = new DuckDBDatabase();
    await db.openDatabase(path.join(testDir, 'test.c91'));
    service = new SupplierService(db, createMockSupplierUniverse());
  });

  afterEach(async () => {
    await db.closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('different-cased variants of the same cleaned name map to one supplier', async () => {
    // Simulate sequential import: first row creates the canonical, subsequent rows match it
    const variants = ['Shopify Inc', 'SHOPIFY INC', 'shopify inc.', 'Shopify, Inc.'];
    for (let i = 0; i < variants.length; i++) {
      await db.run(
        'INSERT INTO transactions (id, original_supplier_name) VALUES (?, ?)',
        `tx-${i}`, variants[i]
      );
    }

    await service.normalizeAllTransactions();

    // Only one project_supplier should exist
    const suppliers = await db.all('SELECT id FROM project_suppliers');
    expect(suppliers).toHaveLength(1);

    // All transactions point to that one supplier
    const linked = await db.all(
      'SELECT DISTINCT project_supplier_id FROM transactions'
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].project_supplier_id).toBe(suppliers[0].id);
  });

  it('aliases include all raw variants except the canonical name itself', async () => {
    const variants = ['Shopify Inc', 'SHOPIFY LLC', 'Shopify Corporation'];
    for (let i = 0; i < variants.length; i++) {
      await db.run(
        'INSERT INTO transactions (id, original_supplier_name) VALUES (?, ?)',
        `tx-${i}`, variants[i]
      );
    }

    await service.normalizeAllTransactions();

    const supplier = await db.get<{ id: string; supplier_name: string }>(
      'SELECT id, supplier_name FROM project_suppliers LIMIT 1'
    );
    expect(supplier).toBeDefined();

    const aliases = await service.getProjectAliases(supplier!.id);
    // All variants except the one that became canonical are aliases
    const nonCanonical = variants.filter(
      v => v !== supplier!.supplier_name
    );
    expect(aliases).toHaveLength(nonCanonical.length);
    for (const v of nonCanonical) {
      expect(aliases).toContain(v);
    }
  });

  it('case variant of an existing alias links to the same supplier without creating a new one', async () => {
    // "Walmart Stores" already mapped to an existing supplier
    await db.run(
      'INSERT INTO project_suppliers (id, supplier_name) VALUES (?, ?)',
      'walmart-id', 'Walmart'
    );
    await db.run(
      'INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES (?, ?, ?)',
      'tx-existing', 'Walmart Stores', 'walmart-id'
    );
    // New transaction with same raw name, different casing
    await db.run(
      'INSERT INTO transactions (id, original_supplier_name) VALUES (?, ?)',
      'tx-new', 'WALMART STORES'
    );

    await service.normalizeAllTransactions();

    // No new supplier created
    const suppliers = await db.all('SELECT id FROM project_suppliers');
    expect(suppliers).toHaveLength(1);

    // New transaction linked to existing supplier via alias match
    const tx = await db.get<{ project_supplier_id: string }>(
      'SELECT project_supplier_id FROM transactions WHERE id = ?', 'tx-new'
    );
    expect(tx!.project_supplier_id).toBe('walmart-id');
  });

  it('a raw name that cleans to an existing canonical links to it, not a new supplier', async () => {
    // Manually insert a canonical supplier
    await db.run(
      'INSERT INTO project_suppliers (id, supplier_name) VALUES (?, ?)',
      'existing-id', 'Shopify'
    );
    // New transaction with a suffix variant
    await db.run(
      'INSERT INTO transactions (id, original_supplier_name) VALUES (?, ?)',
      'tx-0', 'Shopify LLC'
    );

    await service.normalizeAllTransactions();

    // No new supplier should have been created
    const suppliers = await db.all('SELECT id FROM project_suppliers');
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].id).toBe('existing-id');

    // Transaction linked to the existing supplier
    const tx = await db.get<{ project_supplier_id: string }>(
      'SELECT project_supplier_id FROM transactions WHERE id = ?', 'tx-0'
    );
    expect(tx!.project_supplier_id).toBe('existing-id');
  });
});
