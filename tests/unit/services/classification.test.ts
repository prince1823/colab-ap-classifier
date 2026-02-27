import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Database mocks ──────────────────────────────────────────────────────────

const mockRun = vi.fn();
const mockAll = vi.fn();
const mockGet = vi.fn();

const mockUniverseGet = vi.fn();

vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    run: (...args: unknown[]) => mockRun(...args),
    all: (...args: unknown[]) => mockAll(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
  supplierUniverseService: {
    get: (...args: unknown[]) => mockUniverseGet(...args),
  },
}));

// ── Service mocks ───────────────────────────────────────────────────────────

vi.mock('../../../src/main/services/taxonomy', () => ({
  getNodes: vi.fn(),
}));

vi.mock('../../../src/main/services/project', () => ({
  getMetadata: vi.fn(),
}));

vi.mock('../../../src/main/services/rules', () => ({
  evaluateRules: vi.fn(),
}));

vi.mock('../../../src/main/services/transactions', () => ({
  updateTransactions: vi.fn(),
  buildWhereClause: vi.fn(),
}));

vi.mock('../../../src/main/agents/classification-agent', () => ({
  classifyInvoiceGroup: vi.fn(),
}));

vi.mock('../../../src/main/services/changelog', () => ({
  logChange: vi.fn(),
}));

// ── Imports (must come after vi.mock calls) ─────────────────────────────────

import {
  startClassification,
  getIsRunning,
  cancel,
  pause,
  resume,
  cleanDescription,
  setMainWindow,
} from '../../../src/main/services/classification';
import { evaluateRules } from '../../../src/main/services/rules';
import { classifyInvoiceGroup } from '../../../src/main/agents/classification-agent';
import { updateTransactions } from '../../../src/main/services/transactions';
import { getNodes } from '../../../src/main/services/taxonomy';
import { getMetadata } from '../../../src/main/services/project';
import { logChange } from '../../../src/main/services/changelog';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock BrowserWindow-like object for progress events. */
function createMockWindow() {
  return {
    webContents: {
      send: vi.fn(),
    },
  };
}

/** Wait for the async pipeline to settle. */
function settle(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a deferred promise that can be resolved externally. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Classification (v2)', () => {
  let mockWindow: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = createMockWindow();
    setMainWindow(mockWindow);
  });

  afterEach(async () => {
    // Ensure pipeline is stopped between tests
    if (getIsRunning()) {
      await cancel();
      await settle(100);
    }
    setMainWindow(null);
  });

  // ── cleanDescription ────────────────────────────────────────────────────

  describe('cleanDescription', () => {
    it('should strip numeric characters when >= 70% numeric', () => {
      const result = cleanDescription('1234567abc');
      // 7 numeric out of 10 non-whitespace = 70%
      expect(result).not.toContain('1');
      expect(result).toContain('abc');
    });

    it('should keep description when < 70% numeric', () => {
      const result = cleanDescription('hello world 123');
      expect(result).toBe('hello world 123');
    });

    it('should handle empty string', () => {
      expect(cleanDescription('')).toBe('');
    });
  });

  // ── startClassification ─────────────────────────────────────────────────

  describe('startClassification', () => {
    it('should complete with no unclassified transactions', async () => {
      // No unclassified suppliers found
      mockAll.mockResolvedValue([]);

      await startClassification();

      // Should have emitted a completed progress event
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({
          status: 'completed',
          totalSuppliers: 0,
          percentage: 100,
        })
      );
    });

    it('should reject if already running', async () => {
      // Use a deferred so we can control when the supplier query resolves
      const deferred = createDeferred<{ supplier_name: string }[]>();
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return [{ column_name: 'supplier_name' }];
        return deferred.promise;
      });

      // Fire-and-forget the first call (it returns void, pipeline runs in background)
      const firstRun = startClassification();

      // Yield to let startClassification set isRunning = true
      await settle(10);

      // Second call should throw while the first is in progress
      await expect(startClassification()).rejects.toThrow(
        'Classification is already running'
      );

      // Unblock the first pipeline so it can finish (empty list = quick exit)
      deferred.resolve([]);
      await firstRun;
    });

    it('should set isRunning to true while running', async () => {
      const deferred = createDeferred<{ supplier_name: string }[]>();
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return [{ column_name: 'supplier_name' }];
        return deferred.promise;
      });

      const run = startClassification();
      await settle(10);

      expect(getIsRunning()).toBe(true);

      // Unblock and let it complete
      deferred.resolve([]);
      await run;

      expect(getIsRunning()).toBe(false);
    });
  });

  // ── cancel ──────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('should stop a running classification', async () => {
      const deferred = createDeferred<{ supplier_name: string }[]>();
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return [{ column_name: 'supplier_name' }];
        return deferred.promise;
      });

      const run = startClassification();
      await settle(10);

      await cancel();

      // Should emit cancelled progress
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({
          status: 'cancelled',
        })
      );

      // Unblock the pipeline so it can exit its finally block
      deferred.resolve([]);
      await run.catch(() => {});
    });
  });

  // ── pause / resume ──────────────────────────────────────────────────────

  describe('pause / resume', () => {
    it('pause should set paused state; resume should clear it', async () => {
      const deferred = createDeferred<{ supplier_name: string }[]>();
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return [{ column_name: 'supplier_name' }];
        return deferred.promise;
      });

      const run = startClassification();
      await settle(10);

      // Pause while running
      pause();
      expect(getIsRunning()).toBe(true);

      // Resume
      resume();
      expect(getIsRunning()).toBe(true);

      // Unblock and clean up
      deferred.resolve([]);
      await run;
    });
  });

  // ── pipeline execution ──────────────────────────────────────────────────

  describe('pipeline execution', () => {
    it('should skip suppliers not in supplier_universe', async () => {
      // Column-existence check + one supplier with unclassified transactions
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return [{ column_name: 'supplier_name' }];
        return [{ supplier_name: 'Unknown Inc' }];
      });

      // Supplier NOT in universe
      mockUniverseGet.mockResolvedValue(undefined);

      await startClassification();

      // Should report failed because no suppliers are researched
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({
          status: 'failed',
          currentStep: expect.stringContaining('No suppliers have been researched'),
        })
      );
    });

    it('should apply override rules before LLM classification', async () => {
      // -- Mock supplier list query (first call to databaseService.all) --
      let allCallCount = 0;
      mockAll.mockImplementation(async (sql: string, ...args: unknown[]) => {
        allCallCount++;

        // Column-existence check for supplier_name
        if (sql.includes('information_schema.columns') && sql.includes('supplier_name')) {
          return [{ column_name: 'supplier_name' }];
        }

        // Get suppliers with unclassified transactions
        if (sql.includes('DISTINCT supplier_name') && sql.includes('classification_status')) {
          return [{ supplier_name: 'Acme' }];
        }

        // Per-supplier: get unclassified transactions
        if (sql.includes('SELECT * FROM transactions') && sql.includes('classification_status')) {
          return [
            {
              id: 'tx1',
              supplier_name: 'Acme',
              row_index: 0,
              spend_amount: 1000,
              gl_description: 'Software license',
              classification_status: 'unclassified',
            },
            {
              id: 'tx2',
              supplier_name: 'Acme',
              row_index: 1,
              spend_amount: 5000,
              gl_description: 'Cloud services',
              classification_status: 'unclassified',
            },
          ];
        }

        // Failed txn query on error paths
        if (sql.includes('SELECT id FROM transactions') && sql.includes('classification_status')) {
          return [];
        }

        // Classified count for changelog
        if (sql.includes('COUNT(*)') && sql.includes('classification_status')) {
          return [];
        }

        return [];
      });

      // Get mock for classified count at the end
      mockGet.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return { cnt: 2 };
        }
        return undefined;
      });

      // Supplier exists in universe (research gate passes)
      mockUniverseGet.mockImplementation(async (sql: string, ...args: unknown[]) => {
        if (sql.includes('SELECT id FROM suppliers')) {
          return { id: 'sup1' };
        }
        if (sql.includes('supplier_info')) {
          return { supplier_info: JSON.stringify({ description: 'A tech company' }), parent_name: null };
        }
        return undefined;
      });

      // Override rules match tx1 but not tx2
      vi.mocked(evaluateRules).mockResolvedValue(
        new Map([
          ['tx1', { ruleId: 'rule1', targetTaxonomyNodeId: 'tid1' }],
        ])
      );

      vi.mocked(getNodes).mockResolvedValue([
        {
          id: 'tid1',
          fullPath: 'Indirect|IT|Software',
          l1: 'Indirect',
          l2: 'IT',
          l3: 'Software',
          depth: 3,
          description: null,
          parentPath: 'Indirect|IT',
          createdAt: '',
        },
      ]);

      vi.mocked(getMetadata).mockResolvedValue({
        name: 'Test',
        filePath: '/test.c91',
        companyContext: { industry: 'Tech' },
        columnMappings: null,
        invoiceGroupingColumns: null,
        tailSpendThreshold: 10000,
        taxonomyName: null,
        createdAt: null,
      });

      vi.mocked(classifyInvoiceGroup).mockResolvedValue({
        classificationPath: 'Indirect|IT|Software',
        reasoning: 'Test reasoning',
        descriptionSupplierAligned: true,
      });

      vi.mocked(updateTransactions).mockResolvedValue(undefined);
      vi.mocked(logChange).mockResolvedValue('log1');
      mockRun.mockResolvedValue(undefined);

      await startClassification();

      // evaluateRules should have been called with the transaction IDs
      expect(evaluateRules).toHaveBeenCalledWith(['tx1', 'tx2']);

      // updateTransactions should have been called for rule-matched tx (tx1)
      expect(updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['tx1'],
          taxonomyNodeId: 'tid1',
          classificationStatus: 'classified_by_rule',
          classificationReasoning: 'Matched override rule',
        }),
        'rule'
      );

      // classifyInvoiceGroup should have been called for unmatched tx (tx2 only)
      expect(classifyInvoiceGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          transactions: expect.arrayContaining([
            expect.objectContaining({ id: 'tx2' }),
          ]),
        })
      );

      // AI classification should update unmatched txns
      expect(updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['tx2'],
          classificationStatus: 'classified_by_ai',
          classificationReasoning: 'Test reasoning',
        }),
        'pipeline'
      );

      // logChange should have been called on completion
      expect(logChange).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'pipeline',
          affectedTable: 'transactions',
        })
      );
    });

    it('should emit progress events through mainWindow', async () => {
      // Single supplier, no transactions after fetching
      mockAll.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return [{ column_name: 'supplier_name' }];
        if (sql.includes('DISTINCT supplier_name')) {
          return [{ supplier_name: 'ProgressCorp' }];
        }
        if (sql.includes('SELECT * FROM transactions') && sql.includes('classification_status')) {
          return [];
        }
        if (sql.includes('COUNT(*)')) {
          return [];
        }
        return [];
      });

      // Supplier exists in universe
      mockUniverseGet.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM suppliers')) {
          return { id: 'sup1' };
        }
        return undefined;
      });

      mockGet.mockResolvedValue({ cnt: 0 });
      vi.mocked(getNodes).mockResolvedValue([]);
      vi.mocked(getMetadata).mockResolvedValue({
        name: 'Test',
        filePath: '/test.c91',
        companyContext: { industry: 'Tech' },
        columnMappings: null,
        invoiceGroupingColumns: null,
        tailSpendThreshold: 10000,
        taxonomyName: null,
        createdAt: null,
      });
      vi.mocked(logChange).mockResolvedValue('log1');

      await startClassification();

      // Verify progress events were emitted via mainWindow
      const sendCalls = mockWindow.webContents.send.mock.calls;
      const progressCalls = sendCalls.filter(
        (call: unknown[]) => call[0] === 'classification:progress'
      );

      expect(progressCalls.length).toBeGreaterThan(0);

      // Check that at least one progress call has the expected shape
      const anyProgress = progressCalls.some(
        (call: unknown[]) => {
          const payload = call[1] as Record<string, unknown>;
          return (
            typeof payload.runId === 'string' &&
            typeof payload.totalSuppliers === 'number' &&
            typeof payload.processedSuppliers === 'number' &&
            typeof payload.percentage === 'number'
          );
        }
      );
      expect(anyProgress).toBe(true);
    });
  });
});
