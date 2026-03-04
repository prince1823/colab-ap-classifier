/**
 * Classifier Full Run — integration test for the v2 DI architecture.
 *
 * Exercises the entire backend classifier end-to-end using real DuckDB,
 * real LLM calls, and real fixture data. Only Electron modules are mocked.
 *
 * Run with: TEST_NAME=innova_test npx vitest run tests/integration/classifier-real-run.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.setConfig({ testTimeout: 0 });

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

// Load .env before service imports
import { loadEnv, resetEnvLoaded } from '../../src/main/load-env';
resetEnvLoaded();
loadEnv(path.resolve(__dirname, '..', '..'));

const HAS_API_KEY = !!(
  process.env.OPENROUTER_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY
);

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_NAME = process.env.TEST_NAME ?? 'innova_test';
const TEST_DATA_DIR = path.join(PROJECT_ROOT, 'test_data', TEST_NAME);
const HAS_TEST_DATA = fs.existsSync(TEST_DATA_DIR) &&
  fs.existsSync(path.join(TEST_DATA_DIR, 'input.csv')) &&
  fs.existsSync(path.join(TEST_DATA_DIR, 'config.json'));

const FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_CSV_PATH = path.join(FIXTURES_DIR, 'csv', 'standard.csv');

const USE_TEST_DATA = HAS_TEST_DATA && HAS_API_KEY;
const CSV_PATH = USE_TEST_DATA
  ? path.join(TEST_DATA_DIR, 'input.csv')
  : FIXTURE_CSV_PATH;

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c91-pipeline-test-'));
const DB_PATH = path.join(
  USE_TEST_DATA ? TEST_DATA_DIR : TEMP_DIR,
  USE_TEST_DATA ? `${TEST_NAME}.c91` : 'test-pipeline.c91'
);
const EXPORT_PATH = path.join(
  USE_TEST_DATA ? TEST_DATA_DIR : TEMP_DIR,
  USE_TEST_DATA ? `${TEST_NAME}-export.csv` : 'test-export.csv'
);

interface TestConfig {
  projectName: string;
  taxonomy: string;
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
    return JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'config.json'), 'utf-8'));
  }
  return {
    projectName: 'Pipeline Integration Test',
    taxonomy: 'healthcare',
    companyContext: {
      industry: 'Healthcare',
      sector: 'Physician Practice Management',
      description: 'A healthcare company operating physician clinics.',
    },
    expectedMappings: {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      line_description: 'Description',
    },
  };
}

// Service imports — using DI classes
import { dialog } from 'electron';
import { DuckDBDatabase } from '../../src/main/services/database';
import { DuckDBSupplierUniverse } from '../../src/main/services/supplier-universe';
import { eventBus } from '../../src/main/event-bus';
import { OpenRouterLLMClient } from '../../src/main/services/llm-client';
import { ExaWebSearch } from '../../src/main/services/exa-search';
import { LLMClassificationAgent } from '../../src/main/agents/classification-agent';
import { LLMResearchAgent } from '../../src/main/agents/research-agent';
import { LLMColumnMappingAgent } from '../../src/main/agents/column-mapping-agent';
import { ChangelogStore } from '../../src/main/services/changelog';
import { TransactionStore } from '../../src/main/services/transactions';
import { ProjectStore } from '../../src/main/services/project';
import { TaxonomyStore } from '../../src/main/services/taxonomy';
import { RuleStore } from '../../src/main/services/rules';
import { IngestService } from '../../src/main/services/ingest';
import { ExportService } from '../../src/main/services/export';
import { SupplierService } from '../../src/main/services/supplier-service';
import { SupplierResearcher } from '../../src/main/services/supplier-research';
import { ClassificationRunner } from '../../src/main/services/classification';

describe(`Classifier Full Run [${USE_TEST_DATA ? TEST_NAME : 'fixtures'}]`, () => {
  let testConfig: TestConfig;
  let csvRowCount: number;
  let columnMapping: Record<string, string> = {};

  // Service graph
  let db: DuckDBDatabase;
  let supplierUniverse: DuckDBSupplierUniverse;
  let changelog: ChangelogStore;
  let transactions: TransactionStore;
  let project: ProjectStore;
  let taxonomy: TaxonomyStore;
  let rules: RuleStore;
  let suppliers: SupplierService;
  let ingest: IngestService;
  let exportSvc: ExportService;
  let classifier: ClassificationRunner;

  beforeAll(async () => {
    testConfig = loadTestConfig();

    const csvContent = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');
    csvRowCount = csvContent.trim().split(/\r?\n/).length - 1;
    expect(csvRowCount).toBeGreaterThan(0);

    // Build real service graph
    db = new DuckDBDatabase();
    supplierUniverse = new DuckDBSupplierUniverse();
    const llm = new OpenRouterLLMClient();
    const webSearch = new ExaWebSearch();
    const classificationAgent = new LLMClassificationAgent(llm);
    const researchAgent = new LLMResearchAgent(llm);
    const columnMappingAgent = new LLMColumnMappingAgent(llm);

    changelog = new ChangelogStore(db);
    transactions = new TransactionStore(db, changelog);
    project = new ProjectStore(db, transactions, supplierUniverse);
    taxonomy = new TaxonomyStore(db, project);
    rules = new RuleStore(db);
    suppliers = new SupplierService(db, supplierUniverse);
    ingest = new IngestService(db, transactions, columnMappingAgent);
    exportSvc = new ExportService(db);
    classifier = new ClassificationRunner(
      db, taxonomy, project, rules,
      transactions, changelog, classificationAgent, eventBus, supplierUniverse
    );

    console.log(`\n  Mode: ${USE_TEST_DATA ? 'test_data' : 'fixtures'}`);
    console.log(`  CSV: ${CSV_PATH} (${csvRowCount} rows)`);
    console.log(`  DB: ${DB_PATH}`);
    console.log(`  Has API Key: ${HAS_API_KEY}\n`);
  });

  afterAll(async () => {
    if (db.isOpen()) {
      try { await db.run('CHECKPOINT'); } catch { /* ignore */ }
      await db.closeDatabase();
    }
    if (supplierUniverse.isOpen()) {
      await supplierUniverse.close();
    }
    if (!USE_TEST_DATA) {
      try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('Phase 1: Create project', async () => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    const walPath = DB_PATH + '.wal';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

    const result = await project.createProject(testConfig.projectName, DB_PATH);
    expect(result.name).toBe(testConfig.projectName);
    expect(db.isOpen()).toBe(true);

    await project.setSetting('company_context', testConfig.companyContext);

    console.log('  Project created:', DB_PATH);
  });

  it('Phase 2: Add taxonomy nodes (parents first)', async () => {
    // TaxonomyStore.addNode validates parents exist, so add L1 → L2 → L3
    await taxonomy.addNode('Direct');
    await taxonomy.addNode('Direct|IT');
    await taxonomy.addNode('Direct|IT|Software', 'Software licenses');
    await taxonomy.addNode('Direct|IT|Hardware', 'Hardware purchases');
    await taxonomy.addNode('Indirect');
    await taxonomy.addNode('Indirect|Office');
    await taxonomy.addNode('Indirect|Office|Supplies', 'Office supplies');
    await taxonomy.addNode('Indirect|Facilities');
    await taxonomy.addNode('Indirect|Facilities|Cleaning', 'Cleaning services');

    const nodes = await taxonomy.getNodes();
    expect(nodes.length).toBe(9);

    console.log(`  Taxonomy: ${nodes.length} nodes`);
  });

  it('Phase 3: Import CSV data', async () => {
    columnMapping = testConfig.expectedMappings ?? {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      line_description: 'Description',
    };

    const result = await ingest.importCSV(CSV_PATH, columnMapping);
    expect(result.rowsInserted).toBe(csvRowCount);

    const stats = await transactions.getStats();
    expect(stats.totalRows).toBe(csvRowCount);

    console.log(`  Imported ${result.rowsInserted} transactions`);
  });

  it('Phase 3b: Normalize suppliers', async () => {
    // Link transactions to project_suppliers (required for classifier query)
    const supplierRows = await db.all<{ supplier_name: string }>(
      'SELECT DISTINCT supplier_name FROM transactions WHERE supplier_name IS NOT NULL'
    );

    for (const row of supplierRows) {
      const supplierId = await suppliers.normalizeSupplierName(row.supplier_name);
      await db.run(
        'UPDATE transactions SET project_supplier_id = ? WHERE supplier_name = ?',
        supplierId,
        row.supplier_name
      );
    }

    const unlinked = await db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM transactions WHERE project_supplier_id IS NULL'
    );
    expect(Number(unlinked?.cnt ?? 0)).toBe(0);

    console.log(`  Normalized ${supplierRows.length} suppliers`);
  });

  it.skipIf(!HAS_API_KEY)('Phase 4: Run classification (real LLM)', async () => {
    await classifier.classifyAll();
    expect(classifier.getIsRunning()).toBe(false);

    const stats = await transactions.getStats();
    expect(stats.classifiedRows).toBeGreaterThan(0);

    console.log(`  Classified: ${stats.classifiedRows}/${stats.totalRows}`);
  });

  it('Phase 5: Test override rules', async () => {
    const nodes = await taxonomy.getNodes();
    const l3Nodes = nodes.filter((n) => n.depth === 3);
    expect(l3Nodes.length).toBeGreaterThan(0);

    const { id: ruleId } = await rules.createRule({
      name: 'Test Rule',
      conditions: [
        { field: 'supplier_name', operator: 'equals', value: 'Acme Corp' },
      ],
      targetTaxonomyNodeId: l3Nodes[0].id,
      priorityScore: 100,
    });

    expect(ruleId).toBeTruthy();

    const ruleList = await rules.listRules();
    expect(ruleList.find((r) => r.id === ruleId)).toBeDefined();

    console.log(`  Rule created: ${ruleId}`);
  });

  it('Phase 6: Export to CSV', async () => {
    (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePath: EXPORT_PATH,
    });

    const result = await exportSvc.exportCSV();
    expect(result).not.toBeNull();
    expect(result!.rowsExported).toBe(csvRowCount);
    expect(fs.existsSync(EXPORT_PATH)).toBe(true);

    console.log(`  Exported ${result!.rowsExported} rows to ${EXPORT_PATH}`);
  });

  it('Phase 7: Database integrity', async () => {
    const orphanedNodes = await db.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM transactions t
       LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
       WHERE t.taxonomy_node_id IS NOT NULL AND tax.id IS NULL`
    );
    expect(Number(orphanedNodes?.cnt ?? 0)).toBe(0);

    const minMax = await db.get<{ min_idx: number; cnt: number | bigint }>(
      'SELECT MIN(row_index) as min_idx, COUNT(*) as cnt FROM transactions'
    );
    expect(minMax?.min_idx).toBe(0);
    expect(Number(minMax?.cnt)).toBe(csvRowCount);

    console.log('  Integrity checks passed');
  });
});
