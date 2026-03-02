/**
 * Classifier Mock Test — v2 integration smoke test with mocked LLM
 *
 * Purpose: Validates the full v2 classification flow works correctly without
 * requiring LLM API calls. Uses mocked LLM responses and minimal test data.
 *
 * Covers:
 *   - Project creation via createProject() + company context via updateMetadata()
 *   - Taxonomy import from ColabIP fixtures
 *   - CSV upload with column mapping via importCSV()
 *   - Supplier universe seeding (real DuckDB)
 *   - Classification with mocked LLM (startClassification)
 *   - Results verification (classification_status != 'unclassified')
 *   - Export functionality (exportCSV)
 *
 * v2 schema: 5 tables (project, taxonomy, transactions, override_rules, change_log)
 *
 * Run with: npx vitest run tests/integration/classifier-mock.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// vi.hoisted runs before vi.mock hoisting — safe for shared refs
const { mockSend, exportState } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  exportState: { filePath: null as string | null },
}));

// --- Mock electron ---
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

// --- Mock LLM client ---
vi.mock('../../src/main/services/llm-client', () => ({
  chat: vi.fn().mockImplementation(async (systemPrompt: string) => {
    // Mock column-mapping agent
    if (systemPrompt.includes('data mapping assistant')) {
      return JSON.stringify({
        mappings: {
          supplier_name: 'Supplier',
          spend_amount: 'Amount',
          invoice_date: 'Date',
          line_description: 'Description',
        },
        confidence: 'high',
        unmappedClientColumns: ['Invoice Number'],
        importantUnmappedColumns: [],
        unmappedCanonicalColumns: [],
        reasoning: 'Mock mapping',
      });
    }
    // Mock classification agent
    if (systemPrompt.includes('AP transaction classifier')) {
      return JSON.stringify({
        classificationPath: 'Direct|IT|Software',
        reasoning: 'Mock classification — supplier provides software/IT services',
        descriptionSupplierAligned: true,
      });
    }
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

// --- Imports (after mocks) ---
import { dialog } from 'electron';
import { databaseService, supplierUniverseService } from '../../src/main/services/database';
import * as projectService from '../../src/main/services/project';
import * as taxonomyService from '../../src/main/services/taxonomy';
import * as uploadService from '../../src/main/services/upload';
import * as classificationService from '../../src/main/services/classification';
import * as exportService from '../../src/main/services/export';
import * as colabipService from '../../src/main/services/colabip';
import * as transactionService from '../../src/main/services/transactions';

// Wire up the save dialog mock to write to a real temp path
vi.mocked(dialog.showSaveDialog).mockImplementation(async () => {
  exportState.filePath = path.join(os.tmpdir(), `pipeline-mock-export-${Date.now()}.csv`);
  return { canceled: false, filePath: exportState.filePath };
});

// --- Paths ---
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const COLABIP_DIR = path.join(FIXTURES_DIR, 'colabip');
const STANDARD_CSV = path.join(FIXTURES_DIR, 'csv', 'standard.csv');

function tempPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `pipeline-mock-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}

describe('Classifier Mock Integration Test (v2)', () => {
  let dbPath: string;
  let supplierDbPath: string;

  beforeAll(() => {
    colabipService.setColabipBasePath(COLABIP_DIR);
    // Each integration test uses its own supplier universe path
    // to avoid DuckDB file lock conflicts when tests run in parallel.
    supplierDbPath = tempPath('.db');
    supplierUniverseService.setDefaultPath(supplierDbPath);
  });

  afterAll(async () => {
    try { await projectService.closeProject(); } catch { /* already closed */ }

    // Clean up temp files (db, supplier db, export csv + WAL files)
    for (const p of [dbPath, supplierDbPath, exportState.filePath]) {
      if (!p) continue;
      for (const suffix of ['', '.wal']) {
        const fp = p + suffix;
        if (fs.existsSync(fp)) {
          try { fs.unlinkSync(fp); } catch { /* ignore */ }
        }
      }
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 1: Create project + set company context
  // ────────────────────────────────────────────────────────────────

  it('Phase 1: Create project and set company context', async () => {
    dbPath = tempPath('.c91');

    const result = await projectService.createProject('Mock Integration Test', dbPath);
    expect(result.name).toBe('Mock Integration Test');
    expect(databaseService.isOpen()).toBe(true);
    expect(supplierUniverseService.isOpen()).toBe(true);

    // Set company context via updateMetadata (v2 stores as JSON on project table)
    await projectService.updateMetadata({
      companyContext: {
        industry: 'Technology',
        sector: 'Software',
        description: 'Mock company for integration testing',
        businessFocus: 'Enterprise software development',
      },
    });

    const metadata = await projectService.getMetadata();
    expect(metadata.companyContext?.industry).toBe('Technology');
    expect(metadata.projectName).toBe('Mock Integration Test');
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 2: Import taxonomy from ColabIP fixtures
  // ────────────────────────────────────────────────────────────────

  it('Phase 2: Import taxonomy from ColabIP fixtures', async () => {
    await taxonomyService.importFromColabip('general');

    const nodes = await taxonomyService.getNodes();
    expect(nodes.length).toBeGreaterThan(0);

    // Verify the expected L3 node exists
    const softwareNode = nodes.find((n) => n.fullPath === 'Direct|IT|Software');
    expect(softwareNode).toBeDefined();
    expect(softwareNode!.depth).toBe(3);

    // Verify project metadata updated with taxonomy name
    const metadata = await projectService.getMetadata();
    expect(metadata.taxonomyName).toBe('general');
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3: Upload CSV with column mapping
  // ────────────────────────────────────────────────────────────────

  it('Phase 3: Import CSV with column mapping', async () => {
    // standard.csv: Supplier, Invoice Number, Amount, Date, Description (5 rows)
    const columnMapping = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
      line_description: 'Description',
    };

    const result = await uploadService.importCSV(STANDARD_CSV, columnMapping);
    expect(result.rowsInserted).toBe(5);

    const stats = await transactionService.getStats();
    expect(stats.totalRows).toBe(5);
    expect(stats.unclassifiedRows).toBe(5);
    expect(stats.uniqueSuppliers).toBe(5);

    // Verify canonical columns were added
    const columns = await transactionService.getColumns();
    expect(columns).toContain('supplier_name');
    expect(columns).toContain('spend_amount');
    expect(columns).toContain('invoice_date');
    expect(columns).toContain('line_description');
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 4: Seed supplier universe
  // ────────────────────────────────────────────────────────────────

  it('Phase 4: Seed supplier_universe.db with test suppliers', async () => {
    // Classification uses supplier research from supplier_universe.db when available
    const supplierNames = [
      'Acme Corp', 'Globex Inc', 'Initech', 'Wayne Enterprises', 'Stark Industries',
    ];

    for (const name of supplierNames) {
      await supplierUniverseService.run(
        `INSERT INTO suppliers (id, supplier_name, supplier_info, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        `sup-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        JSON.stringify({
          supplierType: 'company',
          description: `Test supplier: ${name}`,
          industry: 'Technology',
        })
      );
    }

    const count = await supplierUniverseService.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM suppliers'
    );
    expect(Number(count?.cnt)).toBe(5);
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 5: Run classification with mocked LLM
  // ────────────────────────────────────────────────────────────────

  it('Phase 5: Run classification (mocked LLM)', async () => {
    // Set up main window ref for progress events
    classificationService.setMainWindow({
      webContents: { send: mockSend },
    });

    // startClassification() takes no params in v2 — classifies all unclassified
    await classificationService.startClassification();

    expect(classificationService.getIsRunning()).toBe(false);

    // Verify progress events were emitted
    const progressCalls = mockSend.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pipeline:progress'
    );
    expect(progressCalls.length).toBeGreaterThan(0);

    // Last progress event should be 'completed'
    const lastProgress = progressCalls[progressCalls.length - 1][1];
    expect(lastProgress.status).toBe('completed');
  }, 30000);

  // ────────────────────────────────────────────────────────────────
  // Phase 6: Verify classification results
  // ────────────────────────────────────────────────────────────────

  it('Phase 6: Verify transactions got classified', async () => {
    const stats = await transactionService.getStats();
    expect(stats.classifiedRows).toBe(5);
    expect(stats.unclassifiedRows).toBe(0);

    const txns = await transactionService.queryTransactions();
    expect(txns.length).toBe(5);

    for (const txn of txns) {
      expect(txn.classificationStatus).toBe('classified_by_ai');
      expect(txn.taxonomyNodeId).toBeTruthy();
      expect(txn.classificationPath).toBe('Direct|IT|Software');
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 7: Export CSV and verify output
  // ────────────────────────────────────────────────────────────────

  it('Phase 7: Export classified results to CSV', async () => {
    const result = await exportService.exportCSV();
    expect(result).not.toBeNull();
    expect(result!.rowsExported).toBe(5);

    // Verify the exported file exists and has correct structure
    expect(exportState.filePath).not.toBeNull();
    expect(fs.existsSync(exportState.filePath!)).toBe(true);

    const csvContent = fs.readFileSync(exportState.filePath!, 'utf-8');
    const lines = csvContent.trim().split(/\r?\n/);

    // Header + 5 data rows
    expect(lines.length).toBe(6);

    // Verify header contains classification columns
    const header = lines[0];
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_status');
    expect(header).toContain('classification_l1');
    expect(header).toContain('classification_l2');
    expect(header).toContain('classification_l3');

    // Verify data rows contain the mock classification path
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toContain('Direct|IT|Software');
    }
  });
});
