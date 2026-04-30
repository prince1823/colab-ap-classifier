/**
 * Bisect against main (v1.6.1) — figure out what triggers the duplicate-UUID
 * UPDATE FROM bug in main's flow (no project_supplier_aliases table).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { parse as parseStream } from 'csv-parse';
import { DuckDBDatabase } from '../../../src/main/services/database';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => ({})), getAllWindows: vi.fn(() => [{}]) },
}));

const ROW_COUNT = 50_000;
const UNIQUE_SUPPLIERS = 8_000;
const LINK_BATCH = 500;

function tempPath(ext: string): string {
  return path.join(os.tmpdir(), `bm-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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

const SUFFIXES = ['llc', 'inc.', 'inc', 'corp.', 'corp', 'ltd.', 'ltd', 'co.'].sort((a, b) => b.length - a.length);
function cleanSupplierName(raw: string): string {
  let n = raw.trim().replace(/\s+/g, ' ');
  for (const s of SUFFIXES) {
    const re = new RegExp(`[,\\s]+${s.replace(/\./g, '\\.')}\\s*$`, 'i');
    const cleaned = n.replace(re, '').trim();
    if (cleaned !== n && cleaned.length >= 5) {
      n = cleaned;
      break;
    }
  }
  return n;
}

describe('Bisect on main: duplicate-UUID trigger', () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M0: Mimic main's normalizeAllTransactions pattern WITHOUT csv stream.
  //   - INSERT 50k transactions (project_supplier_id NULL).
  //   - For each of 8000 unique names: 2 SELECTs against project_suppliers + 1 INSERT.
  //   - Chunked UPDATE FROM.
  // ──────────────────────────────────────────────────────────────────────────
  it('M0: db.tx, no stream, 2 SELECTs (suppliers) + 1 INSERT (suppliers) per supplier', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);

    await db.tx(async () => {
      // Phase 1: bulk insert transactions
      const allRows: string[] = [];
      for (let i = 0; i < ROW_COUNT; i++) {
        const id = randomUUID();
        const name = names[i % names.length].replace(/'/g, "''");
        allRows.push(`('${id}', '${name}', NULL)`);
      }
      await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES ${allRows.join(',\n')}`);

      // Phase 2: mimic main's normalizeSupplierName + findOrCreateSupplier
      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        // SELECT #1 (normalizeSupplierName fast path)
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string;
        if (existing) {
          sid = existing.id;
        } else {
          // SELECT #2 (findOrCreateSupplier internal)
          const recheck = await db.get<{ id: string }>(
            'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
          );
          if (recheck) {
            sid = recheck.id;
          } else {
            sid = randomUUID();
            await db.run(
              'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
              sid, cleaned, false
            );
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      // Phase 3: chunked UPDATE FROM
      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M1: Layer M0 but use csv-parse stream (mimic IngestService.importCSV)
  // ──────────────────────────────────────────────────────────────────────────
  it('M1: db.tx + csv-parse stream + 2 SELECTs (suppliers) + INSERT supplier', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL)`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string;
        if (existing) {
          sid = existing.id;
        } else {
          const recheck = await db.get<{ id: string }>(
            'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
          );
          if (recheck) {
            sid = recheck.id;
          } else {
            sid = randomUUID();
            await db.run(
              'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
              sid, cleaned, false
            );
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M3: M2 + ALTER TABLE inside the tx (mimics IngestService adding canonical cols)
  // ──────────────────────────────────────────────────────────────────────────
  it('M3: M2 + ALTER TABLE inside tx + wider transaction inserts', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      // ALTER TABLE inside tx (mimic IngestService)
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        // Wider INSERT (mimic IngestService): id, original_supplier_name, project_supplier_id, spend_amount, master_date
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string | undefined;
        if (existing) {
          sid = existing.id;
        } else {
          sid = aliasMap.get(raw.toLowerCase());
          if (!sid) {
            const recheck = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
            );
            if (recheck) {
              sid = recheck.id;
            } else {
              sid = randomUUID();
              await db.run(
                'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
                sid, cleaned, false
              );
            }
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M4: same as M3 but use the REAL SupplierService.normalizeAllTransactions
  // ──────────────────────────────────────────────────────────────────────────
  it('M4: csv stream + ALTER + REAL SupplierService.normalizeAllTransactions', async () => {
    const { SupplierService } = await import('../../../src/main/services/supplier-service');
    const supplierUniverse = {
      isOpen: () => false,
      searchVariants: async () => [],
      getSupplier: async () => null,
      upsertSupplierFull: async () => {},
    } as any;
    const suppliers = new SupplierService(db, supplierUniverse);

    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      // REAL SupplierService.normalizeAllTransactions
      await suppliers.normalizeAllTransactions();
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M5: M3 + add awaits on mocked async functions (mimic universe calls)
  // ──────────────────────────────────────────────────────────────────────────
  it('M5: M3 + 2 await mockedAsyncFn() per iteration (mimic universe calls)', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    const noopAsync1 = async () => [] as string[];
    const noopAsync2 = async () => null;

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string | undefined;
        if (existing) {
          sid = existing.id;
        } else {
          sid = aliasMap.get(raw.toLowerCase());
          if (!sid) {
            const recheck = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
            );
            if (recheck) {
              sid = recheck.id;
            } else {
              // NEW IN M5: mocked universe calls (mimic findOrCreateSupplier interior)
              await noopAsync1();
              await noopAsync2();
              sid = randomUUID();
              await db.run(
                'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
                sid, cleaned, false
              );
            }
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M6: M3 but use uuidv4() from 'uuid' lib (like real code) for supplier ids.
  // ──────────────────────────────────────────────────────────────────────────
  it('M6: M3 but supplier ids from uuidv4 (uuid pkg) instead of crypto.randomUUID', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();  // transactions.id stays as randomUUID (matches IngestService)
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string | undefined;
        if (existing) {
          sid = existing.id;
        } else {
          sid = aliasMap.get(raw.toLowerCase());
          if (!sid) {
            const recheck = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
            );
            if (recheck) {
              sid = recheck.id;
            } else {
              sid = uuidv4();   // ← changed from randomUUID() to uuidv4()
              await db.run(
                'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
                sid, cleaned, false
              );
            }
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${uuidv4().replace(/-/g, '')}`;  // ← changed
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M7: M3 but call REAL SupplierService.normalizeSupplierName per supplier
  //           (still inlined chunked UPDATE FROM at the end).
  // ──────────────────────────────────────────────────────────────────────────
  it('M7: M3 but REAL normalizeSupplierName per supplier (inlined linking)', async () => {
    const { SupplierService } = await import('../../../src/main/services/supplier-service');
    const supplierUniverse = {
      isOpen: () => false,
      searchVariants: async () => [],
      getSupplier: async () => null,
      upsertSupplierFull: async () => {},
    } as any;
    const suppliers = new SupplierService(db, supplierUniverse);

    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      // Use REAL normalizeSupplierName
      const supplierRows = await db.all<{ original_supplier_name: string }>(
        `SELECT DISTINCT original_supplier_name FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
      );
      const nameToSupplierId = new Map<string, string>();
      for (const row of supplierRows) {
        const sid = await suppliers.normalizeSupplierName(row.original_supplier_name, aliasMap);
        nameToSupplierId.set(row.original_supplier_name, sid);
      }

      // Inlined chunked UPDATE FROM
      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // RE-IMPORT scenario (the user's actual repro): import once, then again.
  // First import succeeds. Second import inserts new rows where the existing
  // suppliers are already in project_suppliers and old transactions hold the
  // aliases — so normalizeSupplierName mostly HITs the SELECT, no new inserts.
  // Then the chunked UPDATE FROM links the new transactions.
  // ──────────────────────────────────────────────────────────────────────────
  it('M-REIMPORT: import the same CSV twice (real IngestService) — does the 2nd fail?', async () => {
    const { SupplierService } = await import('../../../src/main/services/supplier-service');
    const { IngestService } = await import('../../../src/main/services/ingest');

    const supplierUniverse = {
      isOpen: () => false,
      searchVariants: async () => [],
      getSupplier: async () => null,
      upsertSupplierFull: async () => {},
    } as any;
    const suppliers = new SupplierService(db, supplierUniverse);

    const projectStore: any = {
      setSetting: vi.fn(async (key: string, value: unknown) => {
        await db.run(
          `INSERT INTO project_settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          key, JSON.stringify(value),
        );
      }),
      getSetting: vi.fn(async (key: string) => {
        const row = await db.get<{ value: string }>(
          'SELECT value FROM project_settings WHERE key = ?', key
        );
        return row ? JSON.parse(row.value) : undefined;
      }),
      get: vi.fn(),
      set: vi.fn(),
    };
    const transactionsStore: any = { invalidateColumnCache: vi.fn() };
    const eventBus: any = { emit: vi.fn(), on: vi.fn() };
    const columnMappingAgent: any = { suggestMappings: vi.fn() };

    const service = new IngestService(
      db, transactionsStore, suppliers, projectStore, columnMappingAgent, eventBus,
    );

    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    const MAPPING = { supplier_name: 'Supplier', spend_amount: 'Amount', master_date: 'Date' };

    // ── First import — should succeed ──
    // eslint-disable-next-line no-console
    console.log('FIRST IMPORT...');
    await service.importCSV(csvPath, MAPPING);
    const after1 = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    // eslint-disable-next-line no-console
    console.log(`  → ${Number(after1?.c)} transactions after first import`);
    expect(Number(after1?.c)).toBe(ROW_COUNT);

    // ── Second import (same CSV) — does it fail? ──
    // eslint-disable-next-line no-console
    console.log('SECOND IMPORT (same CSV)...');
    try {
      await service.importCSV(csvPath, MAPPING);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('  → SECOND IMPORT FAILED:', (e as Error).message);
      throw e;
    }
    const after2 = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    // eslint-disable-next-line no-console
    console.log(`  → ${Number(after2?.c)} transactions after second import`);
    expect(Number(after2?.c)).toBe(ROW_COUNT * 2);
  }, 600_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M8: combine M5 (mocked async) + M6 (uuidv4) + recompute cleanedName.
  //           This is the closest pure-inline mimic of findOrCreateSupplier yet.
  // ──────────────────────────────────────────────────────────────────────────
  it('M8: M3 + mocked async + uuidv4 + recompute cleanedName (full mimic)', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    const noopVariants = async (_n: string) => [] as string[];
    const noopGetSupplier = async (_n: string) => null;

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      // Mimic normalizeSupplierName + findOrCreateSupplier as closely as possible
      const normalizeSupplierName = async (rawName: string): Promise<string> => {
        const cleanedName = cleanSupplierName(rawName);

        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
          cleanedName
        );
        if (existing) return existing.id;

        const supplierId = aliasMap.get(rawName.toLowerCase());
        if (supplierId) return supplierId;

        // findOrCreateSupplier inline:
        const cleanedName2 = cleanSupplierName(rawName);  // recompute
        const existing2 = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
          cleanedName2
        );
        if (existing2) return existing2.id;

        const variants = await noopVariants(rawName);
        if (variants.length > 0) {
          for (const variant of variants) {
            const vRow = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
              cleanSupplierName(variant)
            );
            if (vRow) return vRow.id;
          }
        }

        const id = uuidv4();
        const universeInfo = await noopGetSupplier(rawName);
        await db.run(
          'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
          id, cleanedName2, universeInfo ? true : false
        );
        return id;
      };

      const supplierRows = await db.all<{ original_supplier_name: string }>(
        `SELECT DISTINCT original_supplier_name FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
      );
      const nameToSupplierId = new Map<string, string>();
      for (const row of supplierRows) {
        const sid = await normalizeSupplierName(row.original_supplier_name);
        nameToSupplierId.set(row.original_supplier_name, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${uuidv4().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M9: M5 (mocked async) + M6 (uuidv4 supplier ids).
  // ──────────────────────────────────────────────────────────────────────────
  it('M9: csv stream + 2 mocked async + uuidv4 (no recomputed cleanedName)', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    const noopAsync1 = async () => [] as string[];
    const noopAsync2 = async () => null;

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string | undefined;
        if (existing) {
          sid = existing.id;
        } else {
          sid = aliasMap.get(raw.toLowerCase());
          if (!sid) {
            const recheck = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
            );
            if (recheck) {
              sid = recheck.id;
            } else {
              await noopAsync1();
              sid = uuidv4();   // ← uuidv4
              await noopAsync2();
              await db.run(
                'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
                sid, cleaned, false
              );
            }
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${uuidv4().replace(/-/g, '')}`;  // uuidv4 here too
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M10: M9 + read distinct supplier names from transactions (instead of names[])
  // ──────────────────────────────────────────────────────────────────────────
  it('M10: M9 + SELECT DISTINCT original_supplier_name FROM transactions', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    const noopAsync1 = async () => [] as string[];
    const noopAsync2 = async () => null;

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      // NEW IN M10: read supplier rows from transactions (real normalizeAllTransactions does this)
      const supplierRows = await db.all<{ original_supplier_name: string }>(
        `SELECT DISTINCT original_supplier_name FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
      );
      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      const nameToSupplierId = new Map<string, string>();
      for (const row of supplierRows) {
        const raw = row.original_supplier_name;
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string | undefined;
        if (existing) {
          sid = existing.id;
        } else {
          sid = aliasMap.get(raw.toLowerCase());
          if (!sid) {
            const recheck = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
            );
            if (recheck) {
              sid = recheck.id;
            } else {
              await noopAsync1();
              sid = uuidv4();
              await noopAsync2();
              await db.run(
                'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
                sid, cleaned, false
              );
            }
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${uuidv4().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M11: like M10 BUT without the aliasMap scan — only the supplierRows scan.
  //            If this fails → the supplierRows scan alone is the trigger.
  //            If this passes → it's the COMBINATION of two transaction scans.
  // ──────────────────────────────────────────────────────────────────────────
  it('M11: only the supplierRows scan, no aliasMap scan', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      await db.run('ALTER TABLE transactions ADD COLUMN "spend_amount" VARCHAR');
      await db.run('ALTER TABLE transactions ADD COLUMN "master_date" VARCHAR');

      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id, spend_amount, master_date) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          const amt = (record.Amount ?? '').replace(/'/g, "''");
          const date = (record.Date ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL, '${amt}', '${date}')`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      // ONLY the supplierRows scan — no aliasMap scan
      const supplierRows = await db.all<{ original_supplier_name: string }>(
        `SELECT DISTINCT original_supplier_name FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
      );

      const nameToSupplierId = new Map<string, string>();
      for (const row of supplierRows) {
        const raw = row.original_supplier_name;
        const cleaned = cleanSupplierName(raw);
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string;
        if (existing) {
          sid = existing.id;
        } else {
          const recheck = await db.get<{ id: string }>(
            'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
          );
          if (recheck) {
            sid = recheck.id;
          } else {
            sid = randomUUID();
            await db.run(
              'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
              sid, cleaned, false
            );
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer M2: M1 + the aliasMap SELECT (full-table scan of transactions)
  //           that main's normalizeAllTransactions does before the loop.
  // ──────────────────────────────────────────────────────────────────────────
  it('M2: M1 + SELECT FROM transactions WHERE project_supplier_id IS NOT NULL (aliasMap)', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      let batch: string[] = [];
      const BATCH_SIZE = 50_000;
      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES ${records.join(',\n')}`);
      };
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }));
        let streamError: Error | null = null;
        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL)`);
          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch; batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error; rs.destroy(); parser.destroy(); reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch; batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      // NEW IN M2: simulate main's aliasMap pre-fetch (full transactions scan)
      const aliasRows = await db.all<{ key: string; project_supplier_id: string }>(
        `SELECT lower(original_supplier_name) AS key, project_supplier_id
         FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
      );
      const aliasMap = new Map<string, string>(aliasRows.map((r) => [r.key, r.project_supplier_id]));

      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        // Fast path: SELECT supplier
        const existing = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string | undefined;
        if (existing) {
          sid = existing.id;
        } else {
          // aliasMap check (in-memory)
          sid = aliasMap.get(raw.toLowerCase());
          if (!sid) {
            // findOrCreateSupplier
            const recheck = await db.get<{ id: string }>(
              'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
            );
            if (recheck) {
              sid = recheck.id;
            } else {
              sid = randomUUID();
              await db.run(
                'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
                sid, cleaned, false
              );
            }
          }
        }
        nameToSupplierId.set(raw, sid);
      }

      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions SET project_supplier_id = m.supplier_id
            FROM ${tmp} m
            WHERE transactions.original_supplier_name = m.original_name
              AND transactions.project_supplier_id IS NULL
          `);
        } finally {
          try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
        }
      }
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);
});
