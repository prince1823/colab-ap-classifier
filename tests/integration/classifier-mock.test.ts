/**
 * Classifier Mock Pipeline Test — full 11-phase pipeline with mocked LLM.
 *
 * Uses real DuckDB, real DuckDBSupplierUniverse (temp file), and fixture data
 * from tests/fixtures/pipeline/. LLM agents and web search are mocked.
 *
 * Run with: npx vitest run tests/integration/classifier-mock.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.mock('electron', () => {
  const _win = { webContents: { send: () => {} } };
  const BW = Object.assign(vi.fn(() => _win), {
    getFocusedWindow: vi.fn(() => _win),
    getAllWindows: vi.fn(() => [_win]),
  });
  return {
    dialog: {
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [] }),
    },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: BW,
  };
});

import { dialog } from 'electron';
import { DuckDBDatabase } from '../../src/main/services/database';
import { DuckDBSupplierUniverse } from '../../src/main/services/supplier-universe';
import { ChangelogStore } from '../../src/main/services/changelog';
import { TransactionStore } from '../../src/main/services/transactions';
import { ProjectStore } from '../../src/main/services/project';
import { TaxonomyStore } from '../../src/main/services/taxonomy';
import { RuleStore } from '../../src/main/services/rules';
import { IngestService } from '../../src/main/services/ingest';
import { ExportService } from '../../src/main/services/export';
import { ClassificationRunner } from '../../src/main/services/classification';
import { SupplierService } from '../../src/main/services/supplier-service';
import { SupplierResearcher } from '../../src/main/services/supplier-research';
import { eventBus } from '../../src/main/event-bus';
import type { ClassificationAgent, ResearchAgent, WebSearch, ColumnMappingAgent } from '../../src/shared/types/services';
import type { SupplierInfo } from '../../src/shared/types/suppliers';
import { buildDedupGroups } from '../../src/main/utils/dedup-groups';

// ─── Fixture paths ──────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'pipeline');
const FIXTURE_CSV = path.join(FIXTURES_DIR, 'innova-test.csv');
const FIXTURE_CONFIG = path.join(FIXTURES_DIR, 'config.json');
const FIXTURE_TAXONOMY = path.join(FIXTURES_DIR, 'taxonomy.txt');
const FIXTURE_RULES = path.join(FIXTURES_DIR, 'rules.json');
const FIXTURE_MOCK_CLASSIFICATIONS = path.join(FIXTURES_DIR, 'mock-classifications.json');
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

interface MockClassification {
  classificationPath: string;
}

interface SupplierResearchFixture {
  seed: Record<string, SupplierInfo>;
  mock: Record<string, SupplierInfo>;
}

const testConfig: TestConfig = JSON.parse(fs.readFileSync(FIXTURE_CONFIG, 'utf-8'));
const rulesFixture: RuleFixture[] = JSON.parse(fs.readFileSync(FIXTURE_RULES, 'utf-8'));
const mockClassifications: Record<string, MockClassification> = JSON.parse(
  fs.readFileSync(FIXTURE_MOCK_CLASSIFICATIONS, 'utf-8')
);
const supplierResearchFixture: SupplierResearchFixture = JSON.parse(
  fs.readFileSync(FIXTURE_SUPPLIER_RESEARCH, 'utf-8')
);

// ─── Temp path helpers ──────────────────────────────────────────────────────

/** Pre-create a valid empty DuckDB file so DuckDBSupplierUniverse.open() can open it. */
async function supplierUniversePreCreate(dbPath: string): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const inst = await DuckDBInstance.create(dbPath);
  inst.closeSync();
}

function tempPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `classifier-mock-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockClassificationAgentFromFixture(
  db: DuckDBDatabase
): ClassificationAgent {
  const selectCategories = vi.fn().mockImplementation(async (input: any) => {
    const result = new Map<number, string>();
    for (let i = 0; i < input.suppliers.length; i++) {
      const name = input.suppliers[i].name.toLowerCase();
      const match = mockClassifications[name] || mockClassifications['_default'];
      const parts = match.classificationPath.split('|');
      result.set(i + 1, `${parts[0]}|${parts[1]}`);
    }
    return result;
  });

  const classifyL3 = vi.fn().mockImplementation(async (input: any) => {
    // Determine supplier from input
    const supplierName = (input.supplierName || '').toLowerCase();
    const match = mockClassifications[supplierName] || mockClassifications['_default'];

    const { groupCount } = buildDedupGroups(input.transactions, input.columnPriorities ?? []);
    const allGroups = Array.from({ length: groupCount }, (_, i) => i + 1);

    return {
      classifications: [{ id: 1, classificationPath: match.classificationPath }],
      assignments: { '1': allGroups },
    };
  });

  const classifyTransactionGroup = vi.fn().mockImplementation(async (invoiceGroup: any) => {
    const txId = invoiceGroup.transactions?.[0]?.id;
    let supplierKey = '_default';
    if (txId) {
      const row = await db.get<{ original_supplier_name: string }>(
        'SELECT original_supplier_name FROM transactions WHERE id = ?',
        txId
      );
      if (row?.original_supplier_name) {
        supplierKey = row.original_supplier_name.toLowerCase();
      }
    }
    const match = mockClassifications[supplierKey] || mockClassifications['_default'];

    const columnPriorities = invoiceGroup.columnPriorities ?? [];
    const { groupCount } = buildDedupGroups(invoiceGroup.transactions, columnPriorities);
    const allGroups = Array.from({ length: groupCount }, (_, i) => i + 1);

    return {
      classifications: [{ id: 1, classificationPath: match.classificationPath }],
      assignments: { '1': allGroups },
    };
  });

  const selectCategoriesForTailSpend = vi.fn().mockImplementation(async (input: any) => {
    const result = new Map<number, string>();
    for (let i = 0; i < input.suppliers.length; i++) {
      const name = input.suppliers[i].name.toLowerCase();
      const match = mockClassifications[name] || mockClassifications['_default'];
      const parts = match.classificationPath.split('|');
      result.set(i + 1, `${parts[0]}|${parts[1]}`);
    }
    return result;
  });

  const classifyL3ForTailSpend = vi.fn().mockImplementation(async (input: any) => {
    const result = new Map<number, string>();
    for (let i = 0; i < input.suppliers.length; i++) {
      const name = input.suppliers[i].name.toLowerCase();
      const match = mockClassifications[name] || mockClassifications['_default'];
      result.set(i + 1, match.classificationPath);
    }
    return result;
  });

  return { selectCategories, selectCategoriesForTailSpend, classifyL3, classifyL3ForTailSpend, classifyTransactionGroup } as unknown as ClassificationAgent;
}

function createMockResearchAgentFromFixture(): ResearchAgent {
  return {
    researchSupplier: vi.fn().mockImplementation(async (supplierName: string) => {
      const key = supplierName.toLowerCase();
      const mockData = supplierResearchFixture.mock[key];
      if (mockData) return mockData;
      return {
        supplierType: 'company' as const,
        description: `Mock research result for ${supplierName}`,
        industry: 'Unknown',
      };
    }),
  } as unknown as ResearchAgent;
}

function createMockWebSearch(): WebSearch {
  return {
    isAvailable: vi.fn().mockReturnValue(false),
    searchSupplier: vi.fn().mockResolvedValue([]),
  } as unknown as WebSearch;
}

function createMockColumnMappingAgent(): ColumnMappingAgent {
  return {
    suggestMapping: vi.fn().mockResolvedValue({}),
  } as unknown as ColumnMappingAgent;
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('Classifier Mock Pipeline Test', () => {
  let csvRowCount: number;
  let dbPath: string;
  let universePath: string;
  let exportPath: string;

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
    dbPath = tempPath('.c91');
    universePath = tempPath('-universe.db');
    exportPath = tempPath('.csv');

    // Pre-create universe file so DuckDBSupplierUniverse.open() can open it
    await supplierUniversePreCreate(universePath);

    const csvContent = fs.readFileSync(FIXTURE_CSV, 'utf-8').replace(/^\uFEFF/, '');
    csvRowCount = csvContent.trim().split(/\r?\n/).length - 1;

    // Build service graph with real DuckDB + real SupplierUniverse + mocked agents
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
    const webSearch = createMockWebSearch();
    const researchAgent = createMockResearchAgentFromFixture();
    const classificationAgent = createMockClassificationAgentFromFixture(db);
    const columnMappingAgent = createMockColumnMappingAgent();

    changelog = new ChangelogStore(db);
    transactions = new TransactionStore(db, changelog);
    project = new ProjectStore(db, transactions, supplierUniverse);
    taxonomy = new TaxonomyStore(db, project);
    rules = new RuleStore(db, transactions, project);
    suppliers = new SupplierService(db, supplierUniverse);
    ingest = new IngestService(db, transactions, suppliers, columnMappingAgent, eventBus);
    exportSvc = new ExportService(db);
    researcher = new SupplierResearcher(
      supplierUniverse, webSearch, researchAgent, eventBus,
      suppliers, classificationAgent, transactions
    );
    classifier = new ClassificationRunner(
      db, taxonomy, project, rules,
      transactions, changelog, classificationAgent, eventBus, supplierUniverse, suppliers
    );

    console.log(`\n  CSV: ${FIXTURE_CSV} (${csvRowCount} rows)`);
    console.log(`  DB: ${dbPath}`);
    console.log(`  Universe: ${universePath}\n`);
  });

  afterAll(async () => {
    try { await project.closeProject(); } catch { /* already closed */ }
    if (supplierUniverse.isOpen()) {
      await supplierUniverse.close();
    }
    for (const p of [dbPath, universePath, exportPath]) {
      if (!p) continue;
      for (const suffix of ['', '.wal']) {
        const fp = p + suffix;
        if (fs.existsSync(fp)) {
          try { fs.unlinkSync(fp); } catch { /* ignore */ }
        }
      }
    }
  });

  // ─── Phase 1: Create project ────────────────────────────────────────────

  it('Phase 1: Create project and set company context', async () => {
    const result = await project.createProject(testConfig.projectName, dbPath);
    expect(result.name).toBe(testConfig.projectName);
    expect(db.isOpen()).toBe(true);
    expect(supplierUniverse.isOpen()).toBe(true);

    // Seed universe with fixture data
    for (const [name, info] of Object.entries(supplierResearchFixture.seed)) {
      await supplierUniverse.upsertSupplier(name, info);
    }

    // Set company context
    await project.setSetting('company_context', testConfig.companyContext);

    const companyContext = await project.getSetting('company_context') as Record<string, string> | undefined;
    expect(companyContext?.industry).toBe('Healthcare Services');

    // Set column priorities (columns sent to LLM, in classification priority order)
    await project.setSetting('column_priorities', testConfig.columnPriorities);

    console.log('  Project created:', dbPath);
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

    // Verify all transactions have a linked supplier with a name
    const noSupplierName = await db.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM transactions t
       LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
       WHERE ps.supplier_name IS NULL OR ps.supplier_name = ''`
    );
    expect(Number(noSupplierName?.cnt ?? 0)).toBe(0);

    const supplierCount = await db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM project_suppliers'
    );
    console.log(`  Normalized ${Number(supplierCount?.cnt ?? 0)} suppliers, all transactions linked`);
  });

  // ─── Phase 5: Supplier research ─────────────────────────────────────────

  it('Phase 5: Supplier research (seed hits universe, others get researched)', async () => {
    // McKesson was seeded — should already be in universe
    const mckesson = await supplierUniverse.getSupplier('mckesson medical surgical');
    expect(mckesson).not.toBeNull();

    // Research all project suppliers and persist info to project_suppliers
    const projectSuppliers = await suppliers.listProjectSuppliers();
    for (const ps of projectSuppliers) {
      if (ps.isTailSpend) continue;
      const info = await researcher.researchSingle(ps.supplierName);
      await suppliers.updateSupplier(ps.id, { supplierInfo: info, markResearched: true });
    }

    console.log(`  Researched ${projectSuppliers.filter(s => !s.isTailSpend).length} suppliers`);
  });

  // ─── Phase 5b: Populate l1_l2_path for all suppliers ────────────────────

  it('Phase 5b: Populate l1_l2_path via categorize methods', async () => {
    const taxonomyNodes = await taxonomy.getNodes();
    const companyContext = await project.getSetting('company_context') as Record<string, string>;
    const columnPriorities = await project.getSetting('column_priorities') as string[];

    // Categorize non-tail-spend suppliers (those with supplier_info)
    await researcher.categorizeWithSupplierInfo(taxonomyNodes, companyContext);

    // Categorize tail spend suppliers
    if (columnPriorities && columnPriorities.length > 0) {
      await researcher.categorizeTailSpend(taxonomyNodes, companyContext, columnPriorities);
    }

    // Verify l1_l2_path is populated on project_suppliers
    const projectSuppliers = await suppliers.listProjectSuppliers();
    const withPath = projectSuppliers.filter(s => s.l1L2Path !== null);
    console.log(`  Categorized ${withPath.length}/${projectSuppliers.length} suppliers with l1_l2_path`);

    // All non-tail-spend suppliers should have l1_l2_path
    const nonTailSpend = projectSuppliers.filter(s => !s.isTailSpend);
    for (const s of nonTailSpend) {
      expect(s.l1L2Path).not.toBeNull();
    }
  }, 30000);

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

  it('Phase 7: Run classification (mocked LLM)', async () => {
    await classifier.classifyAll();
    expect(classifier.getIsRunning()).toBe(false);

    const stats = await transactions.getStats();
    expect(stats.classifiedRows).toBe(csvRowCount);

    console.log(`  Classified: ${stats.classifiedRows}/${stats.totalRows}`);
  }, 30000);

  // ─── Phase 8: Verify classification results ─────────────────────────────

  it('Phase 8: Verify classification results', async () => {
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

  it('Phase 9: Verify changelog entries', async () => {
    const changes = await changelog.listChanges();
    expect(changes.length).toBeGreaterThan(0);

    const pipelineChanges = changes.filter((c) => c.source === 'pipeline');
    expect(pipelineChanges.length).toBeGreaterThan(0);

    console.log(`  Changelog: ${changes.length} entries (${pipelineChanges.length} from pipeline)`);
  });

  // ─── Phase 10: Export CSV ───────────────────────────────────────────────

  it('Phase 10: Export classified results to CSV', async () => {
    (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePath: exportPath,
    });

    const result = await exportSvc.exportCSV();
    expect(result).not.toBeNull();
    expect(result!.rowsExported).toBe(csvRowCount);
    expect(fs.existsSync(exportPath)).toBe(true);

    // Verify CSV structure
    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    const lines = csvContent.trim().split(/\r?\n/);
    expect(lines.length).toBe(csvRowCount + 1);

    const header = lines[0].toLowerCase();
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_status');

    console.log(`  Exported ${result!.rowsExported} rows to ${exportPath}`);
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
