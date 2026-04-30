/**
 * Repro test for the duplicate-UUID UPDATE FROM bug, against MAIN (v1.6.1).
 * No `project_supplier_aliases` table on main — only `project_suppliers`.
 *
 * Mirrors what IngestService.importCSV → SupplierService.normalizeAllTransactions
 * does on main, with a high-cardinality supplier set similar to the user's fox file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { DuckDBDatabase } from '../../../src/main/services/database';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => ({})), getAllWindows: vi.fn(() => [{}]) },
}));

import { IngestService } from '../../../src/main/services/ingest';
import { SupplierService } from '../../../src/main/services/supplier-service';
import {
  createMockTransactionStore,
  createMockColumnMappingAgent,
  createMockProjectStore,
  createMockEventBus,
} from '../../helpers/mock-services';
import type { ProjectStore } from '../../../src/shared/types/services';

const ROW_COUNT = 50_000;
const UNIQUE_SUPPLIERS = 8_000;

const MAPPING = {
  supplier_name: 'Supplier',
  spend_amount: 'Amount',
  master_date: 'Date',
};

function tempPath(ext: string): string {
  return path.join(os.tmpdir(), `main-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

function generateNames(unique: number): string[] {
  const patterns = [
    (i: number) => `Supplier_${i}, llc`,
    (i: number) => `Supplier_${i}, inc.`,
    (i: number) => `Supplier_${i} corp`,
    (i: number) => `Supplier_${i} & co.`,
    (i: number) => `Supplier_${i}-services`,
    (i: number) => `Supplier_${i} (inactive)`,
    (i: number) => `the ${i.toString(36)} group`,
    (i: number) => `Supplier_${i}`,
  ];
  const names: string[] = [];
  for (let i = 0; i < unique; i++) names.push(patterns[i % patterns.length](i));
  return names;
}

async function writeCsv(rowCount: number, names: string[]): Promise<string> {
  const csvPath = tempPath('.csv');
  const ws = fs.createWriteStream(csvPath);
  ws.write('Supplier,Amount,Date\n');
  for (let i = 0; i < rowCount; i++) {
    const supplier = names[i % names.length];
    const day = (i % 28) + 1;
    ws.write(`"${supplier.replace(/"/g, '""')}",${(i % 9999) + 0.5},2024-01-${day < 10 ? '0' : ''}${day}\n`);
  }
  ws.end();
  await new Promise<void>((res, rej) => {
    ws.on('finish', () => res());
    ws.on('error', rej);
  });
  return csvPath;
}

function createDbBackedProject(db: DuckDBDatabase): ProjectStore {
  return {
    ...createMockProjectStore(),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      await db.run(
        `INSERT INTO project_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        key,
        JSON.stringify(value)
      );
    }),
    getSetting: vi.fn(async (key: string) => {
      const row = await db.get<{ value: string }>(
        'SELECT value FROM project_settings WHERE key = ?',
        key
      );
      if (!row) return undefined;
      return JSON.parse(row.value);
    }),
  };
}

describe('main v1.6.1: duplicate-UUID bug repro', () => {
  let db: DuckDBDatabase;
  let dbPath: string;
  const tempCsvs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new DuckDBDatabase();
    dbPath = tempPath('.c91');
    await db.openDatabase(dbPath);
  });

  afterEach(async () => {
    if (db.isOpen()) await db.closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    for (const p of tempCsvs) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    tempCsvs.length = 0;
  });

  it('full IngestService.importCSV with high-cardinality supplier set', async () => {
    const supplierUniverse = {
      isOpen: () => false,
      searchVariants: async () => [],
      getSupplier: async () => null,
      upsertSupplierFull: async () => {},
    } as any;
    const suppliers = new SupplierService(db, supplierUniverse);
    const project = createDbBackedProject(db);
    const eventBus = createMockEventBus();
    const service = new IngestService(
      db,
      createMockTransactionStore(),
      suppliers,
      project,
      createMockColumnMappingAgent(),
      eventBus,
    );

    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    try {
      await service.importCSV(csvPath, MAPPING);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('FAILURE:', (e as Error).message);
      throw e;
    }

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 600_000);
});
