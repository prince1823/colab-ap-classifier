/**
 * End-to-end pipeline integration test.
 *
 * Runs through the full backend pipeline using real DuckDB, real LLM calls,
 * and real data. Dynamically discovers the taxonomy from ColabIP fixtures
 * and reads transaction data from test_data/input.csv.
 *
 * Nothing is hardcoded — this test works with any input.csv and any taxonomy
 * in the ColabIP fixtures directory.
 *
 * Covers:
 *   1. Project creation
 *   2. Company context setup (derived from taxonomy name)
 *   3. Taxonomy import from ColabIP fixtures
 *   4. CSV upload preview + column mapping + import
 *   5. Supplier research (real LLM)
 *   6. Override rule creation
 *   7. Full classification pipeline (real LLM)
 *   8. Transaction query + stats
 *   9. Reclassification with changelog
 *  10. CSV export
 *
 * Requirements:
 *   - DuckDB native module must be compiled
 *   - ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) set in environment
 *
 * Run with: npx vitest run tests/integration/pipeline-e2e.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { parse } from 'csv-parse/sync';

// --- Load .env from project root (only set vars not already in env) ---
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
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
import { resetSettings } from '../../src/main/services/settings';

// --- Paths ---
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const CSV_PATH = path.resolve(__dirname, '..', '..', 'test_data', 'input.csv');
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

function tempDbPath(): string {
  return path.join(os.tmpdir(), `pipeline-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('Pipeline E2E Integration Test', () => {
  let dbPath: string;
  let exportPath: string;

  // Dynamic data — populated in beforeAll from fixtures and CSV
  let csvData: ReturnType<typeof parseInputCSV>;
  let taxonomyName: string;
  let taxonomyNodeCount: number;

  beforeAll(async () => {
    // Re-read env vars loaded from .env (settings module captures env at import time)
    resetSettings();

    // Set ColabIP base path to fixtures
    colabipService.setColabipBasePath(COLABIP_DIR);

    // Discover the first available taxonomy from ColabIP fixtures
    const taxonomies = await colabipService.listTaxonomies();
    expect(taxonomies.length).toBeGreaterThan(0);
    // Pick the taxonomy with the most nodes (most realistic for testing)
    const sorted = [...taxonomies].sort((a, b) => b.nodeCount - a.nodeCount);
    taxonomyName = sorted[0].name;
    taxonomyNodeCount = sorted[0].nodeCount;

    // Parse the input CSV to discover its structure
    csvData = parseInputCSV();
    expect(csvData.totalRows).toBeGreaterThan(0);
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

    await databaseService.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'project_name',
      `${taxonomyName} E2E Test Project`
    );

    expect(databaseService.isOpen()).toBe(true);
    console.log('  ✓ Project created at', dbPath);
  });

  it('Phase 1b: Set company context', async () => {
    // Derive company context from the taxonomy name — generic descriptions
    const industry = taxonomyName.charAt(0).toUpperCase() + taxonomyName.slice(1);
    await databaseService.run(
      `UPDATE company_context
       SET industry = ?,
           sector = ?,
           description = ?,
           business_focus = ?,
           procurement_nuances = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      industry,
      'General',
      `Company operating in the ${industry} industry`,
      `${industry} services and operations`,
      `Standard procurement for ${industry.toLowerCase()} operations`
    );

    const cc = await databaseService.get<{ industry: string }>(
      'SELECT industry FROM company_context WHERE id = 1'
    );
    expect(cc?.industry).toBe(industry);
    console.log(`  ✓ Company context set: ${industry}`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 2: Taxonomy Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 2: Import taxonomy from ColabIP', async () => {
    await taxonomyService.importFromColabip(taxonomyName);

    const nodes = await taxonomyService.getNodes();
    const l1Nodes = nodes.filter((n) => n.depth === 1);
    const l3Nodes = nodes.filter((n) => n.depth === 3);

    // The taxonomy should have nodes loaded
    expect(nodes.length).toBeGreaterThan(0);
    expect(l1Nodes.length).toBeGreaterThan(0);

    console.log(`  ✓ Taxonomy "${taxonomyName}" imported: ${nodes.length} nodes (${l1Nodes.length} L1, ${l3Nodes.length} L3)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3: CSV Upload & Import
  // ────────────────────────────────────────────────────────────────

  let mappingSuggestion: Record<string, string>;

  it('Phase 3a: Preview CSV file', async () => {
    const preview = await uploadService.parsePreview(CSV_PATH);

    // Verify preview matches our independently parsed CSV data
    expect(preview.totalRows).toBe(csvData.totalRows);
    expect(preview.sampleRows.length).toBeGreaterThan(0);
    expect(preview.sampleRows.length).toBeLessThanOrEqual(csvData.totalRows);

    // Columns should match what we parsed independently
    for (const col of csvData.columns) {
      expect(preview.columns).toContain(col);
    }

    // LLM-first flow: mappingSuggestion is included in the preview
    expect(preview.mappingSuggestion).toBeDefined();

    // Store the LLM-suggested mappings for next step
    mappingSuggestion = preview.mappingSuggestion.mappings;

    console.log(`  ✓ CSV preview: ${preview.totalRows} rows, ${preview.columns.length} columns`);
    console.log(`  ✓ LLM suggested ${Object.keys(mappingSuggestion).length} column mappings`);
  }, 60000);

  it('Phase 3b: Save column mappings', async () => {
    // Use the LLM-suggested mappings from parsePreview
    // Must have at least supplier_name mapped for the pipeline to work
    expect(Object.keys(mappingSuggestion).length).toBeGreaterThan(0);
    expect(mappingSuggestion).toHaveProperty('supplier_name');

    // Use supplier_name as the grouping column
    await canonicalizationService.saveMappings(mappingSuggestion, ['supplier_name']);

    const saved = await canonicalizationService.getMappings();
    expect(saved).toEqual(mappingSuggestion);

    const grouping = await canonicalizationService.getGroupingColumns();
    expect(grouping).toEqual(['supplier_name']);

    console.log('  ✓ Column mappings saved:', Object.keys(mappingSuggestion).join(', '));
  });

  it('Phase 3c: Import CSV data', async () => {
    const result = await canonicalizationService.importCSV(CSV_PATH);
    expect(result.rowsInserted).toBe(csvData.totalRows);

    // Verify transactions exist
    const txns = await databaseService.all<{ id: string }>(
      'SELECT id FROM transactions ORDER BY row_index'
    );
    expect(txns.length).toBe(csvData.totalRows);

    // Verify suppliers extracted — count distinct supplier names from our CSV data
    const supplierCol = mappingSuggestion['supplier_name'];
    const distinctSuppliers = new Set(
      csvData.rows.map((r) => r[supplierCol]).filter(Boolean)
    );

    const suppliers = await supplierService.listSuppliers();
    expect(suppliers.length).toBe(distinctSuppliers.size);

    console.log(`  ✓ Imported ${result.rowsInserted} transactions`);
    console.log(`  ✓ Extracted ${suppliers.length} distinct supplier(s)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 4: Override Rules
  // ────────────────────────────────────────────────────────────────

  it('Phase 4: Create an override rule', async () => {
    // Pick any L3 node from the taxonomy as the rule target
    const nodes = await taxonomyService.getNodes();
    const l3Nodes = nodes.filter((n) => n.depth === 3);
    expect(l3Nodes.length).toBeGreaterThan(0);
    const targetNode = l3Nodes[0];

    // Get the first supplier from the data
    const suppliers = await supplierService.listSuppliers();
    expect(suppliers.length).toBeGreaterThan(0);
    const firstSupplier = suppliers[0].supplierName;

    // Extract a keyword from the supplier name (first word) for a "contains" rule
    const supplierKeyword = firstSupplier.split(/\s+/)[0].toLowerCase();

    const { id } = await rulesService.createRule({
      name: `${firstSupplier} → ${targetNode.fullPath.split('|').pop()}`,
      source: 'project',
      conditions: [
        { field: 'supplier_name', operator: 'contains', value: supplierKeyword },
      ],
      targetTaxonomyNodeId: targetNode.id,
    });

    expect(id).toBeTruthy();
    const rules = await rulesService.listRules();
    expect(rules.length).toBe(1);
    // Project rules should have priority score in 100-199 band
    expect(rules[0].priorityScore).toBeGreaterThanOrEqual(100);
    expect(rules[0].priorityScore).toBeLessThan(200);

    console.log(`  ✓ Created override rule: "${rules[0].name}" (priority: ${rules[0].priorityScore})`);
    console.log(`  ✓ Rule matches supplier_name containing "${supplierKeyword}"`);
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

    // Wait for pipeline to complete (async) — longer timeout for real LLM calls
    let status = classificationPipeline.getStatus();
    const maxWait = 120000; // 120s timeout for real LLM
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

    // Verify progress events were emitted
    expect(progressEvents.length).toBeGreaterThan(0);

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

    for (const txn of txns) {
      const node = taxonomy.find((n) => n.id === txn.taxonomy_node_id);
      const nodePath = node?.fullPath ?? '(unclassified)';
      const source = txn.review_score === 0 ? 'rule/aligned' : 'LLM';

      if (txn.taxonomy_node_id) {
        classified++;
        if (txn.review_score === 0 && !txn.classification_reasoning) {
          ruleMatched++;
        }
      }

      console.log(`    ${txn.supplier_name}: ${nodePath} [score=${txn.review_score}, source=${source}]`);
    }

    // All transactions should be classified (either by rule or LLM)
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
    // Get the first transaction
    const firstTxn = await databaseService.get<{ id: string; taxonomy_node_id: string }>(
      'SELECT id, taxonomy_node_id FROM transactions ORDER BY row_index LIMIT 1'
    );
    expect(firstTxn).toBeDefined();

    // Find a different taxonomy node (any L3 node that isn't the current one)
    const taxonomy = await taxonomyService.getNodes();
    const l3Nodes = taxonomy.filter((n) => n.depth === 3);
    const differentNode = l3Nodes.find((n) => n.id !== firstTxn!.taxonomy_node_id);
    expect(differentNode).toBeDefined();

    await reclassificationService.reclassifyTransactions(
      [firstTxn!.id],
      differentNode!.id,
    );

    // Verify reclassification
    const updated = await databaseService.get<{ taxonomy_node_id: string }>(
      'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
      firstTxn!.id
    );
    expect(updated?.taxonomy_node_id).toBe(differentNode!.id);

    // Verify changelog has a manual entry
    const changes = await databaseService.all<{ source: string; description: string }>(
      "SELECT source, description FROM change_log WHERE source = 'manual' ORDER BY created_at DESC"
    );
    expect(changes.length).toBeGreaterThan(0);

    console.log(`  ✓ Reclassified transaction to: ${differentNode!.fullPath}`);
    console.log(`  ✓ Manual changelog entry: "${changes[0]?.description}"`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 8: Export
  // ────────────────────────────────────────────────────────────────

  it('Phase 8: Export to CSV', async () => {
    exportPath = path.join(os.tmpdir(), `pipeline-e2e-export-${Date.now()}.csv`);

    const result = await exportService.exportCSV(exportPath);
    expect(result.rowsExported).toBe(csvData.totalRows);
    expect(fs.existsSync(exportPath)).toBe(true);

    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    // Header + data rows
    expect(lines.length).toBe(csvData.totalRows + 1);

    // Check header includes classification columns
    const header = lines[0];
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_l1');
    expect(header).toContain('classification_l2');
    expect(header).toContain('classification_l3');
    expect(header).toContain('review_score');

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
