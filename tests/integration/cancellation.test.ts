/**
 * Cancellation integration tests — verifies PR 436 ("Fix cancellation for in-flight LLM work").
 *
 * Three runners (Classification, QC, SupplierResearcher) plus the LLMClient itself must
 * propagate AbortSignal through every async boundary so that calling stop()/cancel():
 *   1. Interrupts the in-flight LLM fetch immediately (no waiting for the response).
 *   2. Interrupts retry-backoff sleeps.
 *   3. Bails out of result-application loops without writing partial state to the DB.
 *
 * Each test uses a "blocking" mock LLM call that resolves only when the runner's signal
 * aborts, then asserts:
 *   - The runner exits within a tight timeout (the cancel actually short-circuits).
 *   - The agent received an AbortSignal in its input (signal plumbing reached the agent).
 *   - No `updateTransactions(... classified_by_ai ...)` calls land after cancel
 *     (the early-return guards work — no partial DB writes).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/main/utils/debug-log', () => ({
  debugLog: vi.fn(),
}));

import { ClassificationRunner } from '../../src/main/services/classification';
import { QCRunner } from '../../src/main/services/qc';
import { SupplierResearcher } from '../../src/main/services/supplier-research';
import { chat as llmChat, LLMClientError } from '../../src/main/services/llm-client';
import {
  createMockDatabase,
  createMockTaxonomyStore,
  createMockProjectStore,
  createMockRuleStore,
  createMockTransactionStore,
  createMockChangelogStore,
  createMockClassificationAgent,
  createMockEventBus,
  createMockSupplierUniverse,
  createMockSupplierService,
  createMockQCAgent,
  createMockWebSearch,
  createMockResearchAgent,
  createMockCatAAgent,
} from '../helpers/mock-services';
import type {
  Database, TaxonomyStore, ProjectStore, RuleStore, TransactionStore,
  ChangelogStore, ClassificationAgent, EventBus, SupplierUniverse,
  SupplierService, QCAgent, WebSearch, ResearchAgent, CatAAgent,
} from '../../src/shared/types/services';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a promise that never resolves on its own, but rejects with an AbortError
 * the moment `signal` aborts. Mimics a real LLM call that respects cancellation.
 */
function blockUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      // No signal — leave the promise pending; the test is responsible for resolving via timeout.
      return;
    }
    if (signal.aborted) {
      reject(new DOMException('Operation cancelled', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('Operation cancelled', 'AbortError'));
    }, { once: true });
  });
}

/** Sleep helper. */
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── 1. LLMClient: caller signal aborts in-flight fetch ──────────────────────

describe('OpenRouterLLMClient — caller signal cancellation', () => {
  const originalEnv = { ...process.env };
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLASSIFIER_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects with AbortError (not TIMEOUT) when caller aborts the in-flight fetch', async () => {
    // The fetch implementation delegates to the inner controller's signal that the LLM
    // client wires up. When the caller's signal aborts, the LLM client calls
    // controller.abort(), which causes fetch to reject with AbortError.
    mockFetch.mockImplementation((_url, options) => {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const callerController = new AbortController();
    const t0 = Date.now();
    const promise = llmChat('sys', 'user', { signal: callerController.signal });

    // Abort after a tick so the fetch is genuinely in-flight.
    setTimeout(() => callerController.abort(), 20);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // The LLM client should NOT convert caller-aborts into LLMClientError TIMEOUT.
    // Verify by re-running and checking the error type.
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // not waiting on the 60s timeout
  });

  it('caller-abort rejects with AbortError, not LLMClientError', async () => {
    mockFetch.mockImplementation((_url, options) => {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const callerController = new AbortController();
    const promise = llmChat('sys', 'user', { signal: callerController.signal });
    setTimeout(() => callerController.abort(), 10);

    let caught: unknown;
    try { await promise; } catch (err) { caught = err; }

    // Critical: caller-cancel must NOT be wrapped as LLMClientError (TIMEOUT).
    // Pre-PR-436, this would be wrapped because the catch couldn't tell timeout from cancel.
    expect(caught).not.toBeInstanceOf(LLMClientError);
    expect((caught as Error).name).toBe('AbortError');
  });

  it('still throws LLMClientError TIMEOUT when fetch aborts due to its own timeout (not caller)', async () => {
    // Simulate the internal timeout firing — fetch rejects with AbortError but the caller
    // signal was never aborted. The LLM client should still classify this as TIMEOUT.
    mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'AbortError'));

    const callerController = new AbortController(); // never aborted
    let caught: unknown;
    try {
      await llmChat('sys', 'user', { signal: callerController.signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LLMClientError);
    expect((caught as LLMClientError).code).toBe('TIMEOUT');
  });

  it('aborts retry-backoff sleep when caller signal fires during delay', async () => {
    // First call returns 429 → triggers retry backoff. Caller aborts during the sleep.
    // The abortableDelay must reject instead of waiting out the backoff.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '2' }), // 2s retry-after
      text: vi.fn().mockResolvedValue('{"error":"rate limited"}'),
      json: vi.fn(),
    } as unknown as Response);

    const callerController = new AbortController();
    const t0 = Date.now();
    const promise = llmChat('sys', 'user', { signal: callerController.signal });

    // Abort during the 2s backoff window.
    setTimeout(() => callerController.abort(), 50);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const elapsed = Date.now() - t0;

    // Pre-PR: would wait the full 2000ms backoff. Post-PR: <300ms.
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── 2. ClassificationRunner.stop() aborts in-flight LLM call ────────────────

describe('ClassificationRunner — stop() aborts in-flight LLM work', () => {
  let db: Database;
  let taxonomy: TaxonomyStore;
  let project: ProjectStore;
  let rules: RuleStore;
  let transactions: TransactionStore;
  let changelog: ChangelogStore;
  let classificationAgent: ClassificationAgent;
  let eventBus: EventBus;
  let supplierUniverse: SupplierUniverse;
  let suppliers: SupplierService;
  let runner: ClassificationRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    taxonomy = createMockTaxonomyStore();
    project = createMockProjectStore();
    rules = createMockRuleStore();
    transactions = createMockTransactionStore();
    changelog = createMockChangelogStore();
    classificationAgent = createMockClassificationAgent();
    eventBus = createMockEventBus();
    supplierUniverse = createMockSupplierUniverse();
    suppliers = createMockSupplierService();
    runner = new ClassificationRunner(
      db, taxonomy, project, rules, transactions, changelog,
      classificationAgent, eventBus, supplierUniverse, suppliers
    );
  });

  it('stop() interrupts an in-flight classifyL3 and prevents post-cancel DB writes', async () => {
    // Capture the signal handed to the agent so we can verify wiring + observe it.
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(classificationAgent.classifyL3).mockImplementation(async (input) => {
      capturedSignal = input.signal;
      // Block until aborted — simulates a real LLM HTTP request that respects the signal.
      await blockUntilAborted(input.signal);
      // Unreachable when cancellation works.
      throw new Error('classifyL3 returned without abort — cancellation broken');
    });

    // ── Wire up the rest of the world to look like a single supplier with one txn,
    //    fully eligible for AI classification (l1_l2_path populated).
    const taxonomyNodes = [
      { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3 as const, description: null, parentPath: 'Indirect|IT', createdAt: '' },
    ];
    const txn = {
      id: 'tx1', project_supplier_id: 'sup1', row_index: 0,
      spend_amount: 1000, classification_status: 'unclassified',
      gl_description: 'Adobe Software',
    };

    vi.mocked(db.all).mockImplementation(async (sql: string) => {
      if (sql.includes('DISTINCT')) return [{ id: 'sup1', supplier_name: 'Adobe' }];
      return [];
    });
    vi.mocked(db.get).mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT')) return { cnt: 1 };
      return undefined;
    });
    vi.mocked(transactions.queryBySupplier).mockResolvedValue([txn]);
    vi.mocked(transactions.getIdsBySupplier).mockResolvedValue(['tx1']);
    vi.mocked(suppliers.getProjectSupplier).mockResolvedValue({
      id: 'sup1', supplierName: 'Adobe', parentName: null, parentSupplierId: null,
      isTailSpend: false, isResearched: true, confirmationStatus: 'pending',
      supplierInfo: null, mappedTaxonomyPaths: null, l1L2Path: ['Indirect|IT'],
      universeMatch: false, createdAt: '',
    });
    vi.mocked(taxonomy.getNodes).mockResolvedValue(taxonomyNodes);
    vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
      if (key === 'company_context') return { industry: 'Tech' };
      if (key === 'column_priorities') return ['gl_description'];
      return null;
    });
    vi.mocked(transactions.getColumns).mockResolvedValue([
      'id', 'row_index', 'spend_amount', 'gl_description', 'classification_status', 'supplier_name',
    ]);
    vi.mocked(rules.evaluateRulesBulk).mockResolvedValue(new Map());

    // ── Kick off classification, then cancel after a tick.
    const runPromise = runner.classifyAll();

    // Wait long enough for classifyL3 to be in-flight.
    await tick(50);
    expect(classificationAgent.classifyL3).toHaveBeenCalled();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    const t0 = Date.now();
    await runner.stop();
    await runPromise; // should resolve cleanly via the early-return guards
    const elapsed = Date.now() - t0;

    // ── Assertions ──
    // 1. The signal that reached the agent was aborted.
    expect(capturedSignal!.aborted).toBe(true);

    // 2. Stop short-circuited fast — no waiting on a 60s LLM timeout.
    expect(elapsed).toBeLessThan(200);

    // 3. No `classified_by_ai` writes landed (the classification result never
    //    came back, and even if it had, the post-await guards would skip writes).
    const aiWrites = vi.mocked(transactions.updateTransactions).mock.calls.filter(
      ([params]) => (params as { classificationStatus?: string }).classificationStatus === 'classified_by_ai'
    );
    expect(aiWrites).toHaveLength(0);

    // 4. A 'cancelled' progress event was emitted.
    const cancelled = vi.mocked(eventBus.emit).mock.calls.find(
      ([channel, payload]) =>
        channel === 'classification:progress' &&
        (payload as { status?: string }).status === 'cancelled'
    );
    expect(cancelled).toBeDefined();

    // 5. Runner is no longer marked as running.
    expect(runner.getIsRunning()).toBe(false);
  });
});

// ─── 3. QCRunner.stop() aborts in-flight LLM review ──────────────────────────

describe('QCRunner — stop() aborts in-flight LLM work', () => {
  let db: Database;
  let transactions: TransactionStore;
  let eventBus: EventBus;
  let qcAgent: QCAgent;
  let supplierUniverse: SupplierUniverse;
  let project: ProjectStore;
  let taxonomy: TaxonomyStore;
  let suppliers: SupplierService;
  let runner: QCRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    transactions = createMockTransactionStore();
    eventBus = createMockEventBus();
    qcAgent = createMockQCAgent();
    supplierUniverse = createMockSupplierUniverse();
    project = createMockProjectStore();
    taxonomy = createMockTaxonomyStore();
    suppliers = createMockSupplierService();
    runner = new QCRunner(
      db, transactions, eventBus, qcAgent,
      supplierUniverse, project, taxonomy, suppliers
    );
  });

  it('stop() interrupts an in-flight qcAgent.review and prevents post-cancel writes', async () => {
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(qcAgent.review).mockImplementation(async (_input, options) => {
      capturedSignal = options?.signal;
      await blockUntilAborted(options?.signal);
      throw new Error('qcAgent.review returned without abort — cancellation broken');
    });

    // QC supplier list — must contain at least one supplier with classified data so the
    // runner reaches the LLM pass.
    vi.mocked(transactions.getColumns).mockResolvedValue([
      'id', 'spend_amount', 'classification_status',
    ]);
    vi.mocked(db.all).mockImplementation(async (sql: string) => {
      if (sql.includes('DISTINCT')) {
        return [{
          id: 'sup-1', supplier_name: 'Acme', is_tail_spend: false,
          is_researched: true, transaction_count: 5, total_spend: 10_000, num_categories: 2,
        }];
      }
      return [];
    });
    vi.mocked(transactions.getSpendByTaxonomy).mockResolvedValue([]);
    vi.mocked(transactions.getIdsBySupplier).mockResolvedValue(['tx1', 'tx2']);
    vi.mocked(transactions.queryBySupplier).mockResolvedValue([
      { id: 'tx1', spend_amount: 5000, classification_status: 'classified_by_ai' },
      { id: 'tx2', spend_amount: 5000, classification_status: 'classified_by_ai' },
    ]);

    const runPromise = runner.runQC({
      scope: [],
      algorithmic: { enabled: false, l3Threshold: 0.95, l2Threshold: 0.90 },
      llm: { enabled: true, gateConditions: [], rules: 'test rules' },
    });

    await tick(50);
    expect(qcAgent.review).toHaveBeenCalled();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    const t0 = Date.now();
    runner.stop();
    await runPromise;
    const elapsed = Date.now() - t0;

    expect(capturedSignal!.aborted).toBe(true);
    expect(elapsed).toBeLessThan(200);

    // No classified_by_qc_agent writes landed.
    const qcWrites = vi.mocked(transactions.updateTransactions).mock.calls.filter(
      ([params]) => (params as { classificationStatus?: string }).classificationStatus === 'classified_by_qc_agent'
    );
    expect(qcWrites).toHaveLength(0);
  });
});

// ─── 4. SupplierResearcher.cancel() aborts in-flight LLM call ────────────────

describe('SupplierResearcher — cancel() aborts in-flight LLM work', () => {
  let supplierUniverse: SupplierUniverse;
  let webSearch: WebSearch;
  let researchAgent: ResearchAgent;
  let eventBus: EventBus;
  let supplierService: SupplierService;
  let classificationAgent: ClassificationAgent;
  let transactions: TransactionStore;
  let catAAgent: CatAAgent;
  let taxonomyStore: TaxonomyStore;
  let ruleStore: RuleStore;
  let researcher: SupplierResearcher;

  beforeEach(() => {
    vi.clearAllMocks();
    supplierUniverse = createMockSupplierUniverse();
    webSearch = createMockWebSearch();
    researchAgent = createMockResearchAgent();
    eventBus = createMockEventBus();
    supplierService = createMockSupplierService();
    classificationAgent = createMockClassificationAgent();
    transactions = createMockTransactionStore();
    catAAgent = createMockCatAAgent();
    taxonomyStore = createMockTaxonomyStore();
    ruleStore = createMockRuleStore();
    researcher = new SupplierResearcher(
      supplierUniverse, webSearch, researchAgent, eventBus,
      supplierService, classificationAgent, transactions,
      catAAgent, taxonomyStore, ruleStore
    );
  });

  it('cancel() interrupts an in-flight selectCategories call (categorizeAll)', async () => {
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(classificationAgent.selectCategories).mockImplementation(async (input) => {
      capturedSignal = input.signal;
      await blockUntilAborted(input.signal);
      throw new Error('selectCategories returned without abort — cancellation broken');
    });

    // One non-tail-spend supplier with research info but no l1L2Path → eligible for selectCategories.
    vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
      {
        id: 'sup-1', supplierName: 'Acme', parentName: null, parentSupplierId: null,
        isTailSpend: false, isResearched: true, confirmationStatus: 'pending',
        supplierInfo: { supplierType: 'Corporation', industry: 'Tech' },
        mappedTaxonomyPaths: null, l1L2Path: null,
        universeMatch: false, createdAt: '',
      },
    ]);

    const runPromise = researcher.categorizeAll([], { industry: 'Tech' }, []);

    await tick(50);
    expect(classificationAgent.selectCategories).toHaveBeenCalled();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    const t0 = Date.now();
    researcher.cancel();
    await runPromise;
    const elapsed = Date.now() - t0;

    expect(capturedSignal!.aborted).toBe(true);
    expect(elapsed).toBeLessThan(200);

    // No supplier was updated with an l1L2Path (the result never came back).
    expect(supplierService.updateSupplier).not.toHaveBeenCalled();

    // A 'cancelled' progress event was emitted.
    const cancelled = vi.mocked(eventBus.emit).mock.calls.find(
      ([channel, payload]) =>
        channel === 'suppliers:research:progress' &&
        (payload as { status?: string }).status === 'cancelled'
    );
    expect(cancelled).toBeDefined();
  });
});
