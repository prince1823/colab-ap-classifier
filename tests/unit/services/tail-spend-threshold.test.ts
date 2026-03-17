/**
 * Integration test for tail spend threshold filtering.
 *
 * Tests that filterTailSpend() correctly marks suppliers below a threshold
 * as tail spend, and that isTailSpend() gates research correctly.
 *
 * Data:
 *   Acme Corp     — 3 rows @ $4,000 each = $12,000 total  → above threshold → researched
 *   Tiny Vendor   — 2 rows @ $3,000 each = $6,000  total  → below threshold → skipped
 *   New Startup   — 1 row  @ $5,000       = $5,000  total  → below threshold → skipped
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [{}]),
  },
}));

import { DuckDBDatabase } from '../../../src/main/services/database';
import { SupplierService } from '../../../src/main/services/supplier-service';
import { createMockSupplierUniverse } from '../../helpers/mock-services';

const THRESHOLD = 10_000;

const SUPPLIERS = [
  { id: 'sup-acme',    name: 'Acme Corp' },
  { id: 'sup-tiny',   name: 'Tiny Vendor' },
  { id: 'sup-new',    name: 'New Startup' },
];

// 6 transactions: 3 for Acme, 2 for Tiny Vendor, 1 for New Startup
const TRANSACTIONS = [
  { id: 'tx1', supplierId: 'sup-acme',  spend: 4000 },
  { id: 'tx2', supplierId: 'sup-acme',  spend: 4000 },
  { id: 'tx3', supplierId: 'sup-acme',  spend: 4000 },
  { id: 'tx4', supplierId: 'sup-tiny',  spend: 3000 },
  { id: 'tx5', supplierId: 'sup-tiny',  spend: 3000 },
  { id: 'tx6', supplierId: 'sup-new',   spend: 5000 },
];

describe('Tail Spend Threshold Filtering', () => {
  let testDir: string;
  let db: DuckDBDatabase;
  let service: SupplierService;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-spend-test-'));
    const dbPath = path.join(testDir, 'test.c91');

    db = new DuckDBDatabase();
    await db.openDatabase(dbPath);

    // Add spend_amount column (normally added dynamically during CSV import)
    await db.exec('ALTER TABLE transactions ADD COLUMN spend_amount VARCHAR');

    // Seed suppliers
    for (const s of SUPPLIERS) {
      await db.run(
        'INSERT INTO project_suppliers (id, supplier_name) VALUES (?, ?)',
        s.id, s.name
      );
    }

    // Seed transactions
    for (const t of TRANSACTIONS) {
      await db.run(
        'INSERT INTO transactions (id, project_supplier_id, spend_amount) VALUES (?, ?, ?)',
        t.id, t.supplierId, String(t.spend)
      );
    }

    service = new SupplierService(db, createMockSupplierUniverse());
  });

  afterEach(async () => {
    await db.closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('marks only suppliers below threshold as tail spend', async () => {
    const tailIds = await service.filterTailSpend(THRESHOLD);

    expect(tailIds).toContain('sup-tiny');
    expect(tailIds).toContain('sup-new');
    expect(tailIds).not.toContain('sup-acme');
    expect(tailIds).toHaveLength(2);
  });

  it('isTailSpend returns correct values after filtering', async () => {
    await service.filterTailSpend(THRESHOLD);

    expect(await service.isTailSpend('sup-acme')).toBe(false);
    expect(await service.isTailSpend('sup-tiny')).toBe(true);
    expect(await service.isTailSpend('sup-new')).toBe(true);
  });

  it('research gate: only Acme Corp would be sent to research', async () => {
    await service.filterTailSpend(THRESHOLD);

    // Simulate the suppliers:researchSingle gate from ipc/supplier-research.ts
    const wouldResearch: string[] = [];
    const wouldSkip: string[] = [];

    for (const s of SUPPLIERS) {
      const isTail = await service.isTailSpend(s.id);
      if (isTail) {
        wouldSkip.push(s.name);
      } else {
        wouldResearch.push(s.name);
      }
    }

    expect(wouldResearch).toEqual(['Acme Corp']);
    expect(wouldSkip).toEqual(['Tiny Vendor', 'New Startup']);
  });
});
