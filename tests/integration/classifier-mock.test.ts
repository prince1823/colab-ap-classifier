/**
 * Classifier Mock Test — v2 DI integration smoke test with mocked LLM
 *
 * Tests the full classification flow using real DuckDB, constructor-injected
 * services, and a mock LLM client.
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
import { ChangelogStore } from '../../src/main/services/changelog';
import { TransactionStore } from '../../src/main/services/transactions';
import { ProjectStore } from '../../src/main/services/project';
import { TaxonomyStore } from '../../src/main/services/taxonomy';
import { RuleStore } from '../../src/main/services/rules';
import { IngestService } from '../../src/main/services/ingest';
import { ExportService } from '../../src/main/services/export';
import { ClassificationRunner } from '../../src/main/services/classification';
import { SupplierService } from '../../src/main/services/supplier-service';
import {
  createMockSupplierUniverse,
  createMockEventBus,
  createMockColumnMappingAgent,
  createMockClassificationAgent,
} from '../helpers/mock-services';
import type { EventBus, SupplierUniverse, ClassificationAgent } from '../../src/shared/types/services';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const STANDARD_CSV = path.join(FIXTURES_DIR, 'csv', 'standard.csv');

function tempPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `classifier-mock-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}

describe('Classifier Mock Integration Test (v2 DI)', () => {
  let db: DuckDBDatabase;
  let dbPath: string;
  let exportPath: string | null = null;

  let changelog: ChangelogStore;
  let transactions: TransactionStore;
  let project: ProjectStore;
  let taxonomy: TaxonomyStore;
  let rules: RuleStore;
  let ingest: IngestService;
  let exportSvc: ExportService;
  let classifier: ClassificationRunner;
  let suppliers: SupplierService;
  let supplierUniverse: SupplierUniverse;
  let eventBus: EventBus;
  let classificationAgent: ClassificationAgent;

  beforeAll(() => {
    dbPath = tempPath('.c91');

    // Build service graph with real DuckDB and mock externals
    db = new DuckDBDatabase();
    supplierUniverse = createMockSupplierUniverse();
    eventBus = createMockEventBus();
    classificationAgent = createMockClassificationAgent();
    // Override mock to return a path that matches our taxonomy
    vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
      classificationPath: 'Direct|IT|Software',
      reasoning: 'Mock classification',
      descriptionSupplierAligned: true,
    });
    const columnMappingAgent = createMockColumnMappingAgent();

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
  });

  afterAll(async () => {
    try { await project.closeProject(); } catch { /* already closed */ }
    for (const p of [dbPath, exportPath]) {
      if (!p) continue;
      for (const suffix of ['', '.wal']) {
        const fp = p + suffix;
        if (fs.existsSync(fp)) {
          try { fs.unlinkSync(fp); } catch { /* ignore */ }
        }
      }
    }
  });

  it('Phase 1: Create project and set company context', async () => {
    const result = await project.createProject('Mock Integration Test', dbPath);
    expect(result.name).toBe('Mock Integration Test');
    expect(db.isOpen()).toBe(true);

    await project.setSetting('company_context', {
      industry: 'Technology',
      sector: 'Software',
      description: 'Mock company for integration testing',
    });

    const companyContext = await project.getSetting('company_context') as Record<string, string> | undefined;
    expect(companyContext?.industry).toBe('Technology');
  });

  it('Phase 2: Add taxonomy nodes (parents first)', async () => {
    // Must add L1 and L2 parents before L3 leaves
    await taxonomy.addNode('Direct');
    await taxonomy.addNode('Direct|IT');
    await taxonomy.addNode('Direct|IT|Software', 'Software licenses');
    await taxonomy.addNode('Direct|IT|Hardware', 'Hardware purchases');
    await taxonomy.addNode('Indirect');
    await taxonomy.addNode('Indirect|Office');
    await taxonomy.addNode('Indirect|Office|Supplies', 'Office supplies');

    const nodes = await taxonomy.getNodes();
    expect(nodes.length).toBe(7);

    const softwareNode = nodes.find((n) => n.fullPath === 'Direct|IT|Software');
    expect(softwareNode).toBeDefined();
    expect(softwareNode!.depth).toBe(3);
  });

  it('Phase 3: Import CSV with column mapping', async () => {
    const columnMapping = {
      supplier_name: 'Supplier',
      spend_amount: 'Amount',
      invoice_date: 'Date',
      line_description: 'Description',
    };

    const result = await ingest.importCSV(STANDARD_CSV, columnMapping);
    expect(result.rowsInserted).toBe(5);

    const stats = await transactions.getStats();
    expect(stats.totalRows).toBe(5);
    expect(stats.unclassifiedRows).toBe(5);
  });

  it('Phase 3b: Normalize suppliers', async () => {
    // importCSV doesn't create project_suppliers; we need to link them
    // Get distinct supplier names from transactions
    const supplierRows = await db.all<{ supplier_name: string }>(
      'SELECT DISTINCT supplier_name FROM transactions WHERE supplier_name IS NOT NULL'
    );
    expect(supplierRows.length).toBe(5);

    for (const row of supplierRows) {
      const supplierId = await suppliers.normalizeSupplierName(row.supplier_name);
      await db.run(
        'UPDATE transactions SET project_supplier_id = ? WHERE supplier_name = ?',
        supplierId,
        row.supplier_name
      );
    }

    // Verify linking
    const unlinked = await db.get<{ cnt: number | bigint }>(
      'SELECT COUNT(*) as cnt FROM transactions WHERE project_supplier_id IS NULL'
    );
    expect(Number(unlinked?.cnt ?? 0)).toBe(0);
  });

  it('Phase 4: Run classification (mocked LLM)', async () => {
    await classifier.classifyAll();

    expect(classifier.getIsRunning()).toBe(false);
  }, 30000);

  it('Phase 5: Verify transactions got classified', async () => {
    const stats = await transactions.getStats();
    expect(stats.classifiedRows).toBe(5);
    expect(stats.unclassifiedRows).toBe(0);
  });

  it('Phase 6: Export classified results to CSV', async () => {
    exportPath = tempPath('.csv');
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
      canceled: false,
      filePath: exportPath,
    });

    const result = await exportSvc.exportCSV();
    expect(result).not.toBeNull();
    expect(result!.rowsExported).toBe(5);

    expect(fs.existsSync(exportPath!)).toBe(true);
    const csvContent = fs.readFileSync(exportPath!, 'utf-8');
    const lines = csvContent.trim().split(/\r?\n/);
    expect(lines.length).toBe(6); // header + 5 data rows
  });
});
