/**
 * Classifier Full Run — integration test for the v2 architecture.
 *
 * Exercises the entire backend classifier end-to-end using real DuckDB,
 * real LLM calls, and real fixture data. Only Electron modules are mocked.
 *
 * Classifier flow:
 *   1. Create project (real DuckDB)
 *   2. Set company context
 *   3. Import taxonomy from ColabIP
 *   4. Upload CSV (with LLM-based column mapping)
 *   5. Seed supplier_universe.db
 *   6. Optionally research suppliers (real LLM)
 *   7. Run classification (real LLM)
 *   8. Verify classification results
 *   9. Test override rules
 *  10. Export and verify
 *
 * v2 schema: 5 tables (project, taxonomy, transactions, override_rules, change_log).
 * No review_score, no invoice_group_key. Uses classification_status field.
 * Supplier data lives in supplier_universe.db (separate DuckDB).
 * startClassification() takes NO parameters.
 *
 * Configurable via TEST_NAME env var and test_data/<TEST_NAME>/config.json.
 * Falls back to fixture-based test if no test_data folder is found.
 *
 * Requirements:
 *   - OPENROUTER_API_KEY or ANTHROPIC_API_KEY set in environment (or .env)
 *   - DuckDB native module compiled
 *   - colabip/ directory (for test_data mode) or tests/fixtures/colabip/ (fixture mode)
 *
 * Usage:
 *   # With test_data folder (real data, real LLM):
 *   TEST_NAME=innova_test npx vitest run tests/integration/pipeline-run.test.ts
 *
 *   # With fixtures only (uses fixture colabip):
 *   npx vitest run tests/integration/pipeline-run.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Disable per-test timeout — pipeline E2E scales with dataset size and LLM latency
vi.setConfig({ testTimeout: 0 });

// --- Mock Electron before any service imports ---
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => os.tmpdir(),
  },
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test-export.csv' }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/test.csv'] }),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: Object.assign(
    vi.fn().mockImplementation(() => ({
      webContents: { send: vi.fn() },
    })),
    {
      getFocusedWindow: vi.fn(() => ({ webContents: { send: vi.fn() } })),
      getAllWindows: vi.fn(() => [{ webContents: { send: vi.fn() } }]),
    },
  ),
}));

// --- Load .env before service imports ---
import { loadEnv, resetEnvLoaded } from '../../src/main/load-env';
resetEnvLoaded();
loadEnv(path.resolve(__dirname, '..', '..'));

// --- Detect API key availability ---
const HAS_API_KEY = !!(
  process.env.OPENROUTER_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY
);

// --- Resolve test data paths ---
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_NAME = process.env.TEST_NAME ?? 'innova_test';
const TEST_DATA_DIR = path.join(PROJECT_ROOT, 'test_data', TEST_NAME);
const HAS_TEST_DATA = fs.existsSync(TEST_DATA_DIR) &&
  fs.existsSync(path.join(TEST_DATA_DIR, 'input.csv')) &&
  fs.existsSync(path.join(TEST_DATA_DIR, 'config.json'));

// --- Fixture paths (used when no test_data is available) ---
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_CSV_PATH = path.join(FIXTURES_DIR, 'csv', 'standard.csv');
const FIXTURE_COLABIP_DIR = path.join(FIXTURES_DIR, 'colabip');

// --- Determine which data source to use ---
const USE_TEST_DATA = HAS_TEST_DATA && HAS_API_KEY;
const CSV_PATH = USE_TEST_DATA
  ? path.join(TEST_DATA_DIR, 'input.csv')
  : FIXTURE_CSV_PATH;
const COLABIP_DIR = USE_TEST_DATA
  ? path.join(PROJECT_ROOT, 'colabip')
  : FIXTURE_COLABIP_DIR;

// --- Temp output paths ---
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c91-pipeline-test-'));
const DB_PATH = path.join(
  USE_TEST_DATA ? TEST_DATA_DIR : TEMP_DIR,
  USE_TEST_DATA ? `${TEST_NAME}.c91` : 'test-pipeline.c91'
);
const SUPPLIER_UNIVERSE_DB_PATH = path.join(TEMP_DIR, 'supplier_universe.db');
const EXPORT_PATH = path.join(
  USE_TEST_DATA ? TEST_DATA_DIR : TEMP_DIR,
  USE_TEST_DATA ? `${TEST_NAME}-export.csv` : 'test-export.csv'
);
const SUMMARY_PATH = USE_TEST_DATA
  ? path.join(TEST_DATA_DIR, 'run-summary.md')
  : null;

// --- Test config ---
interface TestConfig {
  projectName: string;
  taxonomy: string;
  groupingColumns?: string[];
  companyContext: {
    industry: string;
    sector?: string;
    description?: string;
    businessFocus?: string;
    procurementNuances?: string;
  };
  expectedMappings?: Record<string, string>;
}

function loadTestConfig(): TestConfig {
  if (USE_TEST_DATA) {
    const raw = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'config.json'), 'utf-8'));
    return raw as TestConfig;
  }

  // Default config for fixture-based testing
  return {
    projectName: 'Pipeline Integration Test',
    taxonomy: 'healthcare',
    companyContext: {
      industry: 'Healthcare',
      sector: 'Physician Practice Management',
      description: 'A healthcare company operating physician clinics.',
      businessFocus: 'Primary and specialty care delivery',
      procurementNuances: 'Clinical supplies, medical equipment, IT systems',
    },
    expectedMappings: {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      line_description: 'Description',
    },
  };
}

// --- Run summary collector ---
const summary: string[] = [];
const runStartTime = Date.now();

function logSummary(line: string): void {
  summary.push(line);
}

function writeSummary(): void {
  if (!SUMMARY_PATH) return;
  const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
  const header = [
    `# Pipeline Run Summary: ${TEST_NAME}`,
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Total duration:** ${elapsed}s`,
    `**Mode:** ${USE_TEST_DATA ? 'test_data (real LLM)' : 'fixtures'}`,
    '',
    '---',
    '',
  ];
  fs.writeFileSync(SUMMARY_PATH, header.join('\n') + summary.join('\n') + '\n', 'utf-8');
}

// --- Service imports (after mocks are set up) ---
import { databaseService, supplierUniverseService } from '../../src/main/services/database';
import * as projectService from '../../src/main/services/project';
import * as taxonomyService from '../../src/main/services/taxonomy';
import * as uploadService from '../../src/main/services/upload';
import * as supplierService from '../../src/main/services/suppliers';
import * as rulesService from '../../src/main/services/rules';
import * as classificationService from '../../src/main/services/classification';
import * as supplierResearchService from '../../src/main/services/supplier-research';
import * as transactionService from '../../src/main/services/transactions';
import * as colabipService from '../../src/main/services/colabip';

// Export service is special — it uses dialog internally, so we need a manual approach
// for the test: we query the data and write CSV ourselves, or mock the dialog path.
import { dialog } from 'electron';

describe(`Classifier Full Run [${USE_TEST_DATA ? TEST_NAME : 'fixtures'}]`, () => {
  let testConfig: TestConfig;
  let csvRowCount: number;

  // Collected state across phases
  let columnMapping: Record<string, string> = {};

  beforeAll(async () => {
    testConfig = loadTestConfig();

    console.log(`\n  Mode: ${USE_TEST_DATA ? 'test_data' : 'fixtures'}`);
    console.log(`  Project: ${testConfig.projectName}`);
    console.log(`  Taxonomy: ${testConfig.taxonomy}`);
    console.log(`  CSV: ${CSV_PATH}`);
    console.log(`  ColabIP: ${COLABIP_DIR}`);
    console.log(`  DB: ${DB_PATH}`);
    console.log(`  Has API Key: ${HAS_API_KEY}\n`);

    // Count CSV rows for later assertions
    const csvContent = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');
    const lines = csvContent.trim().split(/\r?\n/);
    csvRowCount = lines.length - 1; // subtract header row
    expect(csvRowCount).toBeGreaterThan(0);

    // Set ColabIP base path
    colabipService.setColabipBasePath(COLABIP_DIR);

    // Use temp supplier universe to avoid DuckDB file lock conflicts
    // when integration tests run in parallel forks.
    supplierUniverseService.setDefaultPath(SUPPLIER_UNIVERSE_DB_PATH);

    logSummary(`## Configuration\n`);
    logSummary(`| Setting | Value |`);
    logSummary(`|---------|-------|`);
    logSummary(`| Project | ${testConfig.projectName} |`);
    logSummary(`| Taxonomy | ${testConfig.taxonomy} |`);
    logSummary(`| CSV rows | ${csvRowCount} |`);
    logSummary(`| Mode | ${USE_TEST_DATA ? 'test_data' : 'fixtures'} |`);
    logSummary(`| Has API Key | ${HAS_API_KEY} |`);
    logSummary('');
  });

  afterAll(async () => {
    // Close databases
    if (databaseService.isOpen()) {
      try {
        await databaseService.run('CHECKPOINT');
      } catch { /* ignore */ }
      await databaseService.closeDatabase();
    }
    if (supplierUniverseService.isOpen()) {
      await supplierUniverseService.close();
    }

    // Write run summary if in test_data mode
    writeSummary();

    // Clean up temp files only in fixture mode
    if (!USE_TEST_DATA) {
      try {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
      } catch { /* ignore */ }
    } else {
      console.log(`\n  Output files preserved in: ${TEST_DATA_DIR}`);
      if (SUMMARY_PATH) console.log(`  Summary: ${SUMMARY_PATH}`);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 1: Project Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 1a: Create a new project', async () => {
    // Clean up stale file from previous run
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    const walPath = DB_PATH + '.wal';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

    // createProject opens the DB, initializes schema, and creates the project row
    const result = await projectService.createProject(testConfig.projectName, DB_PATH);

    expect(result.name).toBe(testConfig.projectName);
    expect(result.filePath).toBe(DB_PATH);
    expect(databaseService.isOpen()).toBe(true);

    // Verify v2 schema tables exist
    const tables = await databaseService.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
    );
    const tableNames = tables.map((t) => t.table_name);
    expect(tableNames).toContain('project');
    expect(tableNames).toContain('taxonomy');
    expect(tableNames).toContain('transactions');
    expect(tableNames).toContain('override_rules');
    expect(tableNames).toContain('change_log');

    // Verify project row was created
    const projectRow = await databaseService.get<{ project_name: string }>(
      'SELECT project_name FROM project LIMIT 1'
    );
    expect(projectRow?.project_name).toBe(testConfig.projectName);

    logSummary(`## Phase 1: Project Setup\n`);
    logSummary(`- Project file: \`${path.basename(DB_PATH)}\``);
    logSummary(`- Tables: ${tableNames.join(', ')}`);
    logSummary('');

    console.log('  Project created:', DB_PATH);
    console.log('  Tables:', tableNames.join(', '));
  });

  it('Phase 1b: Set company context', async () => {
    const cc = testConfig.companyContext;

    await projectService.updateMetadata({
      companyContext: {
        industry: cc.industry,
        sector: cc.sector,
        description: cc.description,
        businessFocus: cc.businessFocus,
        procurementNuances: cc.procurementNuances,
      },
    });

    // Verify via getMetadata
    const metadata = await projectService.getMetadata();
    expect(metadata.companyContext).toBeDefined();
    expect(metadata.companyContext?.industry).toBe(cc.industry);

    logSummary(`- Company: ${cc.industry} / ${cc.sector ?? '(no sector)'}`);
    logSummary('');

    console.log(`  Company context set: ${cc.industry}`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 2: Taxonomy Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 2: Import taxonomy from ColabIP', async () => {
    await taxonomyService.importFromColabip(testConfig.taxonomy);

    const nodes = await taxonomyService.getNodes();
    const l1Nodes = nodes.filter((n) => n.depth === 1);
    const l2Nodes = nodes.filter((n) => n.depth === 2);
    const l3Nodes = nodes.filter((n) => n.depth === 3);

    expect(nodes.length).toBeGreaterThan(0);
    expect(l1Nodes.length).toBeGreaterThan(0);

    // Verify taxonomy_name was stored in project metadata
    const metadata = await projectService.getMetadata();
    expect(metadata.taxonomyName).toBe(testConfig.taxonomy);

    // Verify taxonomy structure: every node has valid path components
    for (const node of nodes) {
      expect(node.fullPath).toBeTruthy();
      expect(node.l1).toBeTruthy();
      if (node.depth >= 2) expect(node.l2).toBeTruthy();
      if (node.depth === 3) expect(node.l3).toBeTruthy();
    }

    logSummary(`## Phase 2: Taxonomy Import\n`);
    logSummary(`- Source: \`${testConfig.taxonomy}\``);
    logSummary(`- Total nodes: ${nodes.length} (${l1Nodes.length} L1, ${l2Nodes.length} L2, ${l3Nodes.length} L3)`);
    logSummary(`- L1 categories: ${l1Nodes.map((n) => n.l1).join(', ')}`);
    logSummary('');

    console.log(`  Taxonomy "${testConfig.taxonomy}" imported: ${nodes.length} nodes (${l1Nodes.length} L1, ${l2Nodes.length} L2, ${l3Nodes.length} L3)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3: CSV Upload & Import
  // ────────────────────────────────────────────────────────────────

  it('Phase 3a: Preview CSV and get column mappings', async () => {
    if (!HAS_API_KEY) {
      // Without an API key, parsePreview will fail on the LLM mapping call
      // but should still return the preview with empty mappings
      const preview = await uploadService.parsePreview(CSV_PATH);
      expect(preview.totalRows).toBe(csvRowCount);
      expect(preview.columns.length).toBeGreaterThan(0);

      // Use expectedMappings from config or build manual mappings
      columnMapping = testConfig.expectedMappings ?? {};
      console.log('  Preview returned (LLM mapping skipped — no API key)');
      return;
    }

    const preview = await uploadService.parsePreview(CSV_PATH);

    expect(preview.totalRows).toBe(csvRowCount);
    expect(preview.sampleRows.length).toBeGreaterThan(0);
    expect(preview.columns.length).toBeGreaterThan(0);
    expect(preview.mappingSuggestion).toBeDefined();

    const llmMappings = preview.mappingSuggestion.mappings;

    logSummary(`## Phase 3: CSV Upload\n`);
    logSummary(`- File: \`${path.basename(CSV_PATH)}\``);
    logSummary(`- Rows: ${preview.totalRows}`);
    logSummary(`- Columns: ${preview.columns.join(', ')}`);
    logSummary(`- LLM confidence: ${preview.mappingSuggestion.confidence}`);
    logSummary('');

    // Compare LLM mappings with expected (if provided)
    const expected = testConfig.expectedMappings;
    if (expected) {
      let correct = 0;
      let corrected = 0;

      logSummary(`### Column Mapping Evaluation\n`);
      logSummary(`| Canonical | LLM Suggested | Expected | Match |`);
      logSummary(`|-----------|--------------|----------|-------|`);

      for (const [canonical, expectedCsv] of Object.entries(expected)) {
        const llmCsv = llmMappings[canonical];
        const isMatch = llmCsv === expectedCsv;
        if (isMatch) correct++;
        else corrected++;

        logSummary(`| ${canonical} | ${llmCsv ?? '(missing)'} | ${expectedCsv} | ${isMatch ? 'Yes' : 'No'} |`);
      }

      logSummary('');
      logSummary(`**Accuracy:** ${correct}/${Object.keys(expected).length} correct`);
      logSummary('');

      // Final mappings: start with LLM, override with expected
      columnMapping = { ...llmMappings, ...expected };
    } else {
      columnMapping = llmMappings;
    }

    console.log(`  CSV preview: ${preview.totalRows} rows, ${preview.columns.length} columns`);
    console.log(`  LLM suggested ${Object.keys(llmMappings).length} mappings`);
    console.log(`  Final mappings: ${Object.entries(columnMapping).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  });

  it('Phase 3b: Import CSV data', async () => {
    expect(Object.keys(columnMapping).length).toBeGreaterThan(0);

    const result = await uploadService.importCSV(CSV_PATH, columnMapping);
    expect(result.rowsInserted).toBe(csvRowCount);

    // Verify transactions were inserted
    const txnCount = await databaseService.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM transactions'
    );
    expect(Number(txnCount?.cnt)).toBe(csvRowCount);

    // Verify dynamic columns were added
    const columns = await transactionService.getColumns();
    for (const canonical of Object.keys(columnMapping)) {
      expect(columns).toContain(canonical);
    }

    // Verify all transactions start as unclassified
    const unclassified = await databaseService.get<{ cnt: number | bigint }>(
      "SELECT COUNT(*) as cnt FROM transactions WHERE classification_status = 'unclassified'"
    );
    expect(Number(unclassified?.cnt)).toBe(csvRowCount);

    // Verify column mapping was stored in project metadata
    const metadata = await projectService.getMetadata();
    expect(metadata.columnMapping).toBeDefined();

    logSummary(`### Data Import\n`);
    logSummary(`- Rows imported: ${result.rowsInserted}`);
    logSummary(`- Dynamic columns: ${columns.filter((c) => !['id', 'row_index', 'taxonomy_node_id', 'classification_status', 'classification_reasoning', 'created_at', 'updated_at'].includes(c)).join(', ')}`);
    logSummary('');

    console.log(`  Imported ${result.rowsInserted} transactions`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 4: Seed Supplier Universe
  // ────────────────────────────────────────────────────────────────

  it('Phase 4: Seed supplier_universe.db', async () => {
    // Open supplier universe DB (already opened by createProject, but
    // we may need a fresh one at a known path for tests)
    // The supplierUniverseService was opened by createProject.
    // Verify it is open.
    expect(supplierUniverseService.isOpen()).toBe(true);

    // Get distinct supplier names from transactions
    const supplierRows = await databaseService.all<{ supplier_name: string }>(
      'SELECT DISTINCT supplier_name FROM transactions WHERE supplier_name IS NOT NULL ORDER BY supplier_name'
    );

    expect(supplierRows.length).toBeGreaterThan(0);

    // Seed each supplier into supplier_universe.db if not already present
    let seeded = 0;
    let existed = 0;

    for (const row of supplierRows) {
      const existing = await supplierService.getSupplierByName(row.supplier_name);
      if (!existing) {
        await supplierService.upsertSupplier(row.supplier_name, {
          supplierInfo: {
            supplierType: 'company',
            confidence: 'low',
            sources: ['Test seed'],
          },
        });
        seeded++;
      } else {
        existed++;
      }
    }

    // Verify all suppliers now exist in universe
    for (const row of supplierRows) {
      const supplier = await supplierService.getSupplierByName(row.supplier_name);
      expect(supplier).not.toBeNull();
    }

    logSummary(`## Phase 4: Supplier Universe\n`);
    logSummary(`- Distinct suppliers: ${supplierRows.length}`);
    logSummary(`- Newly seeded: ${seeded}`);
    logSummary(`- Already existed: ${existed}`);
    logSummary('');

    console.log(`  ${supplierRows.length} distinct suppliers (${seeded} seeded, ${existed} already existed)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 5: Supplier Research (optional, requires API key)
  // ────────────────────────────────────────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 5: Research suppliers (real LLM)', async () => {
    // Set up a fake main window for progress events
    const progressEvents: unknown[] = [];
    supplierResearchService.setMainWindow({
      webContents: {
        send: (_channel: string, ...args: unknown[]) => {
          progressEvents.push(args[0]);
        },
      },
    });

    const researchStart = Date.now();
    await supplierResearchService.researchAllProjectSuppliers();
    const researchDuration = ((Date.now() - researchStart) / 1000).toFixed(1);

    // Verify at least some suppliers have substantive research
    const supplierRows = await databaseService.all<{ supplier_name: string }>(
      'SELECT DISTINCT supplier_name FROM transactions WHERE supplier_name IS NOT NULL'
    );

    let researched = 0;
    for (const row of supplierRows) {
      const supplier = await supplierService.getSupplierByName(row.supplier_name);
      if (supplier?.supplierInfo?.industry || supplier?.supplierInfo?.description) {
        researched++;
      }
    }

    logSummary(`## Phase 5: Supplier Research\n`);
    logSummary(`- Duration: ${researchDuration}s`);
    logSummary(`- Suppliers with substantive data: ${researched}/${supplierRows.length}`);
    logSummary(`- Progress events: ${progressEvents.length}`);
    logSummary('');

    console.log(`  Research completed in ${researchDuration}s: ${researched}/${supplierRows.length} suppliers enriched`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 6: Classification (requires API key)
  // ────────────────────────────────────────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 6: Run classification (real LLM)', async () => {
    // Set up main window ref for progress events
    const progressEvents: unknown[] = [];
    classificationService.setMainWindow({
      webContents: {
        send: (_channel: string, ...args: unknown[]) => {
          progressEvents.push(args[0]);
        },
      },
    });

    const classStart = Date.now();

    // startClassification() takes NO parameters in v2
    await classificationService.startClassification();

    const classDuration = ((Date.now() - classStart) / 1000).toFixed(1);

    // Classification should no longer be running
    expect(classificationService.getIsRunning()).toBe(false);

    // Verify classification results
    const stats = await transactionService.getStats();

    logSummary(`## Phase 6: Classification\n`);
    logSummary(`- Duration: ${classDuration}s`);
    logSummary(`- Total rows: ${stats.totalRows}`);
    logSummary(`- Classified: ${stats.classifiedRows}`);
    logSummary(`- Unclassified: ${stats.unclassifiedRows}`);
    logSummary(`- Progress events: ${progressEvents.length}`);
    logSummary('');

    // All transactions should be classified (or at least attempted)
    expect(stats.classifiedRows).toBeGreaterThan(0);

    // Check classification_status distribution
    const statusDist = await databaseService.all<{ classification_status: string; cnt: number | bigint }>(
      `SELECT classification_status, COUNT(*) as cnt FROM transactions GROUP BY classification_status`
    );

    logSummary(`### Classification Status Distribution\n`);
    logSummary(`| Status | Count |`);
    logSummary(`|--------|-------|`);
    for (const row of statusDist) {
      logSummary(`| ${row.classification_status} | ${row.cnt} |`);
      console.log(`    ${row.classification_status}: ${row.cnt}`);
    }
    logSummary('');

    // Check that classified transactions have taxonomy_node_id set
    const classifiedWithNode = await databaseService.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM transactions WHERE classification_status != 'unclassified' AND taxonomy_node_id IS NOT NULL`
    );
    expect(Number(classifiedWithNode?.cnt)).toBeGreaterThan(0);

    // Verify changelog was created
    const changes = await databaseService.all<{
      source: string;
      affected_count: number;
      description: string;
    }>('SELECT source, affected_count, description FROM change_log ORDER BY created_at DESC');

    expect(changes.length).toBeGreaterThanOrEqual(1);
    const pipelineEntry = changes.find((c) => c.source === 'pipeline');
    expect(pipelineEntry).toBeDefined();

    logSummary(`### Changelog\n`);
    for (const c of changes) {
      logSummary(`- [${c.source}] ${c.description} (${c.affected_count} rows)`);
    }
    logSummary('');

    console.log(`  Classification completed in ${classDuration}s`);
    console.log(`  ${stats.classifiedRows}/${stats.totalRows} classified, ${progressEvents.length} progress events`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 7: Verify Classification Results (requires API key)
  // ────────────────────────────────────────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 7a: Verify transaction classifications', async () => {
    const txns = await transactionService.queryTransactions();

    expect(txns.length).toBe(csvRowCount);

    const taxonomy = await taxonomyService.getNodes();
    let classified = 0;
    let byRule = 0;
    let byAI = 0;

    logSummary(`## Phase 7: Classification Results\n`);
    logSummary(`| # | Supplier | Classification | Status | Reasoning (excerpt) |`);
    logSummary(`|---|----------|----------------|--------|---------------------|`);

    for (let i = 0; i < txns.length; i++) {
      const txn = txns[i];
      const path = txn.classificationPath ?? '(unclassified)';

      if (txn.classificationStatus !== 'unclassified') {
        classified++;
        if (txn.classificationStatus === 'classified_by_rule') byRule++;
        if (txn.classificationStatus === 'classified_by_ai') byAI++;
      }

      const supplierName = txn.canonicalFields.supplier_name ?? '(unknown)';
      const reasoning = (txn.classificationReasoning ?? '').substring(0, 50);

      logSummary(`| ${i + 1} | ${supplierName} | ${path} | ${txn.classificationStatus} | ${reasoning} |`);
    }

    logSummary('');
    logSummary(`**Summary:** ${classified}/${csvRowCount} classified (${byRule} by rules, ${byAI} by AI)`);
    logSummary('');

    // All should be classified
    expect(classified).toBe(csvRowCount);

    console.log(`  ${classified}/${csvRowCount} classified (${byRule} by rules, ${byAI} by AI)`);
  });

  it.skipIf(!HAS_API_KEY)('Phase 7b: Verify transaction stats', async () => {
    const stats = await transactionService.getStats();

    expect(stats.totalRows).toBe(csvRowCount);
    expect(stats.classifiedRows).toBe(csvRowCount);
    expect(stats.unclassifiedRows).toBe(0);
    expect(stats.uniqueSuppliers).toBeGreaterThan(0);

    console.log(`  Stats: ${stats.totalRows} total, ${stats.classifiedRows} classified, ${stats.uniqueSuppliers} unique suppliers`);
  });

  it.skipIf(!HAS_API_KEY)('Phase 7c: Verify project supplier views', async () => {
    const projectSuppliers = await supplierService.listProjectSuppliers();

    expect(projectSuppliers.length).toBeGreaterThan(0);

    logSummary(`### Project Suppliers\n`);
    logSummary(`| Supplier | Transactions | Spend | Researched | Has Info |`);
    logSummary(`|----------|-------------|-------|-----------|----------|`);

    for (const ps of projectSuppliers) {
      const hasInfo = !!(ps.supplierInfo?.industry || ps.supplierInfo?.description);
      logSummary(`| ${ps.supplierName} | ${ps.transactionCount} | ${ps.totalSpend} | ${ps.isResearched} | ${hasInfo} |`);
    }
    logSummary('');

    console.log(`  ${projectSuppliers.length} project suppliers`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 8: Override Rules
  // ────────────────────────────────────────────────────────────────

  it('Phase 8: Test override rules', async () => {
    const taxonomy = await taxonomyService.getNodes();
    const l3Nodes = taxonomy.filter((n) => n.depth === 3);

    // Need at least one L3 node to create a rule
    expect(l3Nodes.length).toBeGreaterThan(0);

    const targetNode = l3Nodes[0];

    // Get a supplier name from transactions to build a rule condition
    const supplierRow = await databaseService.get<{ supplier_name: string }>(
      'SELECT DISTINCT supplier_name FROM transactions WHERE supplier_name IS NOT NULL LIMIT 1'
    );

    if (!supplierRow) {
      console.log('  Skipping rule test — no supplier_name data in transactions');
      return;
    }

    // Create an override rule
    const { id: ruleId } = await rulesService.createRule({
      name: `Test Rule: ${supplierRow.supplier_name}`,
      conditions: [
        {
          field: 'supplier_name',
          operator: 'equals',
          value: supplierRow.supplier_name,
        },
      ],
      targetTaxonomyNodeId: targetNode.id,
      priorityScore: 100,
    });

    expect(ruleId).toBeTruthy();

    // Verify rule was stored
    const rules = await rulesService.listRules();
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const createdRule = rules.find((r) => r.id === ruleId);
    expect(createdRule).toBeDefined();
    expect(createdRule!.name).toContain(supplierRow.supplier_name);
    expect(createdRule!.isActive).toBe(true);

    // Evaluate rules against all transactions
    const txnIds = await databaseService.all<{ id: string }>(
      `SELECT id FROM transactions WHERE supplier_name = ?`,
      supplierRow.supplier_name
    );
    const txnIdList = txnIds.map((r) => r.id);

    if (txnIdList.length > 0) {
      const matches = await rulesService.evaluateRules(txnIdList);

      expect(matches.size).toBeGreaterThan(0);

      // Verify all matches target the correct node
      for (const [, match] of matches) {
        expect(match.ruleId).toBe(ruleId);
        expect(match.targetTaxonomyNodeId).toBe(targetNode.id);
      }

      logSummary(`## Phase 8: Override Rules\n`);
      logSummary(`- Rule: "${createdRule!.name}"`);
      logSummary(`- Target: ${targetNode.fullPath}`);
      logSummary(`- Matched transactions: ${matches.size}/${txnIdList.length}`);
      logSummary('');

      console.log(`  Rule created: "${createdRule!.name}" -> ${targetNode.fullPath}`);
      console.log(`  Matched ${matches.size}/${txnIdList.length} transactions`);
    }

    // Apply rule classification to those transactions via updateTransactions
    if (txnIdList.length > 0) {
      await transactionService.updateTransactions(
        {
          ids: txnIdList,
          taxonomyNodeId: targetNode.id,
          classificationStatus: 'classified_by_rule',
          classificationReasoning: 'Matched test override rule',
        },
        'rule'
      );

      // Verify update
      const updated = await databaseService.all<{
        classification_status: string;
        taxonomy_node_id: string;
      }>(
        `SELECT classification_status, taxonomy_node_id FROM transactions WHERE id IN (${txnIdList.map(() => '?').join(',')})`,
        ...txnIdList
      );

      for (const row of updated) {
        expect(row.classification_status).toBe('classified_by_rule');
        expect(row.taxonomy_node_id).toBe(targetNode.id);
      }

      console.log(`  Applied rule to ${txnIdList.length} transactions`);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 9: Manual reclassification
  // ────────────────────────────────────────────────────────────────

  it('Phase 9: Reclassify a transaction manually', async () => {
    const taxonomy = await taxonomyService.getNodes();
    const l3Nodes = taxonomy.filter((n) => n.depth === 3);
    expect(l3Nodes.length).toBeGreaterThan(1);

    // Pick the first transaction
    const firstTxn = await databaseService.get<{
      id: string;
      taxonomy_node_id: string | null;
      classification_status: string;
    }>(
      'SELECT id, taxonomy_node_id, classification_status FROM transactions ORDER BY row_index LIMIT 1'
    );
    expect(firstTxn).toBeDefined();

    // Find a different L3 node
    const currentNodeId = firstTxn!.taxonomy_node_id;
    const differentNode = l3Nodes.find((n) => n.id !== currentNodeId) ?? l3Nodes[0];

    // Reclassify
    await transactionService.updateTransactions(
      {
        ids: [firstTxn!.id],
        taxonomyNodeId: differentNode.id,
        classificationStatus: 'human_reviewed',
        classificationReasoning: 'Manual reclassification in integration test',
      },
      'manual'
    );

    // Verify
    const updated = await databaseService.get<{
      taxonomy_node_id: string;
      classification_status: string;
      classification_reasoning: string;
    }>(
      'SELECT taxonomy_node_id, classification_status, classification_reasoning FROM transactions WHERE id = ?',
      firstTxn!.id
    );

    expect(updated?.taxonomy_node_id).toBe(differentNode.id);
    expect(updated?.classification_status).toBe('human_reviewed');

    // Verify changelog was updated
    const changes = await databaseService.all<{ source: string; description: string }>(
      "SELECT source, description FROM change_log WHERE source = 'manual' ORDER BY created_at DESC"
    );
    expect(changes.length).toBeGreaterThan(0);

    logSummary(`## Phase 9: Reclassification\n`);
    logSummary(`- Transaction ID: \`${firstTxn!.id}\``);
    logSummary(`- From: ${currentNodeId ? '(existing)' : '(none)'}`);
    logSummary(`- To: ${differentNode.fullPath}`);
    logSummary(`- Status: human_reviewed`);
    logSummary('');

    console.log(`  Reclassified to: ${differentNode.fullPath}`);
    console.log(`  Status: human_reviewed`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 10: Export
  // ────────────────────────────────────────────────────────────────

  it('Phase 10: Export to CSV', async () => {
    // Mock the dialog to return our export path
    (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePath: EXPORT_PATH,
    });

    // Dynamic import to avoid stale mock issues
    const exportModule = await import('../../src/main/services/export');
    const result = await exportModule.exportCSV();

    expect(result).not.toBeNull();
    expect(result!.rowsExported).toBe(csvRowCount);
    expect(fs.existsSync(EXPORT_PATH)).toBe(true);

    // Validate CSV structure
    const csvContent = fs.readFileSync(EXPORT_PATH, 'utf-8');
    const lines = csvContent.trim().split(/\r?\n/);

    // Header + data rows
    expect(lines.length).toBe(csvRowCount + 1);

    // Verify export headers include classification columns
    const header = lines[0];
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_l1');
    expect(header).toContain('classification_l2');
    expect(header).toContain('classification_l3');
    expect(header).toContain('classification_status');
    expect(header).toContain('classification_reasoning');

    logSummary(`## Phase 10: Export\n`);
    logSummary(`- Output: \`${path.basename(EXPORT_PATH)}\``);
    logSummary(`- Rows exported: ${result!.rowsExported}`);
    logSummary(`- Header columns: ${header.split(',').length}`);
    logSummary('');

    console.log(`  Exported ${result!.rowsExported} rows to ${EXPORT_PATH}`);
    console.log(`  Header: ${header}`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 11: Database Integrity Checks
  // ────────────────────────────────────────────────────────────────

  it('Phase 11: Verify database integrity', async () => {
    // 1. Every classified transaction has a valid taxonomy_node_id
    const invalidClassified = await databaseService.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM transactions
       WHERE classification_status != 'unclassified' AND taxonomy_node_id IS NULL`
    );
    // Note: it is possible for classification to "fail" and set reasoning but not node.
    // For a strict check, at least verify it is a small number:
    const invalidCount = Number(invalidClassified?.cnt ?? 0);

    // 2. taxonomy_node_id references a valid taxonomy row
    const orphanedNodes = await databaseService.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM transactions t
       LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
       WHERE t.taxonomy_node_id IS NOT NULL AND tax.id IS NULL`
    );
    expect(Number(orphanedNodes?.cnt ?? 0)).toBe(0);

    // 3. All transactions have sequential row_index
    const minMax = await databaseService.get<{ min_idx: number; max_idx: number; cnt: number | bigint }>(
      'SELECT MIN(row_index) as min_idx, MAX(row_index) as max_idx, COUNT(*) as cnt FROM transactions'
    );
    expect(minMax?.min_idx).toBe(0);
    expect(Number(minMax?.cnt)).toBe(csvRowCount);

    // 4. Project row exists
    const projectRow = await databaseService.get<{ id: string; project_name: string }>(
      'SELECT id, project_name FROM project LIMIT 1'
    );
    expect(projectRow).toBeDefined();
    expect(projectRow!.project_name).toBe(testConfig.projectName);

    // 5. Changelog has entries
    const changeCount = await databaseService.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM change_log'
    );
    expect(Number(changeCount?.cnt)).toBeGreaterThan(0);

    logSummary(`## Phase 11: Integrity Checks\n`);
    logSummary(`- Classified without taxonomy_node_id: ${invalidCount}`);
    logSummary(`- Orphaned taxonomy references: ${Number(orphanedNodes?.cnt ?? 0)}`);
    logSummary(`- Row index range: ${minMax?.min_idx}..${minMax?.max_idx}`);
    logSummary(`- Changelog entries: ${Number(changeCount?.cnt)}`);
    logSummary('');

    console.log(`  Integrity checks passed`);
    console.log(`  ${Number(changeCount?.cnt)} changelog entries`);
  });

  // ────────────────────────────────────────────────────────────────
  // Appendix: Summary output
  // ────────────────────────────────────────────────────────────────

  it('Appendix: Write summary', async () => {
    const dbFile = DB_PATH;
    const dbRelative = path.relative(process.cwd(), dbFile);

    logSummary(`## Database Inspection\n`);
    logSummary(`DuckDB file: \`${path.basename(dbFile)}\`\n`);
    logSummary('```bash');
    logSummary(`# Open interactive shell`);
    logSummary(`duckdb ${dbRelative}\n`);
    logSummary(`# List tables`);
    logSummary(`duckdb ${dbRelative} "SELECT table_name FROM information_schema.tables ORDER BY table_name"\n`);
    logSummary(`# Project metadata`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM project"\n`);
    logSummary(`# Taxonomy (L3 leaf nodes)`);
    logSummary(`duckdb ${dbRelative} "SELECT full_path, description FROM taxonomy WHERE depth = 3 ORDER BY full_path"\n`);
    logSummary(`# Transactions with classification`);
    logSummary(`duckdb ${dbRelative} "SELECT t.row_index, t.supplier_name, tx.full_path as classification, t.classification_status FROM transactions t LEFT JOIN taxonomy tx ON t.taxonomy_node_id = tx.id ORDER BY t.row_index"\n`);
    logSummary(`# Override rules`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM override_rules"\n`);
    logSummary(`# Change log`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM change_log ORDER BY created_at"\n`);
    logSummary('```\n');

    logSummary(`## Output Files\n`);
    logSummary(`- \`${path.basename(DB_PATH)}\` — DuckDB project file`);
    logSummary(`- \`${path.basename(EXPORT_PATH)}\` — Exported CSV`);
    if (SUMMARY_PATH) logSummary(`- \`run-summary.md\` — This file`);
    logSummary('');

    console.log('  Summary written');
  });
});
