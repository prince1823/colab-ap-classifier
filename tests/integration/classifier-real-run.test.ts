/**
 * Classifier Real Run — integration test with real LLM calls.
 *
 * Exercises the entire backend classifier end-to-end using real DuckDB,
 * real LLM calls, and fixture data. Only Electron modules are mocked.
 * Phases that require an API key are skipped when no key is available.
 *
 * Run with: npx vitest run tests/integration/classifier-real-run.test.ts
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

// ─── Fixture paths ───────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'pipeline');
const FIXTURE_CSV = path.join(FIXTURES_DIR, 'innova-test.csv');
const FIXTURE_CONFIG = path.join(FIXTURES_DIR, 'config.json');
const FIXTURE_TAXONOMY = path.join(FIXTURES_DIR, 'taxonomy.txt');
const FIXTURE_RULES = path.join(FIXTURES_DIR, 'rules.json');
const FIXTURE_SUPPLIER_RESEARCH = path.join(FIXTURES_DIR, 'supplier-research.json');

// ─── Load fixture data ──────────────────────────────────────────────────────

interface TestConfig {
  projectName: string;
  companyContext: Record<string, string>;
  columnMapping: Record<string, string>;
  columnPriorities: string[];
}

interface RuleFixture {
  name: string;
  conditions: Array<{ field: string; operator: string; value: string }>;
  targetTaxonomyPath: string;
  priorityScore: number;
}

interface SupplierResearchFixture {
  seed: Record<string, import('../../src/shared/types/suppliers').SupplierInfo>;
  mock: Record<string, import('../../src/shared/types/suppliers').SupplierInfo>;
}

const testConfig: TestConfig = JSON.parse(fs.readFileSync(FIXTURE_CONFIG, 'utf-8'));
const rulesFixture: RuleFixture[] = JSON.parse(fs.readFileSync(FIXTURE_RULES, 'utf-8'));
const supplierResearchFixture: SupplierResearchFixture = JSON.parse(
  fs.readFileSync(FIXTURE_SUPPLIER_RESEARCH, 'utf-8')
);

// ─── Service imports ────────────────────────────────────────────────────────

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

// ─── Temp paths ─────────────────────────────────────────────────────────────

/** Pre-create a valid empty DuckDB file so DuckDBSupplierUniverse.open() can open it. */
async function supplierUniversePreCreate(dbPath: string): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const inst = await DuckDBInstance.create(dbPath);
  inst.closeSync();
}

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c91-real-run-'));
const DB_PATH = path.join(TEMP_DIR, 'test-pipeline.c91');
const UNIVERSE_PATH = path.join(TEMP_DIR, 'test-universe.db');
const EXPORT_PATH = path.join(TEMP_DIR, 'test-export.csv');

// ─── Test suite ─────────────────────────────────────────────────────────────

describe(`Classifier Real Run [fixtures, API key: ${HAS_API_KEY}]`, () => {
  let csvRowCount: number;

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
  let researcher: SupplierResearcher;

  beforeAll(async () => {
    const csvContent = fs.readFileSync(FIXTURE_CSV, 'utf-8').replace(/^\uFEFF/, '');
    csvRowCount = csvContent.trim().split(/\r?\n/).length - 1;
    expect(csvRowCount).toBeGreaterThan(0);

    // Pre-create universe file so DuckDBSupplierUniverse.open() can open it
    await supplierUniversePreCreate(UNIVERSE_PATH);

    // Build real service graph
    db = new DuckDBDatabase();
    const mockAppConfig = {
      getApiKey: () => null,
      setApiKey: async () => {},
      getProvider: () => 'openrouter',
      setProvider: async () => {},
      getModel: () => 'claude-3-5-haiku-latest',
      setModel: async () => {},
      getSupplierUniversePath: () => UNIVERSE_PATH,
      setSupplierUniversePath: async () => {},
      clearSupplierUniversePath: async () => {},
    };
    supplierUniverse = new DuckDBSupplierUniverse(mockAppConfig);
    const llm = new OpenRouterLLMClient();
    const webSearch = new ExaWebSearch();
    const classificationAgent = new LLMClassificationAgent(llm);
    const researchAgent = new LLMResearchAgent(llm);
    const columnMappingAgent = new LLMColumnMappingAgent(llm);

    changelog = new ChangelogStore(db);
    transactions = new TransactionStore(db, changelog);
    project = new ProjectStore(db, transactions, supplierUniverse);
    transactions.setProjectStore(project);
    taxonomy = new TaxonomyStore(db, project);
    rules = new RuleStore(db, transactions, project);
    suppliers = new SupplierService(db, supplierUniverse);
    ingest = new IngestService(db, transactions, suppliers, project, columnMappingAgent, eventBus);
    exportSvc = new ExportService(db);
    researcher = new SupplierResearcher(supplierUniverse, webSearch, researchAgent, eventBus, suppliers, classificationAgent, transactions);
    classifier = new ClassificationRunner(
      db, taxonomy, project, rules,
      transactions, changelog, classificationAgent, eventBus, supplierUniverse, suppliers
    );

    console.log(`\n  CSV: ${FIXTURE_CSV} (${csvRowCount} rows)`);
    console.log(`  DB: ${DB_PATH}`);
    console.log(`  Universe: ${UNIVERSE_PATH}`);
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
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── Phase 1: Create project ────────────────────────────────────────────

  it('Phase 1: Create project and set company context', async () => {
    const result = await project.createProject(testConfig.projectName, DB_PATH);
    expect(result.name).toBe(testConfig.projectName);
    expect(db.isOpen()).toBe(true);
    expect(supplierUniverse.isOpen()).toBe(true);

    // Seed universe with fixture data
    for (const [name, info] of Object.entries(supplierResearchFixture.seed)) {
      await supplierUniverse.upsertSupplier(name, info);
    }

    // Set company context
    await project.setSetting('company_context', testConfig.companyContext);

    // Set column priorities (columns sent to LLM, in classification priority order)
    await project.setSetting('column_priorities', testConfig.columnPriorities);

    console.log('  Project created:', DB_PATH);
  });

  // ─── Phase 2: Load taxonomy ─────────────────────────────────────────────

  it('Phase 2: Load taxonomy from fixture', async () => {
    const result = await taxonomy.importFromFile(FIXTURE_TAXONOMY);
    expect(result.nodeCount).toBeGreaterThan(0);

    const nodes = await taxonomy.getNodes();
    const l3Nodes = nodes.filter((n) => n.depth === 3);
    expect(l3Nodes.length).toBeGreaterThan(50);

    console.log(`  Taxonomy: ${result.nodeCount} total nodes, ${l3Nodes.length} L3 nodes`);
  });

  // ─── Phase 3: Import CSV ────────────────────────────────────────────────

  it('Phase 3: Import CSV with column mapping', async () => {
    const result = await ingest.importCSV(FIXTURE_CSV, testConfig.columnMapping);
    expect(result.rowsInserted).toBe(csvRowCount);

    const stats = await transactions.getStats();
    expect(stats.totalRows).toBe(csvRowCount);

    console.log(`  Imported ${result.rowsInserted} transactions`);
  });

  // ─── Phase 4: Verify supplier normalization ─────────────────────────────

  it('Phase 4: Verify supplier normalization', async () => {
    const unlinked = await db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM transactions WHERE project_supplier_id IS NULL'
    );
    expect(Number(unlinked?.cnt ?? 0)).toBe(0);

    const supplierCount = await db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM project_suppliers'
    );
    console.log(`  Normalized ${Number(supplierCount?.cnt ?? 0)} suppliers`);
  });

  // ─── Phase 5: Supplier research ─────────────────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 5: Supplier research (real LLM)', async () => {
    // McKesson was seeded — should already be in universe
    const mckesson = await supplierUniverse.getSupplier('mckesson medical surgical');
    expect(mckesson).not.toBeNull();

    // Research all project suppliers
    const projectSuppliers = await suppliers.listProjectSuppliers();
    for (const ps of projectSuppliers) {
      await researcher.researchSingle(ps.supplierName);
    }

    console.log(`  Researched ${projectSuppliers.length} suppliers`);
  });

  // ─── Phase 5b: Populate l1_l2_path for all suppliers ────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 5b: Populate l1_l2_path via categorize methods', async () => {
    const taxonomyNodes = await taxonomy.getNodes();
    const companyContext = await project.getSetting('company_context') as Record<string, string>;
    const columnPriorities = await project.getSetting('column_priorities') as string[];

    await researcher.categorizeWithSupplierInfo(taxonomyNodes, companyContext);

    if (columnPriorities && columnPriorities.length > 0) {
      await researcher.categorizeTailSpend(taxonomyNodes, companyContext, columnPriorities);
    }

    const projectSuppliers = await suppliers.listProjectSuppliers();
    const withPath = projectSuppliers.filter(s => s.l1L2Path !== null);
    console.log(`  Categorized ${withPath.length}/${projectSuppliers.length} suppliers with l1_l2_path`);
  });

  // ─── Phase 6: Create override rules ─────────────────────────────────────

  it('Phase 6: Create override rules from fixture', async () => {
    const nodes = await taxonomy.getNodes();

    for (const ruleFixture of rulesFixture) {
      const targetNode = nodes.find((n) => n.fullPath === ruleFixture.targetTaxonomyPath);
      expect(targetNode).toBeDefined();

      const { id } = await rules.createRule({
        name: ruleFixture.name,
        groupedConditions: {
          groupConnector: 'AND',
          groups: [{ connector: 'AND', conditions: ruleFixture.conditions }],
        },
        targetTaxonomyNodeId: targetNode!.id,
      });
      expect(id).toBeTruthy();
    }

    const ruleList = await rules.listRulesPaginated({ limit: 100, offset: 0 });
    expect(ruleList.rules.length).toBe(rulesFixture.length);

    console.log(`  Created ${ruleList.rules.length} override rules`);
  });

  // ─── Phase 7: Run classification ────────────────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 7: Run classification (real LLM)', async () => {
    await classifier.classifyAll();
    expect(classifier.getIsRunning()).toBe(false);

    const stats = await transactions.getStats();
    expect(stats.classifiedRows).toBeGreaterThan(0);

    console.log(`  Classified: ${stats.classifiedRows}/${stats.totalRows}`);
  });

  // ─── Phase 8: Verify classification results ─────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 8: Verify classification results', async () => {
    // McKesson transactions should be classified_by_rule
    const ruleClassified = await db.all<{ id: string; classification_status: string }>(
      `SELECT t.id, t.classification_status FROM transactions t
       JOIN project_suppliers ps ON t.project_supplier_id = ps.id
       WHERE LOWER(ps.supplier_name) LIKE '%mckesson%'`
    );
    expect(ruleClassified.length).toBeGreaterThan(0);
    for (const row of ruleClassified) {
      expect(row.classification_status).toBe('classified_by_rule');
    }

    // Other suppliers should be classified_by_ai
    const aiClassified = await db.all<{ id: string; classification_status: string }>(
      `SELECT t.id, t.classification_status FROM transactions t
       JOIN project_suppliers ps ON t.project_supplier_id = ps.id
       WHERE LOWER(ps.supplier_name) NOT LIKE '%mckesson%'`
    );
    expect(aiClassified.length).toBeGreaterThan(0);
    for (const row of aiClassified) {
      expect(row.classification_status).toBe('classified_by_ai');
    }

    console.log(`  Rule-classified: ${ruleClassified.length}, AI-classified: ${aiClassified.length}`);
  });

  // ─── Phase 9: Verify changelog ──────────────────────────────────────────

  it.skipIf(!HAS_API_KEY)('Phase 9: Verify changelog entries', async () => {
    const changes = await changelog.listChanges();
    expect(changes.length).toBeGreaterThan(0);

    const pipelineChanges = changes.filter((c) => c.source === 'pipeline');
    expect(pipelineChanges.length).toBeGreaterThan(0);

    console.log(`  Changelog: ${changes.length} entries (${pipelineChanges.length} from pipeline)`);
  });

  // ─── Phase 10: Export CSV ───────────────────────────────────────────────

  it('Phase 10: Export to CSV', async () => {
    (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePath: EXPORT_PATH,
    });

    const result = await exportSvc.exportCSV();
    expect(result).not.toBeNull();
    expect(result!.rowsExported).toBe(csvRowCount);
    expect(fs.existsSync(EXPORT_PATH)).toBe(true);

    // Verify CSV structure
    const csvContent = fs.readFileSync(EXPORT_PATH, 'utf-8');
    const lines = csvContent.trim().split(/\r?\n/);
    expect(lines.length).toBe(csvRowCount + 1);

    const header = lines[0].toLowerCase();
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_status');

    console.log(`  Exported ${result!.rowsExported} rows to ${EXPORT_PATH}`);
  });

  // ─── Phase 11: Database integrity ───────────────────────────────────────

  it('Phase 11: Database integrity checks', async () => {
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
