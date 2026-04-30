/**
 * Repro test for: "Constraint Error: PRIMARY KEY or UNIQUE constraint violation: duplicate key ..."
 * fired by `IngestService.importCSV` on large files.
 *
 * Hypothesis: parser.on('data') and parser.on('end') in src/main/services/ingest.ts
 * can both call flushBatch() on overlapping records, causing the same
 * transaction row's UUID to be INSERTed twice within one batch SQL.
 *
 * Each test runs against a real DuckDB and asserts:
 *   - import completes without throwing
 *   - all transaction.id values are unique
 *   - row count matches the source CSV
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { DuckDBDatabase } from '../../../src/main/services/database';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => ({})), getAllWindows: vi.fn(() => [{}]) },
}));

import { IngestService } from '../../../src/main/services/ingest';
import {
  createMockTransactionStore,
  createMockColumnMappingAgent,
  createMockSupplierService,
  createMockProjectStore,
  createMockEventBus,
} from '../../helpers/mock-services';
import type { SupplierService, ProjectStore, EventBus } from '../../../src/shared/types/services';

const MAPPING = {
  supplier_name: 'Supplier',
  spend_amount: 'Amount',
  master_date: 'Date',
};

function tempPath(ext: string): string {
  return path.join(os.tmpdir(), `race-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

async function generateCsv(rowCount: number): Promise<string> {
  const csvPath = tempPath('.csv');
  const ws = fs.createWriteStream(csvPath);
  ws.write('Supplier,Amount,Date\n');
  for (let i = 0; i < rowCount; i++) {
    // Cycle through a small supplier set to keep normalize fast
    const supplier = `Supplier_${i % 50}`;
    ws.write(`${supplier},${(i % 1000) + 0.5},2024-01-${(i % 28) + 1 < 10 ? '0' : ''}${(i % 28) + 1}\n`);
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

describe('IngestService — duplicate-UUID race on large imports', () => {
  let realDb: DuckDBDatabase;
  let dbPath: string;
  let service: IngestService;
  let suppliers: SupplierService;
  let project: ProjectStore;
  let eventBus: EventBus;
  const tempCsvs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    realDb = new DuckDBDatabase();
    dbPath = tempPath('.c91');
    await realDb.openDatabase(dbPath);
    suppliers = createMockSupplierService();
    project = createDbBackedProject(realDb);
    eventBus = createMockEventBus();
    service = new IngestService(
      realDb,
      createMockTransactionStore(),
      suppliers,
      project,
      createMockColumnMappingAgent(),
      eventBus,
    );
  });

  afterEach(async () => {
    if (realDb.isOpen()) await realDb.closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    for (const p of tempCsvs) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    tempCsvs.length = 0;
  });

  // IMPORT_BATCH_SIZE in src/main/services/ingest.ts is 50000.
  // We want at least one full batch + a trailing batch so both
  // 'data' (which calls flushBatch on the full batch) and 'end'
  // (which calls flushBatch on the leftover) participate.

  it('50_001 rows: import succeeds and every transaction.id is unique', async () => {
    const csvPath = await generateCsv(50_001);
    tempCsvs.push(csvPath);

    await service.importCSV(csvPath, MAPPING);

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    const distinct = await realDb.get<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM transactions');

    expect(Number(total?.c)).toBe(50_001);
    expect(Number(distinct?.c)).toBe(50_001);
  }, 60_000);

  it('100_001 rows (boundary: 2 full batches + 1 trailing): no duplicate ids', async () => {
    const csvPath = await generateCsv(100_001);
    tempCsvs.push(csvPath);

    await service.importCSV(csvPath, MAPPING);

    const dupGroups = await realDb.all<{ id: string; c: number | bigint }>(
      'SELECT id, COUNT(*) AS c FROM transactions GROUP BY id HAVING COUNT(*) > 1'
    );
    expect(dupGroups).toEqual([]);

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(100_001);
  }, 120_000);

  it('exact batch boundary (50_000 rows, no trailing): no duplicate ids', async () => {
    // The 'end' handler still runs flushBatch with an empty array — verify that's harmless.
    const csvPath = await generateCsv(50_000);
    tempCsvs.push(csvPath);

    await service.importCSV(csvPath, MAPPING);

    const dupGroups = await realDb.all<{ id: string; c: number | bigint }>(
      'SELECT id, COUNT(*) AS c FROM transactions GROUP BY id HAVING COUNT(*) > 1'
    );
    expect(dupGroups).toEqual([]);

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(50_000);
  }, 60_000);

  it('repeated re-imports of the same 60k-row CSV never collide (3 attempts)', async () => {
    // The user reported the bug fires on the 2nd or 3rd re-import. Run 3.
    const csvPath = await generateCsv(60_000);
    tempCsvs.push(csvPath);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await service.importCSV(csvPath, MAPPING);
    }

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    const distinct = await realDb.get<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM transactions');

    expect(Number(total?.c)).toBe(60_000 * 3);
    expect(Number(distinct?.c)).toBe(60_000 * 3);
  }, 180_000);

  it('concurrent imports of the same CSV (e.g. double-click): both finish, no UUID collision', async () => {
    // If the renderer fires importCSV twice in quick succession, do we corrupt anything?
    const csvPath = await generateCsv(60_000);
    tempCsvs.push(csvPath);

    const results = await Promise.allSettled([
      service.importCSV(csvPath, MAPPING),
      service.importCSV(csvPath, MAPPING),
    ]);

    // Surface any failure with its message so we can see what fired.
    for (const r of results) {
      if (r.status === 'rejected') {
        // eslint-disable-next-line no-console
        console.log('CONCURRENT IMPORT REJECTED:', (r.reason as Error)?.message);
      }
    }

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    const distinct = await realDb.get<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM transactions');
    expect(Number(total?.c)).toBe(Number(distinct?.c));
  }, 180_000);

  it('flushBatch with simulated 50ms latency: import still produces unique ids', async () => {
    // Add latency around db.exec to widen the window between batch capture and INSERT.
    // If the race depends on slow flushes (file backed up while another batch streams in),
    // this is the most likely place to expose it.
    const originalExec = realDb.exec.bind(realDb);
    let firstInsertSeen = false;
    realDb.exec = (async (sql: string) => {
      if (sql.startsWith('INSERT INTO transactions') && !firstInsertSeen) {
        firstInsertSeen = true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return originalExec(sql);
    }) as typeof realDb.exec;

    const csvPath = await generateCsv(100_001);
    tempCsvs.push(csvPath);

    await service.importCSV(csvPath, MAPPING);

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    const distinct = await realDb.get<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM transactions');
    expect(Number(total?.c)).toBe(100_001);
    expect(Number(distinct?.c)).toBe(100_001);
  }, 180_000);

  // Mirrors the user's actual fox_transactions_2021.csv shape:
  // - ~190k rows
  // - ~22k unique supplier raw values (with punctuation: commas, periods, ampersands, dashes)
  // The user's failure pattern (constraint error 99s into import) suggests the bug
  // fires during normalize, not during the raw-row INSERT.
  // Note: this test calls the REAL SupplierService (not the mock) so normalizeAllTransactions
  // runs end-to-end with project_supplier_aliases inserts.
  it('high-cardinality supplier set: 50k rows, 8k unique punctuated names — no UUID collision', async () => {
    const csvPath = await generateHighCardinalityCsv(50_000, 8_000);
    tempCsvs.push(csvPath);

    // Replace the mock supplier service with the REAL one so normalizeAllTransactions runs.
    const { SupplierService } = await import('../../../src/main/services/supplier-service');
    const realSuppliers = new SupplierService(realDb, {
      isOpen: () => false,
      searchVariants: async () => [],
      getSupplier: async () => null,
      upsertSupplierFull: async () => {},
    } as any);
    service = new IngestService(
      realDb,
      createMockTransactionStore(),
      realSuppliers,
      project,
      createMockColumnMappingAgent(),
      eventBus,
    );

    // Intercept db.run / db.exec to capture the SQL of the failing call.
    const originalRun = realDb.run.bind(realDb);
    const originalExec = realDb.exec.bind(realDb);
    realDb.run = (async (sql: string, ...params: unknown[]) => {
      try {
        return await originalRun(sql, ...params);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('duplicate key')) {
          // eslint-disable-next-line no-console
          console.log('CULPRIT db.run SQL:', sql);
          // eslint-disable-next-line no-console
          console.log('CULPRIT params:', JSON.stringify(params));
        }
        throw e;
      }
    }) as typeof realDb.run;
    // Track chunks of tmp INSERT data so we can replay and inspect when UPDATE fails.
    const lastTmpInserts = new Map<string, Array<{ name: string; sid: string }>>();
    const seenTxnIds = new Set<string>();
    const txnInsertStats = { totalRows: 0, dupIds: 0, batches: 0 };

    realDb.exec = (async (sql: string) => {
      // After each INSERT INTO _norm_map_xxx, query the actual table.
      const tmpInsertMatch = sql.match(/^\s*INSERT INTO\s+(_norm_map_[a-z0-9]+)\s+/i);
      if (tmpInsertMatch) {
        const tmp = tmpInsertMatch[1];
        // Run the INSERT first
        try {
          await originalExec(sql);
        } catch (e) {
          throw e;
        }
        // Query stats right after
        const cnt = await realDb.all<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${tmp}`);
        const dist = await realDb.all<{ c: number | bigint }>(`SELECT COUNT(DISTINCT original_name) AS c FROM ${tmp}`);
        // eslint-disable-next-line no-console
        console.log(`  ACTUAL tmp ${tmp}: rows=${Number(cnt[0]?.c)}, distinct names=${Number(dist[0]?.c)}`);
        if (Number(cnt[0]?.c) !== Number(dist[0]?.c)) {
          const dups = await realDb.all<{ original_name: string; c: number | bigint }>(
            `SELECT original_name, COUNT(*) AS c FROM ${tmp} GROUP BY original_name HAVING COUNT(*) > 1 LIMIT 5`
          );
          // eslint-disable-next-line no-console
          console.log('  ⚠️ tmp has duplicate names:', dups);
        }
        return undefined as any;
      }

      // Before each UPDATE-on-transactions, record current state.
      const isUpdateTxn = /^\s*UPDATE transactions\s+SET project_supplier_id/i.test(sql);
      if (isUpdateTxn) {
        try {
          const stats = await originalRun ? null : null;
          const total = await realDb.all<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
          const distinct = await realDb.all<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM transactions');
          // eslint-disable-next-line no-console
          console.log(`  pre-UPDATE transactions: ${Number(total[0]?.c)} total, ${Number(distinct[0]?.c)} distinct ids`);
          if (Number(total[0]?.c) !== Number(distinct[0]?.c)) {
            const dups = await realDb.all<{ id: string; c: number | bigint }>(
              'SELECT id, COUNT(*) AS c FROM transactions GROUP BY id HAVING COUNT(*) > 1 LIMIT 5'
            );
            // eslint-disable-next-line no-console
            console.log(`  ⚠️ duplicate ids in transactions: ${dups.length} (sample):`, dups.slice(0, 3));
          }
        } catch (qerr) {
          // eslint-disable-next-line no-console
          console.log('  pre-UPDATE inspect failed:', (qerr as Error).message);
        }
      }
      // Capture INSERT INTO transactions to track UUIDs being inserted across batches.
      const txnInsMatch = /^\s*INSERT INTO transactions\s*\(/i.test(sql);
      if (txnInsMatch) {
        txnInsertStats.batches++;
        // Extract all UUIDs from values: ('UUID', 'upload_id', ...)
        const uuidRe = /\(\s*'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g;
        let m;
        let countInBatch = 0;
        while ((m = uuidRe.exec(sql)) !== null) {
          countInBatch++;
          if (seenTxnIds.has(m[1])) {
            txnInsertStats.dupIds++;
            // eslint-disable-next-line no-console
            console.log(`!!! DUPLICATE txn UUID in flushBatch INSERT: ${m[1]} (batch #${txnInsertStats.batches})`);
          }
          seenTxnIds.add(m[1]);
        }
        txnInsertStats.totalRows += countInBatch;
        // eslint-disable-next-line no-console
        console.log(`  flushBatch #${txnInsertStats.batches}: ${countInBatch} rows (total seen: ${txnInsertStats.totalRows}, distinct: ${seenTxnIds.size})`);
      }
      // Capture INSERT INTO _norm_map_xxx VALUES (...) so we can inspect the data later.
      const insMatch = sql.match(/^\s*INSERT INTO\s+(_norm_map_[a-z0-9]+)\s+\(original_name, supplier_id\)\s+VALUES\s+([\s\S]+)$/i);
      if (insMatch) {
        const [, tmp, valuesPart] = insMatch;
        const tuples: Array<{ name: string; sid: string }> = [];
        const re = /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)/g;
        let m;
        while ((m = re.exec(valuesPart)) !== null) {
          tuples.push({ name: m[1].replace(/''/g, "'"), sid: m[2].replace(/''/g, "'") });
        }
        lastTmpInserts.set(tmp, tuples);
      }
      try {
        return await originalExec(sql);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('duplicate key')) {
          // eslint-disable-next-line no-console
          console.log('CULPRIT db.exec SQL prefix:', sql.slice(0, 200));
          // eslint-disable-next-line no-console
          console.log('SQL length:', sql.length);
          // Extract UUID from error
          const uuidMatch = msg.match(/"([0-9a-f-]{36})"/);
          if (uuidMatch) {
            const dupUuid = uuidMatch[1];
            // Check if this UUID was a supplier_id we put in tmp
            for (const [tmp, tuples] of lastTmpInserts) {
              const matches = tuples.filter((t) => t.sid === dupUuid);
              if (matches.length > 0) {
                // eslint-disable-next-line no-console
                console.log(`  ⇒ dup UUID is a supplier_id we put in ${tmp}: ${matches.length} occurrences`);
                for (const m2 of matches.slice(0, 3)) {
                  // eslint-disable-next-line no-console
                  console.log(`     name=${JSON.stringify(m2.name)}, sid=${m2.sid}`);
                }
              }
            }
            // Check if it was a transaction.id
            if (seenTxnIds.has(dupUuid)) {
              // eslint-disable-next-line no-console
              console.log(`  ⇒ dup UUID is a transactions.id we INSERTed`);
            } else {
              // eslint-disable-next-line no-console
              console.log(`  ⇒ dup UUID was NOT inserted via flushBatch`);
            }
            // eslint-disable-next-line no-console
            console.log(`  DUPLICATE UUID: ${dupUuid}`);
            // Search across tables — note: this is BEFORE rollback so we can still query.
            for (const tbl of ['transactions', 'project_suppliers', 'project_supplier_aliases', 'uploads', 'supplier_parents']) {
              try {
                const rows = await realDb.all<{ c: number | bigint }>(
                  `SELECT COUNT(*) AS c FROM ${tbl} WHERE id = ?`,
                  dupUuid
                );
                // eslint-disable-next-line no-console
                console.log(`    ${tbl}.id matches: ${Number(rows[0]?.c)}`);
              } catch (qe) {
                // eslint-disable-next-line no-console
                console.log(`    ${tbl} query error:`, (qe as Error).message);
              }
            }
          }
          // Try to extract the tmp table name from SQL like:
          //   UPDATE transactions SET project_supplier_id = m.supplier_id FROM _norm_map_XXXX m
          const m = sql.match(/FROM\s+(_norm_map_[a-z0-9]+)/i);
          if (m) {
            const tmp = m[1];
            const captured = lastTmpInserts.get(tmp);
            if (captured) {
              // eslint-disable-next-line no-console
              console.log(`  captured tmp ${tmp}: ${captured.length} rows inserted`);
              const byName = new Map<string, number>();
              for (const t of captured) {
                byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
              }
              const dups = [...byName.entries()].filter(([, n]) => n > 1);
              // eslint-disable-next-line no-console
              console.log(`  duplicate original_name in tmp INSERT: ${dups.length}`);
              for (const [n, c] of dups.slice(0, 5)) {
                // eslint-disable-next-line no-console
                console.log(`    ${JSON.stringify(n)} × ${c}`);
              }
              // Distinct names
              // eslint-disable-next-line no-console
              console.log(`  distinct names in tmp: ${byName.size}`);
            }
          }
        }
        throw e;
      }
    }) as typeof realDb.exec;

    try {
      await service.importCSV(csvPath, MAPPING);
    } catch (e) {
      // Surface the full stack so we can see which INSERT throws.
      // eslint-disable-next-line no-console
      console.log('FAIL STACK:\n', (e as Error).stack);
      throw e;
    }

    const total = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    const distinctTxn = await realDb.get<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM transactions');
    const supplierCount = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM project_suppliers');
    const aliasCount = await realDb.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM project_supplier_aliases');
    const distinctAliasIds = await realDb.get<{ c: number | bigint }>('SELECT COUNT(DISTINCT id) AS c FROM project_supplier_aliases');

    expect(Number(total?.c)).toBe(50_000);
    expect(Number(distinctTxn?.c)).toBe(50_000);
    expect(Number(distinctAliasIds?.c)).toBe(Number(aliasCount?.c));
    // eslint-disable-next-line no-console
    console.log(`  → suppliers=${Number(supplierCount?.c)}, aliases=${Number(aliasCount?.c)}`);
  }, 300_000);
});

async function generateHighCardinalityCsv(rowCount: number, uniqueSuppliers: number): Promise<string> {
  const csvPath = tempPath('.csv');
  const ws = fs.createWriteStream(csvPath);
  ws.write('Supplier,Amount,Date\n');

  // Generate `uniqueSuppliers` distinct names with varied punctuation.
  // Patterns mirror the fox file: trailing commas, periods, suffixes, dba forms, etc.
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
  for (let i = 0; i < uniqueSuppliers; i++) {
    names.push(patterns[i % patterns.length](i));
  }

  for (let i = 0; i < rowCount; i++) {
    const supplier = names[i % uniqueSuppliers];
    const amount = ((i % 9999) + 0.5).toFixed(2);
    const day = (i % 28) + 1;
    const date = `2024-01-${day < 10 ? '0' : ''}${day}`;
    // Quote the supplier name because it may contain commas
    ws.write(`"${supplier.replace(/"/g, '""')}",${amount},${date}\n`);
  }
  ws.end();
  await new Promise<void>((res, rej) => {
    ws.on('finish', () => res());
    ws.on('error', rej);
  });
  return csvPath;
}
