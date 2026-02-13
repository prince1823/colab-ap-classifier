/**
 * Pipeline Full Run — real LLM integration test driven by test_data folders.
 *
 * Runs the full backend pipeline using real DuckDB, real LLM calls, and real
 * data from a test folder. All human-in-the-loop input (company context,
 * taxonomy choice, grouping columns) is read from config.json in the test
 * folder — nothing is hardcoded.
 *
 * Test folder structure (in test_data/<TEST_NAME>/):
 *   input.csv          — transaction data (required)
 *   config.json         — HITL configuration (required)
 *     {
 *       "projectName": "...",
 *       "taxonomy": "healthcare",          // ColabIP taxonomy name
 *       "groupingColumns": ["supplier_name"],
 *       "companyContext": {
 *         "industry": "...",
 *         "sector": "...",
 *         "description": "...",
 *         "businessFocus": "...",
 *         "procurementNuances": "..."
 *       }
 *     }
 *
 * Outputs (saved to test_data/<TEST_NAME>/):
 *   <TEST_NAME>.c91           — DuckDB project file
 *   <TEST_NAME>-export.csv    — Exported classification results
 *   run-summary.md            — Markdown summary of every pipeline step
 *
 * Switch tests by setting TEST_NAME env var:
 *   TEST_NAME=innova_test npx vitest run tests/integration/pipeline-run.test.ts
 *
 * Default: innova_test
 *
 * Requirements:
 *   - DuckDB native module must be compiled
 *   - ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) set in environment
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

// --- Load .env before any service imports ---
import { loadEnv } from '../../src/main/load-env';
loadEnv(path.resolve(__dirname, '..', '..'));

// --- Resolve test folder from TEST_NAME env var ---
const TEST_NAME = process.env.TEST_NAME ?? 'innova_test';
const TEST_DATA_DIR = path.resolve(__dirname, '..', '..', 'test_data', TEST_NAME);
const CSV_PATH = path.join(TEST_DATA_DIR, 'input.csv');
const CONFIG_PATH = path.join(TEST_DATA_DIR, 'config.json');

// --- Output paths in test_data folder ---
const DB_PATH = path.join(TEST_DATA_DIR, `${TEST_NAME}.c91`);
const EXPORT_PATH = path.join(TEST_DATA_DIR, `${TEST_NAME}-export.csv`);
const SUMMARY_PATH = path.join(TEST_DATA_DIR, 'run-summary.md');

// --- Validate test folder exists with required files ---
function validateTestFolder(): void {
  const missing: string[] = [];

  if (!fs.existsSync(TEST_DATA_DIR)) {
    throw new Error(
      `Test folder not found: ${TEST_DATA_DIR}\n` +
      `Set TEST_NAME to a valid folder under test_data/. Available folders:\n` +
      `  ${listAvailableTests().join('\n  ')}`
    );
  }

  if (!fs.existsSync(CSV_PATH)) {
    missing.push('input.csv — transaction CSV data');
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    missing.push(
      'config.json — HITL configuration. Expected format:\n' +
      '  {\n' +
      '    "projectName": "My Test Project",\n' +
      '    "taxonomy": "healthcare",\n' +
      '    "groupingColumns": ["supplier_name"],\n' +
      '    "companyContext": {\n' +
      '      "industry": "...",\n' +
      '      "sector": "...",\n' +
      '      "description": "...",\n' +
      '      "businessFocus": "...",\n' +
      '      "procurementNuances": "..."\n' +
      '    }\n' +
      '  }'
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Test folder "${TEST_NAME}" is missing required files:\n\n` +
      missing.map((m) => `  - ${m}`).join('\n\n') +
      `\n\nTest folder path: ${TEST_DATA_DIR}`
    );
  }
}

function listAvailableTests(): string[] {
  const testDataRoot = path.resolve(__dirname, '..', '..', 'test_data');
  if (!fs.existsSync(testDataRoot)) return [];
  return fs.readdirSync(testDataRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// --- Test config type ---
interface TestConfig {
  projectName: string;
  taxonomy: string;
  groupingColumns: string[];
  companyContext: {
    industry: string;
    sector: string;
    description: string;
    businessFocus: string;
    procurementNuances: string;
  };
}

function loadTestConfig(): TestConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // Validate required fields
  const requiredFields = ['projectName', 'taxonomy', 'groupingColumns', 'companyContext'];
  const missingFields = requiredFields.filter((f) => !(f in raw));
  if (missingFields.length > 0) {
    throw new Error(
      `config.json is missing required fields: ${missingFields.join(', ')}\n` +
      `Path: ${CONFIG_PATH}`
    );
  }

  const ccFields = ['industry', 'sector', 'description', 'businessFocus', 'procurementNuances'];
  const missingCC = ccFields.filter((f) => !(f in raw.companyContext));
  if (missingCC.length > 0) {
    throw new Error(
      `config.json companyContext is missing required fields: ${missingCC.join(', ')}\n` +
      `Path: ${CONFIG_PATH}`
    );
  }

  return raw as TestConfig;
}

// --- Run summary collector ---
const summary: string[] = [];
const runStartTime = Date.now();

function logSummary(line: string): void {
  summary.push(line);
}

function writeSummary(): void {
  const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
  const header = [
    `# Pipeline Run Summary: ${TEST_NAME}`,
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Total duration:** ${elapsed}s`,
    '',
    '---',
    '',
  ];
  fs.writeFileSync(SUMMARY_PATH, header.join('\n') + summary.join('\n') + '\n', 'utf-8');
}

// --- Mock electron only (not LLM) ---
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test.csv' }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/test.csv'] }),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn(),
}));

// --- Imports ---
import { databaseService } from '../../src/main/services/database';
import * as taxonomyService from '../../src/main/services/taxonomy';
import * as canonicalizationService from '../../src/main/services/canonicalization';
import * as uploadService from '../../src/main/services/upload';
import * as supplierService from '../../src/main/services/suppliers';
import * as rulesService from '../../src/main/services/rules';
import * as classificationPipeline from '../../src/main/services/classification-pipeline';
import * as reclassificationService from '../../src/main/services/reclassification';
import * as exportService from '../../src/main/services/export';
import * as colabipService from '../../src/main/services/colabip';
import { resetSettings, getSettings } from '../../src/main/services/settings';

// --- Paths ---
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const COLABIP_DIR = path.join(FIXTURES_DIR, 'colabip');

// --- Dynamically parsed CSV metadata ---
function parseInputCSV(): { columns: string[]; rows: Record<string, string>[]; totalRows: number } {
  const buffer = fs.readFileSync(CSV_PATH);
  const content = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, totalRows: rows.length };
}

describe(`Pipeline Full Run [${TEST_NAME}]`, () => {
  let dbPath: string;
  let exportPath: string;
  let testConfig: TestConfig;

  // Dynamic data — populated in beforeAll from fixtures and CSV
  let csvData: ReturnType<typeof parseInputCSV>;

  beforeAll(async () => {
    // Validate test folder before anything else
    validateTestFolder();
    testConfig = loadTestConfig();

    console.log(`\n  Test: ${TEST_NAME}`);
    console.log(`  Project: ${testConfig.projectName}`);
    console.log(`  Taxonomy: ${testConfig.taxonomy}`);
    console.log(`  Folder: ${TEST_DATA_DIR}\n`);

    // Re-read env vars loaded from .env (settings module captures env at import time)
    resetSettings();

    const settings = getSettings();
    logSummary(`## Configuration\n`);
    logSummary(`| Setting | Value |`);
    logSummary(`|---------|-------|`);
    logSummary(`| Project | ${testConfig.projectName} |`);
    logSummary(`| Taxonomy | ${testConfig.taxonomy} |`);
    logSummary(`| LLM Provider | ${settings.provider} |`);
    logSummary(`| LLM Model | ${settings.model} |`);
    logSummary(`| Industry | ${testConfig.companyContext.industry} |`);
    logSummary(`| Sector | ${testConfig.companyContext.sector} |`);
    logSummary(`| Grouping Columns | ${testConfig.groupingColumns.join(', ')} |`);
    logSummary('');

    // Set ColabIP base path to fixtures
    colabipService.setColabipBasePath(COLABIP_DIR);

    // Verify the requested taxonomy exists in fixtures
    const taxonomies = await colabipService.listTaxonomies();
    const match = taxonomies.find((t) => t.name === testConfig.taxonomy);
    if (!match) {
      throw new Error(
        `Taxonomy "${testConfig.taxonomy}" not found in fixtures.\n` +
        `Available taxonomies: ${taxonomies.map((t) => t.name).join(', ')}\n` +
        `Check config.json in ${TEST_DATA_DIR}`
      );
    }

    // Parse the input CSV to discover its structure
    csvData = parseInputCSV();
    expect(csvData.totalRows).toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (databaseService.isOpen()) {
      // Flush WAL into main .c91 file so it's portable and inspectable
      await databaseService.run('CHECKPOINT');
      await databaseService.closeDatabase();
    }
    // Write run summary to test_data folder
    writeSummary();
    console.log(`\n  Summary written to: ${SUMMARY_PATH}`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 1: Project Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 1a: Create a new project', async () => {
    dbPath = DB_PATH;
    // Remove stale file from previous run so we start fresh
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    await databaseService.openDatabase(dbPath);

    await databaseService.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'project_name',
      testConfig.projectName
    );

    expect(databaseService.isOpen()).toBe(true);

    logSummary(`## Phase 1: Project Setup\n`);
    logSummary(`- Project file: \`${path.basename(dbPath)}\``);
    console.log('  ✓ Project created at', dbPath);
  });

  it('Phase 1b: Set company context from config', async () => {
    const cc = testConfig.companyContext;

    await databaseService.run(
      `UPDATE company_context
       SET industry = ?,
           sector = ?,
           description = ?,
           business_focus = ?,
           procurement_nuances = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      cc.industry,
      cc.sector,
      cc.description,
      cc.businessFocus,
      cc.procurementNuances
    );

    const row = await databaseService.get<{ industry: string }>(
      'SELECT industry FROM company_context WHERE id = 1'
    );
    expect(row?.industry).toBe(cc.industry);

    logSummary(`- Company: ${cc.industry} / ${cc.sector}`);
    logSummary('');
    console.log(`  ✓ Company context set: ${cc.industry} / ${cc.sector}`);
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

    logSummary(`## Phase 2: Taxonomy Import\n`);
    logSummary(`- Source: \`${testConfig.taxonomy}\``);
    logSummary(`- Total nodes: ${nodes.length} (${l1Nodes.length} L1, ${l2Nodes.length} L2, ${l3Nodes.length} L3)`);
    logSummary(`- L1 categories: ${l1Nodes.map((n) => n.l1).join(', ')}`);
    logSummary('');

    console.log(`  ✓ Taxonomy "${testConfig.taxonomy}" imported: ${nodes.length} nodes (${l1Nodes.length} L1, ${l3Nodes.length} L3)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3: CSV Upload & Import
  // ────────────────────────────────────────────────────────────────

  let mappingSuggestion: Record<string, string>;

  it('Phase 3a: Preview CSV file', async () => {
    const preview = await uploadService.parsePreview(CSV_PATH);

    expect(preview.totalRows).toBe(csvData.totalRows);
    expect(preview.sampleRows.length).toBeGreaterThan(0);
    expect(preview.sampleRows.length).toBeLessThanOrEqual(csvData.totalRows);

    for (const col of csvData.columns) {
      expect(preview.columns).toContain(col);
    }

    // LLM-first flow: mappingSuggestion is included in the preview
    expect(preview.mappingSuggestion).toBeDefined();

    mappingSuggestion = preview.mappingSuggestion.mappings;

    logSummary(`## Phase 3: CSV Upload & Canonicalization\n`);
    logSummary(`- Input file: \`input.csv\``);
    logSummary(`- Rows: ${preview.totalRows}`);
    logSummary(`- CSV columns: ${preview.columns.length}`);
    logSummary(`- LLM mapping confidence: ${preview.mappingSuggestion.confidence}`);
    logSummary(`- Mapped columns (${Object.keys(mappingSuggestion).length}):`);
    for (const [canonical, csv] of Object.entries(mappingSuggestion)) {
      logSummary(`  - \`${canonical}\` <- \`${csv}\``);
    }

    console.log(`  ✓ CSV preview: ${preview.totalRows} rows, ${preview.columns.length} columns`);
    console.log(`  ✓ LLM suggested ${Object.keys(mappingSuggestion).length} column mappings`);
  }, 60000);

  it('Phase 3b: Save column mappings', async () => {
    expect(Object.keys(mappingSuggestion).length).toBeGreaterThan(0);
    expect(mappingSuggestion).toHaveProperty('supplier_name');

    await canonicalizationService.saveMappings(mappingSuggestion, testConfig.groupingColumns);

    const saved = await canonicalizationService.getMappings();
    expect(saved).toEqual(mappingSuggestion);

    const grouping = await canonicalizationService.getGroupingColumns();
    expect(grouping).toEqual(testConfig.groupingColumns);

    logSummary(`- Grouping columns: ${testConfig.groupingColumns.join(', ')}`);
    logSummary('');

    console.log('  ✓ Column mappings saved:', Object.keys(mappingSuggestion).join(', '));
    console.log('  ✓ Grouping columns:', testConfig.groupingColumns.join(', '));
  });

  it('Phase 3c: Import CSV data', async () => {
    const result = await canonicalizationService.importCSV(CSV_PATH);
    expect(result.rowsInserted).toBe(csvData.totalRows);

    const txns = await databaseService.all<{ id: string }>(
      'SELECT id FROM transactions ORDER BY row_index'
    );
    expect(txns.length).toBe(csvData.totalRows);

    const supplierCol = mappingSuggestion['supplier_name'];
    const distinctSuppliers = new Set(
      csvData.rows.map((r) => r[supplierCol]).filter(Boolean)
    );

    const suppliers = await supplierService.listSuppliers();
    expect(suppliers.length).toBe(distinctSuppliers.size);

    logSummary(`## Phase 3c: Data Import\n`);
    logSummary(`- Transactions imported: ${result.rowsInserted}`);
    logSummary(`- Distinct suppliers: ${suppliers.length}`);
    logSummary(`- Suppliers: ${suppliers.map((s) => s.supplierName).join(', ')}`);
    logSummary('');

    console.log(`  ✓ Imported ${result.rowsInserted} transactions`);
    console.log(`  ✓ Extracted ${suppliers.length} distinct supplier(s)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 5: Classification Pipeline
  // ────────────────────────────────────────────────────────────────

  it('Phase 5: Run classification pipeline', async () => {
    const progressEvents: unknown[] = [];
    classificationPipeline.setMainWindow({
      webContents: {
        send: (_channel: string, ...args: unknown[]) => {
          progressEvents.push(args[0]);
        },
      },
    });

    const pipelineStart = Date.now();
    const { runId } = await classificationPipeline.startClassification({
      scope: 'all',
    });
    expect(runId).toBeTruthy();

    let status = classificationPipeline.getStatus();
    const maxWait = 120000;
    const startTime = Date.now();

    while (
      status &&
      !['completed', 'failed', 'cancelled'].includes(status.status) &&
      Date.now() - startTime < maxWait
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = classificationPipeline.getStatus();
    }

    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');
    expect(progressEvents.length).toBeGreaterThan(0);

    const pipelineDuration = ((Date.now() - pipelineStart) / 1000).toFixed(1);

    logSummary(`## Phase 5: Classification Pipeline\n`);
    logSummary(`- Status: ${status!.status}`);
    logSummary(`- Duration: ${pipelineDuration}s`);
    logSummary(`- Progress events: ${progressEvents.length}`);
    logSummary('');

    console.log(`  ✓ Pipeline completed in ${Date.now() - startTime}ms`);
    console.log(`  ✓ ${progressEvents.length} progress events emitted`);
  }, 180000);

  // ────────────────────────────────────────────────────────────────
  // Phase 6: Verify Classification Results
  // ────────────────────────────────────────────────────────────────

  it('Phase 6a: Check transaction classifications', async () => {
    const txns = await databaseService.all<{
      id: string;
      supplier_name: string;
      taxonomy_node_id: string | null;
      review_score: number | null;
      classification_reasoning: string | null;
    }>(
      'SELECT id, supplier_name, taxonomy_node_id, review_score, classification_reasoning FROM transactions ORDER BY row_index'
    );

    expect(txns.length).toBe(csvData.totalRows);

    const taxonomy = await taxonomyService.getNodes();

    let classified = 0;
    let ruleMatched = 0;

    logSummary(`## Phase 6: Classification Results\n`);
    logSummary(`| # | Supplier | Classification | Score | Source |`);
    logSummary(`|---|----------|----------------|-------|--------|`);

    for (let i = 0; i < txns.length; i++) {
      const txn = txns[i];
      const node = taxonomy.find((n) => n.id === txn.taxonomy_node_id);
      const nodePath = node?.fullPath ?? '(unclassified)';
      const source = txn.review_score === 0 ? 'rule/aligned' : 'LLM';

      if (txn.taxonomy_node_id) {
        classified++;
        if (txn.review_score === 0 && !txn.classification_reasoning) {
          ruleMatched++;
        }
      }

      logSummary(`| ${i + 1} | ${txn.supplier_name} | ${nodePath} | ${txn.review_score} | ${source} |`);
      console.log(`    ${txn.supplier_name}: ${nodePath} [score=${txn.review_score}, source=${source}]`);
    }

    logSummary('');
    logSummary(`**Summary:** ${classified}/${csvData.totalRows} classified (${ruleMatched} by rules, ${classified - ruleMatched} by LLM)`);
    logSummary('');

    expect(classified).toBe(csvData.totalRows);

    console.log(`  ✓ ${classified}/${csvData.totalRows} transactions classified (${ruleMatched} by rules, ${classified - ruleMatched} by LLM)`);
  });

  it('Phase 6b: Check transaction stats', async () => {
    const stats = await databaseService.get<{
      total: number;
      classified: number;
      flagged: number;
    }>(`
      SELECT
        COUNT(*)::INTEGER as total,
        COUNT(taxonomy_node_id)::INTEGER as classified,
        COUNT(CASE WHEN review_score > 0 THEN 1 END)::INTEGER as flagged
      FROM transactions
    `);

    expect(stats?.total).toBe(csvData.totalRows);
    expect(stats?.classified).toBe(csvData.totalRows);

    console.log(`  ✓ Stats: ${stats?.total} total, ${stats?.classified} classified, ${stats?.flagged} flagged for review`);
  });

  it('Phase 6c: Check changelog was created', async () => {
    const changes = await databaseService.all<{
      id: string;
      source: string;
      affected_count: number;
      description: string;
    }>('SELECT id, source, affected_count, description FROM change_log ORDER BY created_at DESC');

    expect(changes.length).toBeGreaterThanOrEqual(1);
    const pipelineEntry = changes.find((c) => c.source === 'pipeline');
    expect(pipelineEntry).toBeDefined();
    expect(pipelineEntry!.affected_count).toBe(csvData.totalRows);

    console.log(`  ✓ Changelog has ${changes.length} entries`);
    console.log(`    Pipeline entry: "${pipelineEntry?.description}"`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 7: Reclassification
  // ────────────────────────────────────────────────────────────────

  it('Phase 7: Reclassify a transaction', async () => {
    const firstTxn = await databaseService.get<{ id: string; taxonomy_node_id: string }>(
      'SELECT id, taxonomy_node_id FROM transactions ORDER BY row_index LIMIT 1'
    );
    expect(firstTxn).toBeDefined();

    const taxonomy = await taxonomyService.getNodes();
    const l3Nodes = taxonomy.filter((n) => n.depth === 3);
    const originalNode = taxonomy.find((n) => n.id === firstTxn!.taxonomy_node_id);
    const differentNode = l3Nodes.find((n) => n.id !== firstTxn!.taxonomy_node_id);
    expect(differentNode).toBeDefined();

    await reclassificationService.reclassifyTransactions(
      [firstTxn!.id],
      differentNode!.id,
    );

    const updated = await databaseService.get<{ taxonomy_node_id: string }>(
      'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
      firstTxn!.id
    );
    expect(updated?.taxonomy_node_id).toBe(differentNode!.id);

    const changes = await databaseService.all<{ source: string; description: string }>(
      "SELECT source, description FROM change_log WHERE source = 'manual' ORDER BY created_at DESC"
    );
    expect(changes.length).toBeGreaterThan(0);

    logSummary(`## Phase 7: Reclassification\n`);
    logSummary(`- Transaction ID: \`${firstTxn!.id}\``);
    logSummary(`- From: ${originalNode?.fullPath ?? '(unknown)'}`);
    logSummary(`- To: ${differentNode!.fullPath}`);
    logSummary('');

    console.log(`  ✓ Reclassified transaction to: ${differentNode!.fullPath}`);
    console.log(`  ✓ Manual changelog entry: "${changes[0]?.description}"`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 8: Export
  // ────────────────────────────────────────────────────────────────

  it('Phase 8: Export to CSV', async () => {
    exportPath = EXPORT_PATH;

    const result = await exportService.exportCSV(exportPath);
    expect(result.rowsExported).toBe(csvData.totalRows);
    expect(fs.existsSync(exportPath)).toBe(true);

    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    expect(lines.length).toBe(csvData.totalRows + 1);

    const header = lines[0];
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_l1');
    expect(header).toContain('classification_l2');
    expect(header).toContain('classification_l3');
    expect(header).toContain('review_score');

    logSummary(`## Phase 8: Export\n`);
    logSummary(`- Output: \`${path.basename(exportPath)}\``);
    logSummary(`- Rows exported: ${result.rowsExported}`);
    logSummary(`- Columns: ${header.split(',').length}`);
    logSummary('');

    console.log(`  ✓ Exported ${result.rowsExported} rows to CSV`);
    console.log(`  ✓ CSV header: ${header}`);

    for (let i = 1; i < lines.length; i++) {
      console.log(`    Row ${i}: ${lines[i].substring(0, 120)}...`);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 9: Final Supplier State
  // ────────────────────────────────────────────────────────────────

  it('Phase 9: Verify supplier research data persisted', async () => {
    const suppliers = await supplierService.listSuppliers();

    let researched = 0;

    logSummary(`## Phase 9: Supplier Research\n`);
    logSummary(`| Supplier | Type | Industry |`);
    logSummary(`|----------|------|----------|`);

    for (const supplier of suppliers) {
      if (supplier.supplierInfo) {
        researched++;
        logSummary(`| ${supplier.supplierName} | ${supplier.supplierType} | ${supplier.supplierInfo.industry} |`);
        console.log(`    ${supplier.supplierName}: type=${supplier.supplierType}, industry=${supplier.supplierInfo.industry}`);
      } else {
        logSummary(`| ${supplier.supplierName} | ${supplier.supplierType} | (no research) |`);
        console.log(`    ${supplier.supplierName}: (no research data)`);
      }
    }

    logSummary('');
    logSummary(`**Summary:** ${researched}/${suppliers.length} suppliers have research data`);
    logSummary('');

    logSummary('');

    console.log(`  ✓ ${researched}/${suppliers.length} suppliers have research data`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 10: Database Snapshot
  // ────────────────────────────────────────────────────────────────

  it('Phase 10: Write database query commands to summary', async () => {
    const dbFile = DB_PATH;
    const dbRelative = path.relative(process.cwd(), dbFile);

    logSummary(`## Database Inspection\n`);
    logSummary(`The \`${path.basename(dbFile)}\` file is a DuckDB database. Query it with:\n`);
    logSummary('```bash');
    logSummary(`# Open interactive shell`);
    logSummary(`duckdb ${dbRelative}\n`);
    logSummary(`# List all tables`);
    logSummary(`duckdb ${dbRelative} "SELECT table_name FROM information_schema.tables ORDER BY table_name"\n`);
    logSummary(`# Settings`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM settings"\n`);
    logSummary(`# Company context`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM company_context"\n`);
    logSummary(`# Taxonomy (L3 leaf nodes)`);
    logSummary(`duckdb ${dbRelative} "SELECT full_path, description FROM taxonomy WHERE depth = 3 ORDER BY full_path"\n`);
    logSummary(`# Column mappings`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM column_mappings ORDER BY canonical_name"\n`);
    logSummary(`# Transactions with classification`);
    logSummary(`duckdb ${dbRelative} "SELECT row_index, supplier_name, line_description, spend_amount, classification_reasoning, review_score FROM transactions ORDER BY row_index"\n`);
    logSummary(`# Transactions joined with taxonomy path`);
    logSummary(`duckdb ${dbRelative} "SELECT t.row_index, t.supplier_name, tx.full_path as classification, t.review_score FROM transactions t LEFT JOIN taxonomy tx ON t.taxonomy_node_id = tx.id ORDER BY t.row_index"\n`);
    logSummary(`# Supplier research (full JSON)`);
    logSummary(`duckdb ${dbRelative} "SELECT supplier_name, supplier_type, supplier_info FROM project_suppliers ORDER BY supplier_name"\n`);
    logSummary(`# Override rules`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM override_rules"\n`);
    logSummary(`# Change log`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM change_log ORDER BY created_at"\n`);
    logSummary(`# System feedback`);
    logSummary(`duckdb ${dbRelative} "SELECT * FROM system_feedback"\n`);
    logSummary('```\n');

    // --- Output files ---
    logSummary(`## Output Files\n`);
    logSummary(`- \`${path.basename(DB_PATH)}\` — DuckDB project file`);
    logSummary(`- \`${path.basename(EXPORT_PATH)}\` — Exported CSV`);
    logSummary(`- \`run-summary.md\` — This file`);
    logSummary('');

    console.log(`  ✓ Database query commands written to summary`);
  });
});
