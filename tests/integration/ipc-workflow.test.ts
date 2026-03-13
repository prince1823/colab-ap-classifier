/**
 * IPC Workflow Integration Test — Full flow through handler layer (v2 DI architecture)
 *
 * Tests the IPC handler registration and invocation using a real DuckDB database
 * with the ServiceContainer wiring.
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
  BrowserWindow: {
    getFocusedWindow: vi.fn().mockReturnValue(null),
    getAllWindows: vi.fn().mockReturnValue([{ webContents: { send: vi.fn() } }]),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────
import { registerAllHandlers } from '../../src/main/ipc';
import { DuckDBDatabase } from '../../src/main/services/database';
import { ChangelogStore } from '../../src/main/services/changelog';
import { TransactionStore } from '../../src/main/services/transactions';
import { ProjectStore } from '../../src/main/services/project';
import { TaxonomyStore } from '../../src/main/services/taxonomy';
import { RuleStore } from '../../src/main/services/rules';
import { ExportService } from '../../src/main/services/export';
import { IngestService } from '../../src/main/services/ingest';
import { SupplierService } from '../../src/main/services/supplier-service';
import {
  createMockSupplierUniverse,
  createMockEventBus,
  createMockLLMClient,
  createMockWebSearch,
  createMockClassificationAgent,
  createMockResearchAgent,
  createMockColumnMappingAgent,
  createMockSupplierResearcher,
  createMockClassificationRunner,
} from '../helpers/mock-services';
import type { ServiceContainer } from '../../src/main/container';
import type { IPCResponse } from '../../src/shared/types';

// ── Helpers ──────────────────────────────────────────────────────────

/** Call an IPC handler the same way Electron's ipcMain.handle does. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<IPCResponse<T>> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
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

describe('IPC Workflow Integration — Full Flow (v2 DI)', () => {
  let dbPath: string;
  let csvPath: string;
  let db: DuckDBDatabase;

  beforeAll(async () => {
    csvPath = createMockCSV();
    dbPath = path.join(os.tmpdir(), `ipc-workflow-${Date.now()}.c91`);

    // Build real container with real DuckDB but mock external services
    db = new DuckDBDatabase();
    const supplierUniverse = createMockSupplierUniverse();
    const eventBus = createMockEventBus();
    const llm = createMockLLMClient();
    const webSearch = createMockWebSearch();
    const classificationAgent = createMockClassificationAgent();
    const researchAgent = createMockResearchAgent();
    const columnMappingAgent = createMockColumnMappingAgent();

    const changelog = new ChangelogStore(db);
    const transactions = new TransactionStore(db, changelog);
    const project = new ProjectStore(db, transactions, supplierUniverse);
    const taxonomy = new TaxonomyStore(db, project);
    const suppliers = new SupplierService(db, supplierUniverse);
    const rules = new RuleStore(db, transactions);
    const ingest = new IngestService(db, transactions, suppliers, columnMappingAgent);
    const exportSvc = new ExportService(db);
    const researcher = createMockSupplierResearcher();
    const classifier = createMockClassificationRunner();

    const container: ServiceContainer = {
      db, supplierUniverse, eventBus, llm, webSearch,
      classificationAgent, researchAgent, columnMappingAgent,
      changelog, transactions, project, taxonomy, suppliers, rules,
      ingest, export: exportSvc, researcher, classifier,
    };

    // Register ALL IPC handlers
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerAllHandlers(container);
    logSpy.mockRestore();
  });

  afterAll(async () => {
    if (db.isOpen()) {
      await db.closeDatabase();
    }
    for (const f of [dbPath, csvPath]) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 1: Project Setup
  // ────────────────────────────────────────────────────────────────────

  it('Phase 1a: Create project via project:new', async () => {
    const res = await invoke<{ filePath: string; name: string }>(
      'project:new',
      'IPC Workflow Test',
      dbPath
    );
    expect(res.success).toBe(true);
    expect(res.data!.name).toBe('IPC Workflow Test');
    expect(res.data!.filePath).toBe(dbPath);
  });

  it('Phase 1b: Set company context via project:updateMetadata', async () => {
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
    expect(metaRes.data!.tailSpendThreshold).toBe(5000);
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 2: Taxonomy
  // ────────────────────────────────────────────────────────────────────

  it('Phase 2: Add taxonomy nodes (must add parents first)', async () => {
    // TaxonomyStore.addNode validates parent exists, so add L1 → L2 → L3 in order
    const l1Res = await invoke<unknown>('taxonomy:addNode', 'Direct');
    expect(l1Res.success).toBe(true);

    const l2Res = await invoke<unknown>('taxonomy:addNode', 'Direct|IT');
    expect(l2Res.success).toBe(true);

    const l3Res = await invoke<unknown>('taxonomy:addNode', 'Direct|IT|Software', 'Software licenses');
    expect(l3Res.success).toBe(true);

    const nodesRes = await invoke<Array<{ fullPath: string; depth: number }>>('taxonomy:getNodes');
    expect(nodesRes.success).toBe(true);
    expect(nodesRes.data!.length).toBe(3);
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3: Upload & Import
  // ────────────────────────────────────────────────────────────────────

  it('Phase 3a: Parse CSV preview via ingest:parseCSV', async () => {
    const res = await invoke<{
      columns: string[];
      sampleRows: Record<string, string>[];
      totalRows: number;
    }>('ingest:parseCSV', csvPath);
    expect(res.success).toBe(true);
    expect(res.data!.totalRows).toBe(4);
    expect(res.data!.columns).toContain('Supplier');
    expect(res.data!.columns).toContain('Amount');
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 4: Query & Review
  // ────────────────────────────────────────────────────────────────────

  it('Phase 4a: Verify changelog via changelog:list', async () => {
    const res = await invoke<Array<{
      id: string;
      source: string;
      description: string | null;
      affectedCount: number;
    }>>('changelog:list');
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Error Handling
  // ────────────────────────────────────────────────────────────────────

  it('Error: test:ping always returns success', async () => {
    const res = await invoke<string>('test:ping');
    expect(res.success).toBe(true);
    expect(res.data).toBe('pong');
  });
});
