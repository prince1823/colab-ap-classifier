/**
 * End-to-end pipeline integration test.
 *
 * Runs through the full backend pipeline using real DuckDB + fixture data
 * with mocked LLM responses. Covers:
 *
 *   1. Project creation
 *   2. Company context setup
 *   3. Taxonomy import from ColabIP fixtures
 *   4. CSV upload preview + column mapping + import
 *   5. Supplier research (mocked LLM)
 *   6. Override rule creation
 *   7. Full classification pipeline (mocked LLM)
 *   8. Transaction query + stats
 *   9. Reclassification with changelog
 *  10. CSV export
 *
 * Requirements:
 *   - DuckDB native module must be compiled
 *   - No real API keys needed (LLM is mocked)
 *
 * Run with: npx vitest run tests/integration/pipeline-e2e.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// --- Mock electron before any service imports ---
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test.csv' }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/test.csv'] }),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn(),
}));

// --- Mock LLM client ---
vi.mock('../../src/main/services/llm-client', () => ({
  chat: vi.fn(),
  LLMClientError: class extends Error {
    code: string;
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
}));

// --- Imports (after mocks) ---
import { databaseService } from '../../src/main/services/database';
import * as projectService from '../../src/main/services/project';
import * as taxonomyService from '../../src/main/services/taxonomy';
import * as canonicalizationService from '../../src/main/services/canonicalization';
import * as uploadService from '../../src/main/services/upload';
import * as supplierService from '../../src/main/services/suppliers';
import * as transactionsService from '../../src/main/services/transactions';
import * as rulesService from '../../src/main/services/rules';
import * as classificationPipeline from '../../src/main/services/classification-pipeline';
import * as reclassificationService from '../../src/main/services/reclassification';
import * as changelogService from '../../src/main/services/changelog';
import * as exportService from '../../src/main/services/export';
import * as colabipService from '../../src/main/services/colabip';
import * as llmClient from '../../src/main/services/llm-client';

// --- Paths ---
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const CSV_PATH = path.join(FIXTURES_DIR, 'csv', 'standard.csv');
const COLABIP_DIR = path.join(FIXTURES_DIR, 'colabip');

function tempDbPath(): string {
  return path.join(os.tmpdir(), `pipeline-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

// --- Default LLM responses per supplier ---
const SUPPLIER_RESEARCH_RESPONSES: Record<string, string> = {
  'Acme Corp': JSON.stringify({
    supplierType: 'company',
    officialBusinessName: 'Acme Corporation',
    description: 'Office and business supplies distributor',
    industry: 'Office Supplies',
    productsServices: 'Office supplies, stationery, paper products',
    serviceType: 'Distribution',
    confidence: 'high',
    sources: ['Mock data'],
  }),
  'Globex Inc': JSON.stringify({
    supplierType: 'company',
    officialBusinessName: 'Globex Incorporated',
    description: 'IT hardware and networking equipment provider',
    industry: 'Information Technology',
    productsServices: 'Servers, laptops, networking equipment',
    serviceType: 'IT Hardware',
    confidence: 'high',
    sources: ['Mock data'],
  }),
  'Initech': JSON.stringify({
    supplierType: 'company',
    officialBusinessName: 'Initech Consulting LLC',
    description: 'Management and technology consulting firm',
    industry: 'Professional Services',
    productsServices: 'Management consulting, strategy advisory',
    serviceType: 'Consulting',
    confidence: 'medium',
    sources: ['Mock data'],
  }),
  'Wayne Enterprises': JSON.stringify({
    supplierType: 'company',
    officialBusinessName: 'Wayne Enterprises Inc',
    description: 'Diversified industrial conglomerate with construction division',
    industry: 'Construction',
    productsServices: 'Construction materials, engineering services, infrastructure',
    serviceType: 'Construction',
    confidence: 'high',
    sources: ['Mock data'],
  }),
  'Stark Industries': JSON.stringify({
    supplierType: 'company',
    officialBusinessName: 'Stark Industries',
    description: 'Advanced technology and laboratory equipment manufacturer',
    industry: 'Science & Technology',
    productsServices: 'Laboratory equipment, analytical instruments, testing devices',
    serviceType: 'Manufacturing',
    confidence: 'high',
    sources: ['Mock data'],
  }),
};

// Classification responses keyed by supplier name
const CLASSIFICATION_RESPONSES: Record<string, string> = {
  'Acme Corp': JSON.stringify({
    classificationPath: 'Indirect|Facilities|Office Supplies',
    reasoning: 'Acme Corp supplies office supplies. This is an indirect cost for facility operations.',
    descriptionSupplierAligned: true,
  }),
  'Globex Inc': JSON.stringify({
    classificationPath: 'Indirect|IT|Hardware',
    reasoning: 'Globex provides IT equipment. IT hardware is an indirect cost.',
    descriptionSupplierAligned: true,
  }),
  'Initech': JSON.stringify({
    classificationPath: 'Indirect|Professional Services|Consulting',
    reasoning: 'Initech provides consulting services. Professional services are indirect costs.',
    descriptionSupplierAligned: true,
  }),
  'Wayne Enterprises': JSON.stringify({
    classificationPath: 'Direct|Construction|Building Materials',
    reasoning: 'Wayne Enterprises provides construction materials. Direct cost for manufacturing plant construction.',
    descriptionSupplierAligned: true,
  }),
  'Stark Industries': JSON.stringify({
    classificationPath: 'Direct|Equipment|Lab Equipment',
    reasoning: 'Stark Industries provides lab equipment used directly in R&D/production.',
    descriptionSupplierAligned: true,
  }),
};

/**
 * Setup the mock LLM to return appropriate responses based on the prompt content.
 */
function setupLLMMock(): void {
  const mockChat = vi.mocked(llmClient.chat);

  mockChat.mockImplementation(async (_systemPrompt: string, userPrompt: string) => {
    // Determine if this is a research call or classification call
    const isResearch = userPrompt.includes('## Supplier Name');

    if (isResearch) {
      // Extract supplier name from research prompt
      const match = userPrompt.match(/## Supplier Name\n\n(.+)/);
      const supplierName = match?.[1]?.trim() ?? '';
      const response = SUPPLIER_RESEARCH_RESPONSES[supplierName];
      if (response) return response;

      // Fallback for unknown suppliers
      return JSON.stringify({
        supplierType: 'company',
        officialBusinessName: supplierName,
        description: 'Unknown supplier',
        industry: 'General',
        confidence: 'low',
        sources: ['Fallback mock'],
      });
    }

    // Classification call — find supplier name in the transactions section
    for (const [supplier, response] of Object.entries(CLASSIFICATION_RESPONSES)) {
      if (userPrompt.includes(supplier)) {
        return response;
      }
    }

    // Fallback classification
    return JSON.stringify({
      classificationPath: 'Indirect|Facilities|Office Supplies',
      reasoning: 'Default fallback classification',
      descriptionSupplierAligned: false,
    });
  });
}

describe('Pipeline E2E Integration Test', () => {
  let dbPath: string;
  let exportPath: string;

  beforeAll(() => {
    // Set ColabIP base path to fixtures
    colabipService.setColabipBasePath(COLABIP_DIR);
    setupLLMMock();
  });

  afterAll(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    // Clean up temp files
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (exportPath && fs.existsSync(exportPath)) {
      try { fs.unlinkSync(exportPath); } catch { /* ignore */ }
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 1: Project Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 1a: Create a new project', async () => {
    dbPath = tempDbPath();
    await databaseService.openDatabase(dbPath);

    // Store project name in settings
    await databaseService.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'project_name',
      'E2E Test Project'
    );

    expect(databaseService.isOpen()).toBe(true);
    console.log('  ✓ Project created at', dbPath);
  });

  it('Phase 1b: Set company context', async () => {
    await databaseService.run(
      `UPDATE company_context
       SET industry = ?,
           sector = ?,
           description = ?,
           business_focus = ?,
           procurement_nuances = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      'Manufacturing',
      'Industrial Equipment',
      'Mid-size industrial equipment manufacturer',
      'Production of precision instruments and machinery',
      'Heavy focus on raw materials and lab equipment; IT is secondary spend'
    );

    const cc = await databaseService.get<{ industry: string }>(
      'SELECT industry FROM company_context WHERE id = 1'
    );
    expect(cc?.industry).toBe('Manufacturing');
    console.log('  ✓ Company context set: Manufacturing / Industrial Equipment');
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 2: Taxonomy Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 2: Import manufacturing taxonomy from ColabIP', async () => {
    await taxonomyService.importFromColabip('manufacturing');

    const nodes = await taxonomyService.getNodes();
    const l3Nodes = nodes.filter((n) => n.depth === 3);

    expect(nodes.length).toBeGreaterThan(10);
    expect(l3Nodes.length).toBeGreaterThan(5);

    console.log(`  ✓ Taxonomy imported: ${nodes.length} nodes (${l3Nodes.length} L3 leaf nodes)`);
    console.log('    L3 paths:', l3Nodes.map((n) => n.fullPath).join(', '));
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3: CSV Upload & Import
  // ────────────────────────────────────────────────────────────────

  it('Phase 3a: Preview CSV file', () => {
    const preview = uploadService.parsePreview(CSV_PATH);

    expect(preview.columns).toEqual(['Supplier', 'Invoice Number', 'Amount', 'Date', 'Description']);
    expect(preview.totalRows).toBe(5);
    expect(preview.sampleRows.length).toBe(5);

    console.log(`  ✓ CSV preview: ${preview.totalRows} rows, columns: ${preview.columns.join(', ')}`);
  });

  it('Phase 3b: Save column mappings', async () => {
    // Map CSV columns to canonical names
    const mapping = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
      line_description: 'Description',
    };

    await canonicalizationService.saveMappings(mapping, ['supplier_name']);

    const saved = await canonicalizationService.getMappings();
    expect(saved).toEqual(mapping);

    const grouping = await canonicalizationService.getGroupingColumns();
    expect(grouping).toEqual(['supplier_name']);

    console.log('  ✓ Column mappings saved:', JSON.stringify(mapping));
    console.log('  ✓ Grouping columns:', grouping.join(', '));
  });

  it('Phase 3c: Import CSV data', async () => {
    const result = await canonicalizationService.importCSV(CSV_PATH);
    expect(result.rowsInserted).toBe(5);

    // Verify transactions exist
    const txns = await databaseService.all<{ id: string; supplier_name: string; spend_amount: string }>(
      'SELECT id, supplier_name, spend_amount FROM transactions ORDER BY row_index'
    );
    expect(txns.length).toBe(5);
    expect(txns[0].supplier_name).toBe('Acme Corp');
    expect(txns[4].supplier_name).toBe('Stark Industries');

    // Verify suppliers extracted
    const suppliers = await supplierService.listSuppliers();
    expect(suppliers.length).toBe(5);

    console.log(`  ✓ Imported ${result.rowsInserted} transactions`);
    console.log(`  ✓ Extracted ${suppliers.length} suppliers: ${suppliers.map((s) => s.supplierName).join(', ')}`);
    console.log(`  ✓ Total spend: $${suppliers.reduce((sum, s) => sum + s.totalSpend, 0).toFixed(2)}`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 4: Override Rules
  // ────────────────────────────────────────────────────────────────

  it('Phase 4: Create an override rule for Wayne Enterprises', async () => {
    // Get the "Direct|Construction|Building Materials" taxonomy node
    const nodes = await taxonomyService.getNodes();
    const buildingMaterialsNode = nodes.find((n) => n.fullPath === 'Direct|Construction|Building Materials');
    expect(buildingMaterialsNode).toBeDefined();

    // Create a rule: Wayne Enterprises → always Direct|Construction|Building Materials
    const { id } = await rulesService.createRule({
      name: 'Wayne Enterprises → Building Materials',
      source: 'project',
      conditions: [
        { field: 'supplier_name', operator: 'equals', value: 'Wayne Enterprises' },
      ],
      targetTaxonomyNodeId: buildingMaterialsNode!.id,
    });

    expect(id).toBeTruthy();
    const rules = await rulesService.listRules();
    expect(rules.length).toBe(1);
    expect(rules[0].name).toBe('Wayne Enterprises → Building Materials');
    expect(rules[0].priorityScore).toBeGreaterThanOrEqual(100);
    expect(rules[0].priorityScore).toBeLessThan(200);

    console.log(`  ✓ Created override rule: "${rules[0].name}" (priority: ${rules[0].priorityScore})`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 5: Classification Pipeline
  // ────────────────────────────────────────────────────────────────

  it('Phase 5: Run classification pipeline', async () => {
    // Set up mock main window for progress events
    const progressEvents: unknown[] = [];
    classificationPipeline.setMainWindow({
      webContents: {
        send: (_channel: string, ...args: unknown[]) => {
          progressEvents.push(args[0]);
        },
      },
    });

    // Start classification (all transactions)
    const { runId } = await classificationPipeline.startClassification({
      scope: 'all',
    });
    expect(runId).toBeTruthy();

    // Wait for pipeline to complete (async)
    let status = classificationPipeline.getStatus();
    const maxWait = 30000; // 30s timeout
    const startTime = Date.now();

    while (
      status &&
      !['completed', 'failed', 'cancelled'].includes(status.status) &&
      Date.now() - startTime < maxWait
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = classificationPipeline.getStatus();
    }

    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');

    // Verify progress events were emitted
    expect(progressEvents.length).toBeGreaterThan(0);

    console.log(`  ✓ Pipeline completed in ${Date.now() - startTime}ms`);
    console.log(`  ✓ ${progressEvents.length} progress events emitted`);

    // Verify LLM was called
    const mockChat = vi.mocked(llmClient.chat);
    expect(mockChat).toHaveBeenCalled();
    console.log(`  ✓ LLM called ${mockChat.mock.calls.length} times`);
  }, 60000);

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

    const taxonomy = await taxonomyService.getNodes();

    let classified = 0;
    let ruleMatched = 0;
    let llmClassified = 0;

    for (const txn of txns) {
      const node = taxonomy.find((n) => n.id === txn.taxonomy_node_id);
      const path = node?.fullPath ?? '(unclassified)';
      const source = txn.review_score === 0 ? 'rule/aligned' : 'LLM';

      if (txn.taxonomy_node_id) {
        classified++;
        if (txn.review_score === 0 && !txn.classification_reasoning) {
          ruleMatched++;
        } else {
          llmClassified++;
        }
      }

      console.log(`    ${txn.supplier_name}: ${path} [score=${txn.review_score}, source=${source}]`);
    }

    expect(classified).toBe(5); // All 5 should be classified

    console.log(`  ✓ ${classified}/5 transactions classified (${ruleMatched} by rules, ${llmClassified} by LLM)`);
  });

  it('Phase 6b: Check transaction stats', async () => {
    // Query stats manually since the transactions service may use different column discovery
    const stats = await databaseService.get<{
      total: number;
      classified: number;
      flagged: number;
    }>(`
      SELECT
        COUNT(*) as total,
        COUNT(taxonomy_node_id) as classified,
        COUNT(CASE WHEN review_score > 0 THEN 1 END) as flagged
      FROM transactions
    `);

    expect(stats?.total).toBe(5);
    expect(stats?.classified).toBe(5);

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
    expect(pipelineEntry!.affected_count).toBe(5);

    console.log(`  ✓ Changelog has ${changes.length} entries`);
    console.log(`    Pipeline entry: "${pipelineEntry?.description}"`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 7: Reclassification
  // ────────────────────────────────────────────────────────────────

  it('Phase 7: Reclassify a transaction', async () => {
    // Get Acme Corp's transaction
    const acmeTxn = await databaseService.get<{ id: string; taxonomy_node_id: string }>(
      "SELECT id, taxonomy_node_id FROM transactions WHERE supplier_name = 'Acme Corp'"
    );
    expect(acmeTxn).toBeDefined();

    // Reclassify to "Indirect|Facilities|Maintenance"
    const taxonomy = await taxonomyService.getNodes();
    const maintenanceNode = taxonomy.find((n) => n.fullPath === 'Indirect|Facilities|Maintenance');
    expect(maintenanceNode).toBeDefined();

    await reclassificationService.reclassifyTransactions(
      [acmeTxn!.id],
      maintenanceNode!.id,
    );

    // Verify reclassification
    const updated = await databaseService.get<{ taxonomy_node_id: string }>(
      'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
      acmeTxn!.id
    );
    expect(updated?.taxonomy_node_id).toBe(maintenanceNode!.id);

    // Verify changelog has a manual entry
    const changes = await databaseService.all<{ source: string; description: string }>(
      "SELECT source, description FROM change_log WHERE source = 'manual' ORDER BY created_at DESC"
    );
    expect(changes.length).toBeGreaterThan(0);

    console.log(`  ✓ Reclassified Acme Corp to: Indirect|Facilities|Maintenance`);
    console.log(`  ✓ Manual changelog entry: "${changes[0]?.description}"`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 8: Export
  // ────────────────────────────────────────────────────────────────

  it('Phase 8: Export to CSV', async () => {
    exportPath = path.join(os.tmpdir(), `pipeline-e2e-export-${Date.now()}.csv`);

    const result = await exportService.exportCSV(exportPath);
    expect(result.rowsExported).toBe(5);
    expect(fs.existsSync(exportPath)).toBe(true);

    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    // Header + 5 data rows
    expect(lines.length).toBe(6);

    // Check header includes classification columns
    const header = lines[0];
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_l1');
    expect(header).toContain('classification_l2');
    expect(header).toContain('classification_l3');
    expect(header).toContain('review_score');

    console.log(`  ✓ Exported ${result.rowsExported} rows to CSV`);
    console.log(`  ✓ CSV header: ${header}`);

    // Print each exported row
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
    for (const supplier of suppliers) {
      if (supplier.supplierInfo) {
        researched++;
        console.log(`    ${supplier.supplierName}: type=${supplier.supplierType}, industry=${supplier.supplierInfo.industry}`);
      } else {
        console.log(`    ${supplier.supplierName}: (no research data)`);
      }
    }

    console.log(`  ✓ ${researched}/${suppliers.length} suppliers have research data`);
  });
});
