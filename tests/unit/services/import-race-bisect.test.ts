/**
 * Layer-bisection of the duplicate-UUID UPDATE FROM bug.
 *
 * Established facts (from import-race.test.ts):
 *   - Plain DuckDB connection + manual BEGIN/COMMIT + same data shape → PASSES.
 *   - Full IngestService.importCSV → FAILS with duplicate transactions.id.
 *
 * Each layer below adds one piece of the project's wrapping. We want to find
 * the smallest configuration that reproduces the failure.
 *
 *   Layer A: DuckDBDatabase wrapper, db.run/db.exec, MANUAL BEGIN/COMMIT (no db.tx)
 *   Layer B: DuckDBDatabase wrapper, db.tx() wrapping, NO csv-parse stream
 *   Layer C: DuckDBDatabase wrapper, db.tx() wrapping, WITH csv-parse stream
 *
 * Failing layer = the wrapping piece that introduces the bug.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
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
  return path.join(os.tmpdir(), `bisect-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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

// Schema setup duplicating what the project's migrations create
async function setupSchema(db: DuckDBDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id VARCHAR PRIMARY KEY,
      original_supplier_name VARCHAR,
      project_supplier_id VARCHAR
    );
    CREATE TABLE IF NOT EXISTS project_suppliers (
      id VARCHAR PRIMARY KEY,
      supplier_name VARCHAR NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS project_supplier_aliases (
      id VARCHAR PRIMARY KEY,
      project_supplier_id VARCHAR NOT NULL,
      alias VARCHAR NOT NULL,
      alias_key VARCHAR NOT NULL UNIQUE,
      source VARCHAR NOT NULL
    );
  `);
}

// Replicate the project's cleanSupplierName + aliasKey
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
function aliasKey(a: string): string {
  return a.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Body that does the work: insert transactions in batches, then resolve suppliers,
// then chunked UPDATE FROM. Same shape as IngestService → SupplierService.normalizeAllTransactions.
async function importPipeline(db: DuckDBDatabase, names: string[], rowCount: number): Promise<void> {
  // Phase 1: bulk insert transactions in 50k-row batches
  const BATCH_SIZE = 50_000;
  const allRows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const id = randomUUID();
    const name = names[i % names.length].replace(/'/g, "''");
    allRows.push(`('${id}', '${name}', NULL)`);
    if (allRows.length === BATCH_SIZE || i === rowCount - 1) {
      await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES ${allRows.join(',\n')}`);
      allRows.length = 0;
    }
  }

  // Phase 2: build supplier + alias maps
  const supplierIds = new Map<string, string>();  // cleaned name (lowercase) → sid
  const nameToSupplierId = new Map<string, string>();  // raw name → sid
  for (const raw of names) {
    const cleaned = cleanSupplierName(raw);
    let sid = supplierIds.get(cleaned.toLowerCase());
    if (!sid) {
      sid = randomUUID();
      supplierIds.set(cleaned.toLowerCase(), sid);
      await db.run(
        'INSERT INTO project_suppliers (id, supplier_name) VALUES (?, ?)',
        sid,
        cleaned,
      );
    }
    nameToSupplierId.set(raw, sid);
    await db.run(
      'INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source) VALUES (?, ?, ?, ?, ?)',
      randomUUID(),
      sid,
      raw,
      aliasKey(raw),
      'raw_import',
    );
  }

  // Phase 3: chunked UPDATE FROM (same shape as supplier-service.ts)
  const entries = [...nameToSupplierId.entries()];
  for (let i = 0; i < entries.length; i += LINK_BATCH) {
    const chunk = entries.slice(i, i + LINK_BATCH);
    const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
    await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
    try {
      const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s.replace(/'/g, "''")}')`).join(',\n');
      await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
      await db.exec(`
        UPDATE transactions
        SET project_supplier_id = m.supplier_id
        FROM ${tmp} m
        WHERE transactions.original_supplier_name = m.original_name
          AND transactions.project_supplier_id IS NULL
      `);
    } finally {
      try { await db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch { /* ignore */ }
    }
  }
}

describe('Bisect: which wrapping layer triggers the bug?', () => {
  let db: DuckDBDatabase;
  let dbPath: string;
  const tempCsvs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new DuckDBDatabase();
    dbPath = tempPath('.c91');
    await db.openDatabase(dbPath);
    await setupSchema(db);
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
  // Layer A: DuckDBDatabase wrapper, db.run/db.exec, MANUAL BEGIN/COMMIT
  //          (No db.tx, no csv stream — just sequential awaited calls.)
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer A: db.run/exec + manual BEGIN/COMMIT (no db.tx, no stream)', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    await db.run('BEGIN TRANSACTION');
    try {
      await importPipeline(db, names, ROW_COUNT);
      await db.run('COMMIT');
    } catch (e) {
      await db.run('ROLLBACK');
      throw e;
    }
    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer B: DuckDBDatabase wrapper, db.tx() wrapping. No csv stream.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer B: wrapped in db.tx() (no stream)', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    await db.tx(async () => {
      await importPipeline(db, names, ROW_COUNT);
    });
    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer C: DuckDBDatabase wrapper, db.tx() wrapping, csv-parse stream
  //          (Mimics IngestService.importCSV's parser.on('data') flushBatch.)
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer C: db.tx() + csv-parse stream + chunked UPDATE FROM', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      // Phase 1: stream + flushBatch (mimicking IngestService's parser pattern)
      let batch: string[] = [];
      let rowIndex = 0;
      const BATCH_SIZE = 50_000;

      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES ${records.join(',\n')}`);
      };

      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({
          columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true,
        }));
        let streamError: Error | null = null;

        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL)`);
          rowIndex++;

          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch;
            batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error;
              rs.destroy();
              parser.destroy();
              reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch;
          batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      // Phase 2 & 3: same as importPipeline phases 2 & 3
      const supplierIds = new Map<string, string>();
      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        let sid = supplierIds.get(cleaned.toLowerCase());
        if (!sid) {
          sid = randomUUID();
          supplierIds.set(cleaned.toLowerCase(), sid);
          await db.run('INSERT INTO project_suppliers (id, supplier_name) VALUES (?, ?)', sid, cleaned);
        }
        nameToSupplierId.set(raw, sid);
        await db.run(
          'INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source) VALUES (?, ?, ?, ?, ?)',
          randomUUID(), sid, raw, aliasKey(raw), 'raw_import',
        );
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
            UPDATE transactions
            SET project_supplier_id = m.supplier_id
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
  }, 240_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Layer C2: Layer C, BUT replace the simple INSERT-supplier+INSERT-alias loop
  //           with the same SELECT-before-INSERT pattern SupplierService uses.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer C2: db.tx() + csv stream + SELECT-then-INSERT supplier pattern', async () => {
    const names = generateNames(UNIQUE_SUPPLIERS);
    const csvPath = await writeCsv(ROW_COUNT, names);
    tempCsvs.push(csvPath);

    await db.tx(async () => {
      // Phase 1: stream + flushBatch (same as Layer C)
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
            const cur = batch;
            batch = [];
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

      // Phase 2: SELECT-then-INSERT pattern matching normalizeSupplierName/recordSupplierAlias
      const supplierRows = await db.all<{ original_supplier_name: string }>(
        `SELECT DISTINCT original_supplier_name FROM transactions
         WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
      );
      const aliasMap = new Map<string, string>();
      const nameToSupplierId = new Map<string, string>();
      for (const row of supplierRows) {
        const raw = row.original_supplier_name;
        const cleaned = cleanSupplierName(raw);
        const key = aliasKey(raw);

        // 1. aliasMap (in-memory) check
        let sid = aliasMap.get(key);
        if (!sid) {
          // 2. SELECT supplier by cleaned name
          const existing = await db.get<{ id: string }>(
            'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
          );
          if (existing) {
            sid = existing.id;
          } else {
            // 3. SELECT (recheck via findOrCreateSupplier) then INSERT
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
        // 4. recordSupplierAlias: SELECT-then-INSERT-or-UPDATE
        const existingAlias = await db.get<{ id: string; project_supplier_id: string }>(
          'SELECT id, project_supplier_id FROM project_supplier_aliases WHERE alias_key = ?', key
        );
        if (existingAlias) {
          await db.run(
            `UPDATE project_supplier_aliases SET project_supplier_id = ?, alias = ?, source = ?, last_seen_at = CURRENT_TIMESTAMP WHERE alias_key = ?`,
            sid, raw, 'raw_import', key
          );
        } else {
          await db.run(
            `INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source) VALUES (?, ?, ?, ?, ?)`,
            randomUUID(), sid, raw, key, 'raw_import'
          );
        }
        nameToSupplierId.set(raw, sid);
        aliasMap.set(key, sid);
      }

      // Phase 3: chunked UPDATE FROM (same as Layer C)
      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += LINK_BATCH) {
        const chunk = entries.slice(i, i + LINK_BATCH);
        const tmp = `_norm_map_${randomUUID().replace(/-/g, '')}`;
        await db.exec(`CREATE TEMP TABLE ${tmp} (original_name VARCHAR, supplier_id VARCHAR)`);
        try {
          const vals = chunk.map(([n, s]) => `('${n.replace(/'/g, "''")}', '${s}')`).join(',\n');
          await db.exec(`INSERT INTO ${tmp} (original_name, supplier_id) VALUES ${vals}`);
          await db.exec(`
            UPDATE transactions
            SET project_supplier_id = m.supplier_id
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
  // Layer C3: Layer C2 but skip the SELECTs against project_suppliers
  //           (use only an in-memory cache; INSERT directly).
  //           Keeps the alias SELECT-then-INSERT pattern.
  //           If this passes → bug is in the project_suppliers SELECTs (the lower(...) ones).
  //           If this fails → bug is in the alias SELECT-then-INSERT.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer C3: csv stream + INSERT-only suppliers + SELECT-then-INSERT aliases', async () => {
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

      // INSERT-only suppliers (no SELECT against project_suppliers).
      // SELECT-then-INSERT aliases (the part we're keeping from C2).
      const supplierIds = new Map<string, string>();
      const nameToSupplierId = new Map<string, string>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const ckey = cleaned.toLowerCase();
        let sid = supplierIds.get(ckey);
        if (!sid) {
          sid = randomUUID();
          supplierIds.set(ckey, sid);
          await db.run(
            'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
            sid, cleaned, false
          );
        }
        // SELECT-then-INSERT alias (kept from Layer C2)
        const akey = aliasKey(raw);
        const existingAlias = await db.get<{ id: string }>(
          'SELECT id FROM project_supplier_aliases WHERE alias_key = ?', akey
        );
        if (!existingAlias) {
          await db.run(
            `INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source) VALUES (?, ?, ?, ?, ?)`,
            randomUUID(), sid, raw, akey, 'raw_import'
          );
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
            UPDATE transactions
            SET project_supplier_id = m.supplier_id
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
  // Layer C4: SELECT-then-INSERT suppliers (with lower() comparison) + INSERT-only aliases.
  //           If this fails → the bug is the lower(supplier_name) SELECT pattern.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer C4: csv stream + SELECT(lower)-then-INSERT suppliers + INSERT-only aliases', async () => {
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

      // SELECT-then-INSERT suppliers (the part we're testing)
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
          sid = randomUUID();
          await db.run(
            'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
            sid, cleaned, false
          );
        }
        // INSERT-only alias (no SELECT)
        await db.run(
          `INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source) VALUES (?, ?, ?, ?, ?)`,
          randomUUID(), sid, raw, aliasKey(raw), 'raw_import'
        );
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
            UPDATE transactions
            SET project_supplier_id = m.supplier_id
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
  // Layer C5: TWO SELECTs against project_suppliers per iteration + INSERT-only aliases.
  //           Tests whether the bug is "two SELECTs interspersed with INSERTs"
  //           regardless of which table the SELECTs target.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer C5: csv stream + 2 SELECTs against project_suppliers + INSERT-only aliases', async () => {
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
        // SELECT #1: lower comparison
        const existing1 = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        // SELECT #2: same query (simulating recheck)
        const existing2 = await db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)', cleaned
        );
        let sid: string;
        if (existing1 || existing2) {
          sid = (existing1 || existing2)!.id;
        } else {
          sid = randomUUID();
          await db.run(
            'INSERT INTO project_suppliers (id, supplier_name, universe_match) VALUES (?, ?, ?)',
            sid, cleaned, false
          );
        }
        await db.run(
          `INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source) VALUES (?, ?, ?, ?, ?)`,
          randomUUID(), sid, raw, aliasKey(raw), 'raw_import'
        );
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
            UPDATE transactions
            SET project_supplier_id = m.supplier_id
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
  // Layer C6: Proposed fix — replace SELECT-then-INSERT with
  //           INSERT ... ON CONFLICT DO NOTHING for both tables, then a
  //           single SELECT to read back the canonical supplier_id.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer C6: csv stream + INSERT...ON CONFLICT DO NOTHING (no pre-INSERT SELECTs)', async () => {
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

      // PROPOSED PATTERN: bulk INSERT ON CONFLICT DO NOTHING, then read back ids.
      const supplierIds = new Map<string, string>();    // cleaned-lowercase → sid
      const nameToSupplierId = new Map<string, string>();

      // Bulk-build supplier rows: one per unique cleaned name
      const cleanedToCandidate = new Map<string, { sid: string; cleaned: string }>();
      for (const raw of names) {
        const cleaned = cleanSupplierName(raw);
        const ckey = cleaned.toLowerCase();
        if (!cleanedToCandidate.has(ckey)) {
          cleanedToCandidate.set(ckey, { sid: randomUUID(), cleaned });
        }
      }

      // Single bulk INSERT ON CONFLICT DO NOTHING into project_suppliers
      const supplierVals = [...cleanedToCandidate.values()].map(({ sid, cleaned }) =>
        `('${sid}', '${cleaned.replace(/'/g, "''")}', false)`
      ).join(',\n');
      await db.exec(`
        INSERT INTO project_suppliers (id, supplier_name, universe_match)
        VALUES ${supplierVals}
        ON CONFLICT (supplier_name) DO NOTHING
      `);

      // Read back authoritative ids for any rows that already existed
      const supplierRowsBack = await db.all<{ id: string; supplier_name: string }>(
        'SELECT id, supplier_name FROM project_suppliers'
      );
      for (const r of supplierRowsBack) {
        supplierIds.set(r.supplier_name.toLowerCase(), r.id);
      }

      // Bulk INSERT aliases ON CONFLICT DO NOTHING
      const aliasVals = names.map((raw) => {
        const cleaned = cleanSupplierName(raw);
        const sid = supplierIds.get(cleaned.toLowerCase())!;
        nameToSupplierId.set(raw, sid);
        return `('${randomUUID()}', '${sid}', '${raw.replace(/'/g, "''")}', '${aliasKey(raw).replace(/'/g, "''")}', 'raw_import')`;
      }).join(',\n');
      await db.exec(`
        INSERT INTO project_supplier_aliases (id, project_supplier_id, alias, alias_key, source)
        VALUES ${aliasVals}
        ON CONFLICT (alias_key) DO NOTHING
      `);

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
            UPDATE transactions
            SET project_supplier_id = m.supplier_id
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
  // Layer D: Layer C + use REAL SupplierService.normalizeAllTransactions
  //          instead of inlined Phase 2&3. This mirrors what IngestService does.
  // ──────────────────────────────────────────────────────────────────────────
  it('Layer D: db.tx() + csv stream + REAL SupplierService.normalizeAllTransactions', async () => {
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
      // Phase 1: stream + flushBatch (mimicking IngestService's parser pattern)
      let batch: string[] = [];
      const BATCH_SIZE = 50_000;

      const flushBatch = async (records: string[]) => {
        if (records.length === 0) return;
        await db.exec(`INSERT INTO transactions (id, original_supplier_name, project_supplier_id) VALUES ${records.join(',\n')}`);
      };

      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' });
        const parser = rs.pipe(parseStream({
          columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true,
        }));
        let streamError: Error | null = null;

        parser.on('data', (record: Record<string, string>) => {
          const id = randomUUID();
          const name = (record.Supplier ?? '').replace(/'/g, "''");
          batch.push(`('${id}', '${name}', NULL)`);

          if (batch.length >= BATCH_SIZE) {
            parser.pause();
            const cur = batch;
            batch = [];
            flushBatch(cur).then(() => parser.resume()).catch((err) => {
              streamError = err as Error;
              rs.destroy();
              parser.destroy();
              reject(streamError);
            });
          }
        });
        parser.on('end', () => {
          if (streamError) return;
          const remaining = batch;
          batch = [];
          flushBatch(remaining).then(resolve).catch(reject);
        });
        parser.on('error', (err) => streamError ?? reject(err));
        rs.on('error', (err) => streamError ?? reject(err));
      });

      // Phase 2 & 3: REAL SupplierService.normalizeAllTransactions
      await suppliers.normalizeAllTransactions();
    });

    const total = await db.get<{ c: number | bigint }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(total?.c)).toBe(ROW_COUNT);
  }, 300_000);
});
