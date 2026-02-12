/**
 * Pipeline Mock Test — Integration smoke test with minimal mock data
 *
 * Purpose: Fast integration test that validates the full pipeline flow works
 * correctly without requiring LLM API calls or extensive real data. Uses
 * mocked LLM responses and minimal test data.
 *
 * Goal: Catch integration issues quickly during development (sub-1 minute runtime)
 *
 * Covers:
 *   - Project creation and setup
 *   - Taxonomy import from fixtures
 *   - CSV upload and canonicalization with minimal data
 *   - Classification pipeline with mocked LLM responses
 *   - Results verification
 *   - Export functionality
 *
 * Does NOT cover:
 *   - Real LLM behavior (use pipeline-run.test.ts for that)
 *   - Data quality with real-world complexity
 *   - Performance at scale
 *
 * Run with: npx vitest run tests/integration/pipeline-mock.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// --- Mock electron ---
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test.csv' }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/test.csv'] }),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn(),
}));

// --- Mock LLM client to avoid real API calls ---
// Agents call llmClient.chat(systemPrompt, userPrompt, options)
vi.mock('../../src/main/services/llm-client', () => ({
  chat: vi.fn().mockImplementation(async (systemPrompt: string) => {
    // Mock canonicalization agent
    if (systemPrompt.includes('column mapping')) {
      return JSON.stringify({
        mappings: {
          supplier_name: 'Supplier',
          spend_amount: 'Amount',
          invoice_date: 'Date',
        },
        confidence: 0.95,
      });
    }

    // Mock classification agent — match before research since both mention "supplier"
    if (systemPrompt.includes('AP transaction classifier')) {
      return JSON.stringify({
        classificationPath: 'Direct|IT|Software',
        reasoning: 'Mock classification reasoning',
        confidence: 0.85,
        descriptionSupplierAligned: true,
      });
    }

    // Mock supplier research agent
    if (systemPrompt.includes('supplier research analyst')) {
      return JSON.stringify({
        officialBusinessName: 'Mock Supplier',
        industry: 'Technology',
        description: 'Mock supplier description',
        confidence: 'high',
        sources: [],
      });
    }

    // Default mock response
    return JSON.stringify({ result: 'mock response' });
  }),
  LLMClientError: class LLMClientError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

// --- Imports ---
import { databaseService } from '../../src/main/services/database';
import * as taxonomyService from '../../src/main/services/taxonomy';
import * as canonicalizationService from '../../src/main/services/canonicalization';
import * as uploadService from '../../src/main/services/upload';
import * as supplierService from '../../src/main/services/suppliers';
import * as classificationPipeline from '../../src/main/services/classification-pipeline';
import * as exportService from '../../src/main/services/export';
import * as colabipService from '../../src/main/services/colabip';

// --- Paths ---
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const COLABIP_DIR = path.join(FIXTURES_DIR, 'colabip');
const MOCK_DATA_DIR = path.join(__dirname, '..', 'fixtures', 'mock-data');

// Create mock CSV data for testing
function createMockCSV(): string {
  const csvPath = path.join(os.tmpdir(), `mock-test-${Date.now()}.csv`);
  const content = `Supplier,Amount,Date,Description
Acme Corp,1000.50,2024-01-15,Software licenses
Tech Solutions Inc,2500.00,2024-01-20,Consulting services
Office Depot,150.75,2024-01-22,Office supplies`;

  fs.writeFileSync(csvPath, content, 'utf-8');
  return csvPath;
}

function tempDbPath(): string {
  return path.join(os.tmpdir(), `pipeline-mock-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('Pipeline Mock Integration Test', () => {
  let dbPath: string;
  let csvPath: string;
  let exportPath: string;
  let taxonomyName: string;

  beforeAll(async () => {
    // Set ColabIP base path to fixtures
    colabipService.setColabipBasePath(COLABIP_DIR);

    // Discover the first available taxonomy
    const taxonomies = await colabipService.listTaxonomies();
    expect(taxonomies.length).toBeGreaterThan(0);
    taxonomyName = taxonomies[0].name;

    // Create mock CSV
    csvPath = createMockCSV();
  });

  afterAll(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    // Clean up temp files
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (csvPath && fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    if (exportPath && fs.existsSync(exportPath)) {
      try { fs.unlinkSync(exportPath); } catch { /* ignore */ }
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 1: Project Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 1: Create project and set company context', async () => {
    dbPath = tempDbPath();
    await databaseService.openDatabase(dbPath);

    await databaseService.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'project_name',
      'Mock Integration Test'
    );

    await databaseService.run(
      `UPDATE company_context
       SET industry = ?,
           sector = ?,
           description = ?,
           business_focus = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      'Technology',
      'Software',
      'Mock company for testing',
      'Software development'
    );

    expect(databaseService.isOpen()).toBe(true);
    console.log('  ✓ Mock project created');
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 2: Taxonomy Setup
  // ────────────────────────────────────────────────────────────────

  it('Phase 2: Import taxonomy', async () => {
    await taxonomyService.importFromColabip(taxonomyName);

    const nodes = await taxonomyService.getNodes();
    expect(nodes.length).toBeGreaterThan(0);

    console.log(`  ✓ Taxonomy imported: ${nodes.length} nodes`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3: CSV Upload & Import
  // ────────────────────────────────────────────────────────────────

  it('Phase 3: Preview, map, and import mock CSV', async () => {
    const preview = await uploadService.parsePreview(csvPath);
    expect(preview.totalRows).toBe(3);
    expect(preview.columns).toContain('Supplier');

    // Use simple manual mapping (no LLM)
    const mapping = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
    };

    await canonicalizationService.saveMappings(mapping, ['supplier_name']);
    const result = await canonicalizationService.importCSV(csvPath);

    expect(result.rowsInserted).toBe(3);

    const suppliers = await supplierService.listSuppliers();
    expect(suppliers.length).toBe(3);

    console.log(`  ✓ Imported ${result.rowsInserted} mock transactions`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 4: Classification Pipeline (Mocked)
  // ────────────────────────────────────────────────────────────────

  it('Phase 4: Run classification with mocked LLM', async () => {
    // Set up mock main window
    classificationPipeline.setMainWindow({
      webContents: {
        send: vi.fn(),
      },
    });

    // Start classification (all transactions)
    const { runId } = await classificationPipeline.startClassification({
      scope: 'all',
    });
    expect(runId).toBeTruthy();

    // Wait for completion with shorter timeout (mocked LLM is fast)
    let status = classificationPipeline.getStatus();
    const maxWait = 30000; // 30s timeout
    const startTime = Date.now();

    while (
      status &&
      !['completed', 'failed', 'cancelled'].includes(status.status) &&
      Date.now() - startTime < maxWait
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = classificationPipeline.getStatus();
    }

    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');

    console.log(`  ✓ Mock pipeline completed in ${Date.now() - startTime}ms`);
  }, 40000);

  // ────────────────────────────────────────────────────────────────
  // Phase 5: Verify Results
  // ────────────────────────────────────────────────────────────────

  it('Phase 5: Verify mock classification results', async () => {
    const txns = await databaseService.all<{
      id: string;
      taxonomy_node_id: string | null;
    }>('SELECT id, taxonomy_node_id FROM transactions');

    expect(txns.length).toBe(3);

    // With mocked LLM, all should be "classified" (even if to a mock node)
    const classified = txns.filter((t) => t.taxonomy_node_id !== null);

    console.log(`  ✓ ${classified.length}/${txns.length} transactions classified (mock)`);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 6: Export
  // ────────────────────────────────────────────────────────────────

  it('Phase 6: Export mock results to CSV', async () => {
    exportPath = path.join(os.tmpdir(), `pipeline-mock-export-${Date.now()}.csv`);

    const result = await exportService.exportCSV(exportPath);
    expect(result.rowsExported).toBe(3);
    expect(fs.existsSync(exportPath)).toBe(true);

    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    const lines = csvContent.trim().split('\n');
    expect(lines.length).toBe(4); // Header + 3 data rows

    console.log(`  ✓ Exported ${result.rowsExported} mock rows to CSV`);
  });
});
