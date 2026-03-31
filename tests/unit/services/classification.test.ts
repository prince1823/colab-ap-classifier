import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debugLog } from '../../../src/main/utils/debug-log';
import { ClassificationRunner } from '../../../src/main/services/classification';

vi.mock('../../../src/main/utils/debug-log', () => ({
  debugLog: vi.fn(),
}));
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
} from '../../helpers/mock-services';
import type {
  Database,
  TaxonomyStore,
  ProjectStore,
  RuleStore,
  TransactionStore,
  ChangelogStore,
  ClassificationAgent,
  EventBus,
  SupplierUniverse,
  SupplierService,
} from '../../../src/shared/types/services';

describe('ClassificationRunner', () => {
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

  afterEach(async () => {
    if (runner.getIsRunning()) {
      runner.stop();
    }
  });

  const taxonomyNodes = [
    { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
    { id: 'tid2', fullPath: 'Indirect|Facilities|Cleaning', l1: 'Indirect', l2: 'Facilities', l3: 'Cleaning', depth: 3, description: null, parentPath: 'Indirect|Facilities', createdAt: '' },
  ];

  function setupBasicMocks(opts?: {
    supplierName?: string;
    txns?: Record<string, unknown>[];
    l1L2Path?: string | null;
    isTailSpend?: boolean;
    columnPriorities?: string[];
  }) {
    const supplierName = opts?.supplierName ?? 'Acme';
    const txns = opts?.txns ?? [{ id: 'tx1', project_supplier_id: 'sup1', row_index: 0, spend_amount: 1000, classification_status: 'unclassified' }];
    const l1L2Path = opts?.l1L2Path !== undefined ? opts.l1L2Path : 'Indirect|IT';
    const l1L2Paths = l1L2Path ? [l1L2Path] : null;
    const isTailSpend = opts?.isTailSpend ?? false;
    const columnPriorities = opts?.columnPriorities ?? ['spend_amount'];

    vi.mocked(db.all).mockImplementation(async (sql: string) => {
      if (sql.includes('DISTINCT')) return [{ id: 'sup1', supplier_name: supplierName }];
      return [];
    });
    vi.mocked(db.get).mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT')) return { cnt: txns.length };
      return undefined;
    });
    vi.mocked(transactions.queryBySupplier).mockResolvedValue(txns);
    vi.mocked(transactions.getIdsBySupplier).mockResolvedValue(txns.map((t) => String(t.id)));
    vi.mocked(suppliers.getProjectSupplier).mockResolvedValue({
      id: 'sup1', supplierName, parentName: null, parentSupplierId: null,
      isTailSpend, isResearched: false, confirmationStatus: 'pending',
      supplierInfo: null, mappedTaxonomyPaths: null, l1L2Path: l1L2Paths,
      universeMatch: false, createdAt: '',
    });
    vi.mocked(taxonomy.getNodes).mockResolvedValue(taxonomyNodes);
    vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
      if (key === 'company_context') return { industry: 'Tech' };
      if (key === 'column_priorities') return columnPriorities;
      return null;
    });
    vi.mocked(transactions.getColumns).mockResolvedValue([
      'id', 'row_index', 'spend_amount', 'gl_description', 'classification_status', 'supplier_name',
    ]);
    vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());
    vi.mocked(classificationAgent.classifyL3).mockResolvedValue({
      classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
      assignments: { '1': [1] },
    });
  }

  describe('getIsRunning', () => {
    it('should return false initially', () => {
      expect(runner.getIsRunning()).toBe(false);
    });
  });

  describe('classifyAll', () => {
    it('should complete with no unclassified suppliers', async () => {
      vi.mocked(db.all).mockResolvedValue([]);
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockResolvedValue(null);

      await runner.classifyAll();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({ status: 'completed', totalSuppliers: 0, percentage: 100 })
      );
    });

    it('should reject if already running', async () => {
      let resolveQuery!: (value: unknown[]) => void;
      vi.mocked(db.all).mockImplementation(async () => {
        return new Promise<unknown[]>((resolve) => { resolveQuery = resolve; });
      });
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockResolvedValue(null);

      const firstRun = runner.classifyAll();
      await new Promise(r => setTimeout(r, 10));

      await expect(runner.classifyAll()).rejects.toThrow('Classification is already running');
      resolveQuery([]);
      await firstRun.catch(() => {});
    });

    it('should emit progress events', async () => {
      setupBasicMocks();

      await runner.classifyAll();

      const emitCalls = vi.mocked(eventBus.emit).mock.calls
        .filter(([channel]) => channel === 'classification:progress');

      const statuses = emitCalls.map(([, progress]) => (progress as any).status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
    });

    it('should throw if column_priorities are not configured', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) return [{ id: 'sup1', supplier_name: 'Acme' }];
        return [];
      });
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return null;
        return null;
      });

      await expect(runner.classifyAll()).rejects.toThrow('Column priorities must be configured');
    });

    it('should apply override rules before AI classification', async () => {
      setupBasicMocks();

      const ruleMatch = new Map([
        ['tx1', { ruleId: 'rule-1', targetTaxonomyNodeId: 'tid1' }],
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(ruleMatch);

      await runner.classifyAll();

      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['tx1'],
          classificationStatus: 'classified_by_rule',
          appliedRuleId: 'rule-1',
        }),
        'rule'
      );
      // When all txns match rules, classifyL3 should not be invoked
      expect(classificationAgent.classifyL3).not.toHaveBeenCalled();
    });

    it('should use column_priorities from project settings', async () => {
      setupBasicMocks({ columnPriorities: ['spend_amount'] });

      await runner.classifyAll();

      expect(classificationAgent.classifyL3).toHaveBeenCalledWith(
        expect.objectContaining({ columnPriorities: ['spend_amount'] })
      );
    });

    it('should handle multi-classification with assignments mapping different groups', async () => {
      setupBasicMocks({
        txns: [
          { id: 'tx1', project_supplier_id: 'sup1', row_index: 0, spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
          { id: 'tx2', project_supplier_id: 'sup1', row_index: 1, spend_amount: 2000, gl_description: 'Cleaning', classification_status: 'unclassified' },
        ],
        columnPriorities: ['spend_amount', 'gl_description'],
      });

      vi.mocked(classificationAgent.classifyL3).mockResolvedValue({
        classifications: [
          { id: 1, classificationPath: 'Indirect|IT|Software' },
          { id: 2, classificationPath: 'Indirect|IT|Software' },
        ],
        assignments: { '1': [1], '2': [2] },
      });

      await runner.classifyAll();

      const updateCalls = vi.mocked(transactions.updateTransactions).mock.calls;
      const pipelineCalls = updateCalls.filter(([, source]) => source === 'pipeline');
      expect(pipelineCalls.length).toBe(2);
    });

    it('should retry on agent error and succeed on second attempt', async () => {
      setupBasicMocks();

      vi.mocked(classificationAgent.classifyL3)
        .mockRejectedValueOnce(new Error('Temporary LLM error'))
        .mockResolvedValueOnce({
          classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
          assignments: { '1': [1] },
        });

      await runner.classifyAll();

      expect(classificationAgent.classifyL3).toHaveBeenCalledTimes(2);
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ classificationStatus: 'classified_by_ai' }),
        'pipeline'
      );
    });

    it('should mark transactions as classification_error after max retries exceeded', async () => {
      setupBasicMocks();

      vi.mocked(classificationAgent.classifyL3)
        .mockRejectedValue(new Error('Persistent LLM error'));

      await runner.classifyAll();

      expect(classificationAgent.classifyL3).toHaveBeenCalledTimes(3);
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['tx1'],
          classificationStatus: 'classification_error',
        }),
        'pipeline'
      );
    });

    it('should mark transactions as error when l1_l2_path is null', async () => {
      setupBasicMocks({ l1L2Path: null });

      await runner.classifyAll();

      // Should mark as error since l1_l2_path is null
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ classificationStatus: 'classification_error' }),
        'pipeline'
      );
      // classifyL3 should not be called
      expect(classificationAgent.classifyL3).not.toHaveBeenCalled();
    });
  });

  describe('l1_l2_path-based classification', () => {
    it('should read l1_l2_path from project_suppliers and pass to classifyL3', async () => {
      setupBasicMocks({ l1L2Path: 'Indirect|IT' });

      await runner.classifyAll();

      // selectCategories should NOT be called (removed)
      expect(classificationAgent.selectCategories).not.toHaveBeenCalled();

      // classifyL3 should receive the stored l1_l2_paths
      expect(classificationAgent.classifyL3).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryPaths: ['Indirect|IT'],
          supplierName: 'Acme',
        })
      );
    });

    it('should filter taxonomy to L3 nodes under stored l1_l2_path', async () => {
      setupBasicMocks({ l1L2Path: 'Indirect|IT' });

      await runner.classifyAll();

      const call2Args = vi.mocked(classificationAgent.classifyL3).mock.calls[0][0];
      expect(call2Args.l3Taxonomy).toEqual([
        expect.objectContaining({ fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT' }),
      ]);
    });

    it('should mark supplier as error when l1_l2_path is null and log warning', async () => {
      setupBasicMocks({ l1L2Path: null });

      await runner.classifyAll();

      expect(classificationAgent.classifyL3).not.toHaveBeenCalled();
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ classificationStatus: 'classification_error' }),
        'pipeline'
      );
      expect(debugLog).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('l1_l2_paths missing')
      );
    });

    it('should handle tail spend suppliers with l1_l2_path via classifyL3ForTailSpend', async () => {
      setupBasicMocks({ isTailSpend: true, l1L2Path: 'Indirect|IT' });
      vi.mocked(classificationAgent.classifyL3ForTailSpend).mockResolvedValue(
        new Map([[1, 'Indirect|IT|Software']])
      );

      await runner.classifyAll();

      // Should use tail spend path, not regular classifyL3
      expect(classificationAgent.classifyL3).not.toHaveBeenCalled();
      expect(classificationAgent.classifyL3ForTailSpend).toHaveBeenCalled();
    });

    it('should mark tail spend as error when l1_l2_path is null', async () => {
      setupBasicMocks({ isTailSpend: true, l1L2Path: null });

      await runner.classifyAll();

      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ classificationStatus: 'classification_error' }),
        'pipeline'
      );
      expect(debugLog).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('l1_l2_paths missing')
      );
    });
  });

  describe('supplier_name as column priority', () => {
    it('should strip supplier_name from column_priorities and not inject it onto transaction rows', async () => {
      // supplier_name is a virtual column — it must be stripped from priorities before dedup
      // grouping. The canonical name reaches the LLM as a top-level parameter, not per-row.
      setupBasicMocks({
        supplierName: 'Acme Inc',
        txns: [
          { id: 'tx1', project_supplier_id: 'sup1', spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
          { id: 'tx2', project_supplier_id: 'sup1', spend_amount: 2000, gl_description: 'Hardware', classification_status: 'unclassified' },
        ],
        columnPriorities: ['supplier_name', 'gl_description'],
      });

      await runner.classifyAll();

      // Classification should still proceed (supplier_name stripped silently)
      expect(classificationAgent.classifyL3).toHaveBeenCalled();
      const call2Args = vi.mocked(classificationAgent.classifyL3).mock.calls[0][0];
      // supplier_name must NOT be injected onto transaction rows
      expect(call2Args.transactions[0]).not.toHaveProperty('supplier_name');
      expect(call2Args.transactions[1]).not.toHaveProperty('supplier_name');
      // The supplier name is passed as a top-level parameter to the agent instead
      expect(call2Args).toHaveProperty('supplierName', 'Acme Inc');
    });
  });

  describe('supplier research in Call 2', () => {
    it('should pass supplier research to classifyL3 when available', async () => {
      setupBasicMocks();
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue({ supplierType: 'company', industry: 'Tech' });

      await runner.classifyAll();

      expect(classificationAgent.classifyL3).toHaveBeenCalledWith(
        expect.objectContaining({
          supplierType: 'company',
        })
      );
    });

    it('should pass null supplierType when no universe data exists', async () => {
      setupBasicMocks();
      // supplierUniverse.getSupplier returns null by default

      await runner.classifyAll();

      expect(classificationAgent.classifyL3).toHaveBeenCalledWith(
        expect.objectContaining({
          supplierType: null,
        })
      );
    });
  });

  describe('Call 2 error resilience', () => {
    it('should continue to next supplier when markSupplierError fails', async () => {
      setupBasicMocks();
      // Two suppliers
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) return [
          { id: 'sup1', supplier_name: 'FailSupplier' },
          { id: 'sup2', supplier_name: 'GoodSupplier' },
        ];
        return [];
      });
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT')) return { cnt: 2 };
        return undefined;
      });
      vi.mocked(suppliers.getProjectSupplier).mockImplementation(async (id: string) => ({
        id, supplierName: id === 'sup1' ? 'FailSupplier' : 'GoodSupplier',
        parentName: null, parentSupplierId: null,
        isTailSpend: false, isResearched: false, confirmationStatus: 'pending' as const,
        supplierInfo: null, mappedTaxonomyPaths: null, l1L2Path: ['Indirect|IT'],
        universeMatch: false, createdAt: '',
      }));
      vi.mocked(transactions.queryBySupplier).mockResolvedValue([
        { id: 'tx1', project_supplier_id: 'sup1', spend_amount: 1000, classification_status: 'unclassified' },
      ]);
      vi.mocked(transactions.getIdsBySupplier).mockResolvedValue(['tx1']);

      // Call 2 fails for first supplier, and markSupplierError also fails
      let classifyCallCount = 0;
      vi.mocked(classificationAgent.classifyL3).mockImplementation(async () => {
        classifyCallCount++;
        if (classifyCallCount <= 3) throw new Error('LLM failure'); // 3 retries for first supplier
        return { classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }], assignments: { '1': [1] } };
      });
      vi.mocked(transactions.updateTransactions).mockImplementation(async (update) => {
        if (update.classificationStatus === 'classification_error') {
          throw new Error('DB write failure');
        }
      });

      await runner.classifyAll();

      // Should complete without throwing
      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should increment progress even when both classification and error marking fail', async () => {
      setupBasicMocks();
      // classifyL3 always fails (3 retries exhausted)
      vi.mocked(classificationAgent.classifyL3).mockRejectedValue(new Error('LLM failure'));
      // markSupplierError also fails
      vi.mocked(transactions.updateTransactions).mockImplementation(async (update) => {
        if (update.classificationStatus === 'classification_error') {
          throw new Error('DB write failure');
        }
      });

      await runner.classifyAll();

      // Should still complete — processedSuppliers incremented via finally
      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({ status: 'completed' })
      );
    });
  });

  describe('stop', () => {
    it('should emit stopped progress', async () => {
      let resolveQuery!: (value: unknown[]) => void;
      vi.mocked(db.all).mockImplementation(async () => {
        return new Promise<unknown[]>((resolve) => { resolveQuery = resolve; });
      });
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockResolvedValue(null);

      const run = runner.classifyAll();
      await new Promise(r => setTimeout(r, 10));

      await runner.stop();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({ status: 'cancelled' })
      );

      resolveQuery([]);
      await run.catch(() => {});
    });
  });
});
