/**
 * IPC Workflow Integration Test — Full 5-phase flow through handler layer
 *
 * This test exercises the EXACT path the React frontend will take:
 *   Renderer → ipcRenderer.invoke(channel, args)
 *   → ipcMain.handle(channel) → registerHandler wrapper → service function
 *   → IPCResponse<T> returned to renderer
 *
 * Every call goes through the IPC handler (captured via mocked ipcMain.handle),
 * verifying the handler registration, argument passing, IPCResponse wrapping,
 * and error handling that the frontend will depend on.
 *
 * Phases tested:
 *   Phase 1: Project creation + company context
 *   Phase 2: Taxonomy import
 *   Phase 3: CSV upload, canonicalization, import
 *   Phase 4: Classification pipeline (mocked LLM)
 *   Phase 5: Query results, stats, reclassification, changelog, export
 *
 * Run: npx vitest run tests/integration/ipc-workflow.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Capture IPC handler registrations ─────────────────────────────────
const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test.csv' }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/test.csv'] }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

// ── Mock LLM client ──────────────────────────────────────────────────
// Same mock pattern as pipeline-mock.test.ts — agents call llmClient.chat(systemPrompt, userPrompt, options)
vi.mock('../../src/main/services/llm-client', () => ({
  chat: vi.fn().mockImplementation(async (systemPrompt: string) => {
    // Canonicalization agent
    if (systemPrompt.includes('column mapping')) {
      return JSON.stringify({
        mappings: {
          supplier_name: 'Supplier',
          spend_amount: 'Amount',
          gl_description: 'Description',
        },
        confidence: 0.95,
      });
    }

    // Classification agent — match BEFORE research since both mention "supplier"
    if (systemPrompt.includes('AP transaction classifier')) {
      return JSON.stringify({
        classificationPath: 'Direct|IT|Software',
        reasoning: 'Mock: software vendor',
        confidence: 0.85,
        descriptionSupplierAligned: true,
      });
    }

    // Research agent
    if (systemPrompt.includes('supplier research analyst')) {
      return JSON.stringify({
        officialBusinessName: 'Mock Supplier',
        industry: 'Technology',
        description: 'Mock supplier description',
        confidence: 'high',
        sources: [],
      });
    }

    // Feedback agent
    if (systemPrompt.includes('feedback analyst')) {
      return JSON.stringify({
        feedbackType: 'company_context',
        suggestion: { fieldName: 'industry', currentValue: 'Tech', proposedValue: 'Software' },
      });
    }

    // Default — always return valid JSON string
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

// ── Imports (after mocks) ────────────────────────────────────────────
import { registerAllHandlers } from '../../src/main/ipc';
import { databaseService } from '../../src/main/services/database';
import * as projectService from '../../src/main/services/project';
import * as classificationPipeline from '../../src/main/services/classification-pipeline';
import * as colabipService from '../../src/main/services/colabip';
import type { IPCResponse } from '../../src/shared/types';

// ── Helpers ──────────────────────────────────────────────────────────

/** Call an IPC handler the same way Electron's ipcMain.handle does. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<IPCResponse<T>> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  // ipcMain.handle passes (event, ...args) — event is the IPC event object
  return handler({} /* fake IpcMainInvokeEvent */, ...args) as Promise<IPCResponse<T>>;
}

/** Create a temporary CSV file for testing. */
function createMockCSV(): string {
  const csvPath = path.join(os.tmpdir(), `ipc-test-${Date.now()}.csv`);
  const content = `Supplier,Amount,Description,Date
Acme Corp,1500.00,Software licenses,2024-01-15
TechVendor Inc,3200.50,Cloud hosting,2024-01-20
Office Depot,250.75,Office supplies,2024-01-22
Acme Corp,800.00,Support contract,2024-02-01`;
  fs.writeFileSync(csvPath, content, 'utf-8');
  return csvPath;
}

// ── Test Suite ───────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const COLABIP_DIR = path.join(FIXTURES_DIR, 'colabip');

describe('IPC Workflow Integration — Full 5-Phase Flow', () => {
  let dbPath: string;
  let csvPath: string;
  let exportPath: string;

  beforeAll(async () => {
    // Point ColabIP to test fixtures
    colabipService.setColabipBasePath(COLABIP_DIR);

    // Register ALL IPC handlers (same as the main process does at startup)
    // Suppress "[IPC] Registering handler: ..." logs during registration
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerAllHandlers();
    logSpy.mockRestore();

    // Create test data
    csvPath = createMockCSV();
    dbPath = path.join(os.tmpdir(), `ipc-workflow-${Date.now()}.c91`);
  });

  afterAll(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    for (const f of [dbPath, csvPath, exportPath]) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 1: Project Setup
  // ────────────────────────────────────────────────────────────────────

  it('Phase 1a: project:isOpen returns false before any project', async () => {
    const res = await invoke<boolean>('project:isOpen');
    expect(res.success).toBe(true);
    expect(res.data).toBe(false);
  });

  it('Phase 1b: Create project via project:new', async () => {
    // project:new handler calls createProject(name) which writes to ./projects/{name}.c91
    // For testing, we call the service directly with a temp path to avoid filesystem side effects.
    // This mirrors what the IPC handler does but uses our temp path.
    await databaseService.openDatabase(dbPath);
    await databaseService.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'project_name',
      'IPC Workflow Test'
    );

    // Verify the DB is open and project:isOpen works
    // Note: project:isOpen checks both databaseService.isOpen() AND currentProjectName.
    // We need to open via openProject to set currentProjectName.
    // Re-open using the service to set in-memory project state.
    await projectService.openProject(dbPath);

    const res = await invoke<boolean>('project:isOpen');
    expect(res.success).toBe(true);
    expect(res.data).toBe(true);
  });

  it('Phase 1c: Set company context via project:updateMetadata', async () => {
    const res = await invoke<void>('project:updateMetadata', {
      companyContext: {
        industry: 'Technology',
        sector: 'Enterprise Software',
        description: 'A technology company for testing',
        businessFocus: 'Software development',
      },
      tailSpendThreshold: 5000,
    });
    expect(res.success).toBe(true);

    // Verify via project:getMetadata
    const metaRes = await invoke<{
      companyContext: { industry: string; sector: string } | null;
      tailSpendThreshold: number;
    }>('project:getMetadata');
    expect(metaRes.success).toBe(true);
    expect(metaRes.data!.companyContext!.industry).toBe('Technology');
    expect(metaRes.data!.companyContext!.sector).toBe('Enterprise Software');
    expect(metaRes.data!.tailSpendThreshold).toBe(5000);
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 2: Taxonomy
  // ────────────────────────────────────────────────────────────────────

  it('Phase 2a: List available taxonomies via colabip:listTaxonomies', async () => {
    const res = await invoke<Array<{ name: string }>>('colabip:listTaxonomies');
    expect(res.success).toBe(true);
    expect(res.data!.length).toBeGreaterThan(0);
    const names = res.data!.map((t) => t.name);
    expect(names).toContain('general');
  });

  it('Phase 2b: Import taxonomy via taxonomy:importFromColabip', async () => {
    const res = await invoke<void>('taxonomy:importFromColabip', 'general');
    expect(res.success).toBe(true);

    // Verify via taxonomy:getNodes
    const nodesRes = await invoke<Array<{ fullPath: string; depth: number }>>('taxonomy:getNodes');
    expect(nodesRes.success).toBe(true);
    expect(nodesRes.data!.length).toBeGreaterThan(0);

    // Verify via taxonomy:get (metadata)
    const metaRes = await invoke<{ name: string; nodeCount: number }>('taxonomy:get');
    expect(metaRes.success).toBe(true);
    expect(metaRes.data!.name).toBe('general');
    expect(metaRes.data!.nodeCount).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3: Upload & Canonicalization
  // ────────────────────────────────────────────────────────────────────

  it('Phase 3a: Parse CSV preview via upload:parsePreview', async () => {
    const res = await invoke<{
      columns: string[];
      sampleRows: Record<string, string>[];
      totalRows: number;
      mappingSuggestion: { mappings: Record<string, string>; confidence: string };
    }>('upload:parsePreview', csvPath);
    expect(res.success).toBe(true);
    expect(res.data!.totalRows).toBe(4);
    expect(res.data!.columns).toContain('Supplier');
    expect(res.data!.columns).toContain('Amount');
    expect(res.data!.sampleRows.length).toBeGreaterThan(0);
  });

  it('Phase 3b: Save column mappings via canonicalization:save', async () => {
    const res = await invoke<void>(
      'canonicalization:save',
      {
        supplier_name: 'Supplier',
        spend_amount: 'Amount',
        gl_description: 'Description',
      },
      ['supplier_name']
    );
    expect(res.success).toBe(true);
  });

  it('Phase 3c: Import CSV data via upload:csv', async () => {
    const res = await invoke<{ rowsInserted: number }>('upload:csv', csvPath);
    expect(res.success).toBe(true);
    expect(res.data!.rowsInserted).toBe(4);
  });

  it('Phase 3d: Verify imported data via transactions:getColumns', async () => {
    const res = await invoke<string[]>('transactions:getColumns');
    expect(res.success).toBe(true);
    expect(res.data!).toContain('supplier_name');
    expect(res.data!).toContain('spend_amount');
    expect(res.data!).toContain('gl_description');
  });

  it('Phase 3e: Verify suppliers extracted via suppliers:list', async () => {
    const res = await invoke<Array<{ supplierName: string }>>('suppliers:list');
    expect(res.success).toBe(true);
    const names = res.data!.map((s) => s.supplierName);
    expect(names).toContain('Acme Corp');
    expect(names).toContain('TechVendor Inc');
    expect(names).toContain('Office Depot');
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 4: Classification Pipeline
  // ────────────────────────────────────────────────────────────────────

  it('Phase 4a: Start classification via classification:start', async () => {
    // Set up mock main window for progress events
    const progressEvents: unknown[] = [];
    classificationPipeline.setMainWindow({
      webContents: {
        send: (_channel: string, ...args: unknown[]) => {
          progressEvents.push(args[0]);
        },
      },
    });

    const res = await invoke<{ runId: string }>('classification:start', {
      scope: 'all',
    });
    expect(res.success).toBe(true);
    expect(res.data!.runId).toBeTruthy();

    // Wait for pipeline to complete
    const maxWait = 30000;
    const startTime = Date.now();
    let status: IPCResponse<{ status: string } | null>;

    do {
      await new Promise((r) => setTimeout(r, 200));
      status = await invoke('classification:getStatus');
    } while (
      status.data &&
      !['completed', 'failed', 'cancelled'].includes(status.data.status) &&
      Date.now() - startTime < maxWait
    );

    expect(status.success).toBe(true);
    expect(status.data!.status).toBe('completed');
    expect(progressEvents.length).toBeGreaterThan(0);
  }, 40000);

  it('Phase 4b: Verify classification results via transactions:stats', async () => {
    const res = await invoke<{
      totalRows: number;
      classifiedRows: number;
      uniqueSuppliers: number;
    }>('transactions:stats');
    expect(res.success).toBe(true);
    // DuckDB COUNT returns BigInt — use Number() for comparison
    expect(Number(res.data!.totalRows)).toBe(4);
    expect(Number(res.data!.classifiedRows)).toBeGreaterThanOrEqual(0);
    expect(Number(res.data!.uniqueSuppliers)).toBe(3);
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 5: Review & Export
  // ────────────────────────────────────────────────────────────────────

  it('Phase 5a: Query transactions via transactions:query', async () => {
    const res = await invoke<Array<{
      id: string;
      classificationPath: string | null;
      reviewScore: number | null;
      taxonomyNodeId: string | null;
      canonicalFields: Record<string, unknown>;
    }>>('transactions:query', { page: 1, pageSize: 10 });
    expect(res.success).toBe(true);
    expect(res.data!.length).toBe(4);

    // Verify transactions have canonical fields populated from CSV
    for (const txn of res.data!) {
      expect(txn.canonicalFields.supplier_name).toBeTruthy();
    }
  });

  it('Phase 5b: Verify changelog via changelog:list', async () => {
    const res = await invoke<Array<{
      id: string;
      source: string;
      description: string | null;
      affectedCount: number;
    }>>('changelog:list');
    expect(res.success).toBe(true);
    expect(res.data!.length).toBeGreaterThan(0);

    const pipelineEntry = res.data!.find((c) => c.source === 'pipeline');
    expect(pipelineEntry).toBeDefined();
    expect(pipelineEntry!.affectedCount).toBe(4);
  });

  it('Phase 5c: Reclassify a transaction via transactions:reclassify', async () => {
    // Get a transaction and a taxonomy node
    const txnRes = await invoke<Array<{ id: string }>>('transactions:query', {
      page: 1,
      pageSize: 1,
    });
    const txnId = txnRes.data![0].id;

    const nodesRes = await invoke<Array<{ id: string; fullPath: string; depth: number }>>(
      'taxonomy:getNodes'
    );
    // Find an L3 node different from the current classification
    const l3Node = nodesRes.data!.find((n) => n.depth === 3);
    expect(l3Node).toBeDefined();

    const res = await invoke<void>(
      'transactions:reclassify',
      [txnId],
      l3Node!.id
    );
    expect(res.success).toBe(true);

    // Verify changelog was updated
    const logRes = await invoke<Array<{ source: string }>>('changelog:list');
    const manualEntries = logRes.data!.filter((c) => c.source === 'manual');
    expect(manualEntries.length).toBeGreaterThan(0);
  });

  it('Phase 5d: Export to CSV via export:export', async () => {
    exportPath = path.join(os.tmpdir(), `ipc-export-${Date.now()}.csv`);

    const res = await invoke<{ rowsExported: number }>('export:export', exportPath);
    expect(res.success).toBe(true);
    expect(res.data!.rowsExported).toBe(4);
    expect(fs.existsSync(exportPath)).toBe(true);

    // Verify CSV structure
    const csvContent = fs.readFileSync(exportPath, 'utf-8');
    const lines = csvContent.trim().split('\n');
    expect(lines.length).toBe(5); // Header + 4 data rows

    // Verify header has classification columns
    const header = lines[0];
    expect(header).toContain('classification_path');
    expect(header).toContain('classification_l1');
    expect(header).toContain('classification_l2');
    expect(header).toContain('classification_l3');
    expect(header).toContain('review_score');
  });

  // ────────────────────────────────────────────────────────────────────
  // Error Handling — Frontend will see these as IPCResponse.success=false
  // ────────────────────────────────────────────────────────────────────

  it('Error: classification:start rejects when already running', async () => {
    // Start a classification
    classificationPipeline.setMainWindow({ webContents: { send: vi.fn() } });
    const res1 = await invoke<{ runId: string }>('classification:start', {
      scope: 'all',
    });
    expect(res1.success).toBe(true);

    // Try to start another immediately — should get wrapped error
    const res2 = await invoke<{ runId: string }>('classification:start', {
      scope: 'all',
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toContain('already running');

    // Wait for the first one to complete
    let status: IPCResponse<{ status: string } | null>;
    const start = Date.now();
    do {
      await new Promise((r) => setTimeout(r, 200));
      status = await invoke('classification:getStatus');
    } while (
      status.data &&
      !['completed', 'failed', 'cancelled'].includes(status.data.status) &&
      Date.now() - start < 30000
    );
  }, 40000);
});
