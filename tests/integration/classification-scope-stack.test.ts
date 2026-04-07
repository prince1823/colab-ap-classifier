/**
 * Stack overflow regression test — classification on a 2.5M-row filtered scope.
 *
 * Reproduces the "Maximum call stack size exceeded" bug that hit when
 * `classifyAll(filter)` resolved a 2.5M-row scope. The bug was caused by
 * spreading large ID arrays into function arguments inside `classification.ts`
 * (`...Array.from(scopedIds)`) and `transactions.updateTransactions`
 * (`...update.ids`). Both call sites are now chunked + temp-table backed.
 *
 * This test bypasses CSV ingest entirely — it inserts 2.5M rows via
 * DuckDB's `range()` table function and a single rule that matches all rows,
 * so Phase 1 (`evaluateRulesBulk` + `updateTransactions`) handles everything
 * and exercises every fix on the hot path.
 *
 * GATED — heavy. Skipped unless `RUN_HEAVY=1` is set in the environment.
 * Run via:
 *   RUN_HEAVY=1 npx vitest run tests/integration/classification-scope-stack.test.ts
 *   or: npm run test:heavy
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

vi.mock('electron', () => {
  const _win = { webContents: { send: () => {} } };
  const BW = Object.assign(vi.fn(() => _win), {
    getFocusedWindow: vi.fn(() => _win),
    getAllWindows: vi.fn(() => [_win]),
  });
  return {
    dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: BW,
  };
});

import { DuckDBDatabase } from '../../src/main/services/database';
import { DuckDBSupplierUniverse } from '../../src/main/services/supplier-universe';
import { ChangelogStore } from '../../src/main/services/changelog';
import { TransactionStore } from '../../src/main/services/transactions';
import { ProjectStore } from '../../src/main/services/project';
import { TaxonomyStore } from '../../src/main/services/taxonomy';
import { RuleStore } from '../../src/main/services/rules';
import { ClassificationRunner } from '../../src/main/services/classification';
import { SupplierService } from '../../src/main/services/supplier-service';
import { eventBus } from '../../src/main/event-bus';
import type { ClassificationAgent, GroupedFilter } from '../../src/shared/types';

const RUN_HEAVY = process.env.RUN_HEAVY === '1';
const ROW_COUNT = 2_500_000;

function tempPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `c91-stack-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}

async function preCreateUniverse(p: string): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const inst = await DuckDBInstance.create(p);
  inst.closeSync();
}

function createNoopAgent(): ClassificationAgent {
  // Phase 1 (rules) handles all rows, so the LLM agent should never be called.
  // If it is, fail loudly.
  const fail = vi.fn().mockImplementation(() => {
    throw new Error('LLM agent should not be invoked — rules should match all rows');
  });
  return {
    selectCategories: fail,
    selectCategoriesForTailSpend: fail,
    classifyL3: fail,
    classifyL3ForTailSpend: fail,
    classifyTransactionGroup: fail,
  } as unknown as ClassificationAgent;
}

describe.skipIf(!RUN_HEAVY)('Classification 2.5M-row scope — stack overflow regression', () => {
  let dbPath: string;
  let universePath: string;
  let db: DuckDBDatabase;
  let supplierUniverse: DuckDBSupplierUniverse;
  let project: ProjectStore;
  let transactions: TransactionStore;
  let changelog: ChangelogStore;
  let taxonomy: TaxonomyStore;
  let rules: RuleStore;
  let suppliers: SupplierService;
  let classifier: ClassificationRunner;

  beforeAll(async () => {
    dbPath = tempPath('.c91');
    universePath = tempPath('-universe.db');
    await preCreateUniverse(universePath);

    db = new DuckDBDatabase();
    const mockAppConfig = {
      getApiKey: () => null,
      setApiKey: async () => {},
      getProvider: () => 'openrouter',
      setProvider: async () => {},
      getModel: () => 'claude-3-5-haiku-latest',
      setModel: async () => {},
      getSupplierUniversePath: () => universePath,
      setSupplierUniversePath: async () => {},
      clearSupplierUniversePath: async () => {},
    };
    supplierUniverse = new DuckDBSupplierUniverse(mockAppConfig);

    changelog = new ChangelogStore(db);
    transactions = new TransactionStore(db, changelog);
    project = new ProjectStore(db, transactions, supplierUniverse);
    transactions.setProjectStore(project);
    taxonomy = new TaxonomyStore(db, project);
    rules = new RuleStore(db, transactions, project);
    suppliers = new SupplierService(db, supplierUniverse);
    classifier = new ClassificationRunner(
      db, taxonomy, project, rules,
      transactions, changelog,
      createNoopAgent(), eventBus, supplierUniverse, suppliers
    );

    await project.createProject('stack-test', dbPath);

    // Required by ClassificationRunner — column must exist on transactions table.
    await db.run(`ALTER TABLE transactions ADD COLUMN gl_description VARCHAR`);
    await project.setSetting('column_priorities', ['gl_description']);
    await project.setSetting('company_context', { industry: 'Test' });

    // Seed taxonomy node directly (skip TaxonomyStore validation overhead)
    const taxId = crypto.randomUUID();
    await db.run(
      `INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, parent_path)
       VALUES (?, 'L1|L2|Leaf', 'L1', 'L2', 'Leaf', 3, 'L1|L2')`,
      taxId
    );

    // Seed one project supplier
    const supId = crypto.randomUUID();
    await db.run(
      `INSERT INTO project_suppliers (id, supplier_name, l1_l2_path)
       VALUES (?, 'Test Supplier', '["L1|L2"]')`,
      supId
    );

    // Bulk-insert 2.5M transactions via DuckDB range() — fast & low-memory.
    console.log(`  Inserting ${ROW_COUNT.toLocaleString()} transactions…`);
    const t0 = Date.now();
    await db.run(
      `INSERT INTO transactions (id, row_index, original_supplier_name, project_supplier_id, classification_status, gl_description)
       SELECT 'tx-' || i, i, 'Test Supplier', ?, 'unclassified', 'desc'
       FROM range(0, ?) tbl(i)`,
      supId, ROW_COUNT
    );
    console.log(`  Inserted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Seed one rule that matches every transaction (original_supplier_name = 'Test Supplier').
    // Insert directly to bypass FK checks / supplier resolution.
    const ruleId = crypto.randomUUID();
    await db.run(
      `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, is_active)
       VALUES (?, 'match-all', ?, ?, TRUE)`,
      ruleId,
      JSON.stringify({
        groupConnector: 'AND',
        groups: [{
          connector: 'AND',
          conditions: [{ field: 'original_supplier_name', operator: 'equals', value: 'Test Supplier' }],
        }],
      }),
      taxId
    );
    await db.run(
      `INSERT INTO rule_conditions (rule_id, group_idx, condition_idx, field, operator, value, group_connector, condition_connector)
       VALUES (?, 0, 0, 'original_supplier_name', 'equals', 'Test Supplier', 'AND', 'AND')`,
      ruleId
    );
  }, 10 * 60_000);

  afterAll(async () => {
    try { await project.closeProject(); } catch { /* */ }
    if (supplierUniverse.isOpen()) await supplierUniverse.close();
    for (const p of [dbPath, universePath]) {
      for (const suffix of ['', '.wal']) {
        const fp = p + suffix;
        if (fs.existsSync(fp)) {
          try { fs.unlinkSync(fp); } catch { /* */ }
        }
      }
    }
  });

  it(`classifyAll on a ${ROW_COUNT.toLocaleString()}-row filtered scope completes without RangeError`, async () => {
    // Sanity: row count is what we inserted.
    const countRow = await db.get<{ cnt: number | bigint }>('SELECT COUNT(*) as cnt FROM transactions');
    expect(Number(countRow?.cnt ?? 0)).toBe(ROW_COUNT);

    // Filter that resolves to ALL 2.5M rows — forces the scopedIds branch.
    const filter: GroupedFilter = {
      groupConnector: 'AND',
      groups: [{
        connector: 'AND',
        conditions: [{ field: 'classification_status', operator: 'equals', value: 'unclassified' }],
      }],
    };

    const t0 = Date.now();
    let caught: unknown = null;
    try {
      await classifier.classifyAll(filter);
    } catch (err) {
      caught = err;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  classifyAll completed in ${elapsed}s`);

    if (caught instanceof RangeError) {
      throw new Error(`Stack overflow regression: ${caught.message}`);
    }
    expect(caught).toBeNull();

    const stats = await transactions.getStats();
    expect(stats.classifiedRows).toBe(ROW_COUNT);
  }, 15 * 60_000);
});
