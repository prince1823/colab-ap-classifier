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
    runner = new ClassificationRunner(
      db, taxonomy, project, rules, transactions, changelog,
      classificationAgent, eventBus, supplierUniverse
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
    categoryPath?: string;
    columnPriorities?: string[];
  }) {
    const supplierName = opts?.supplierName ?? 'Acme';
    const txns = opts?.txns ?? [{ id: 'tx1', project_supplier_id: 'sup1', row_index: 0, spend_amount: 1000, classification_status: 'unclassified' }];
    const categoryPath = opts?.categoryPath ?? 'Indirect|IT';
    const columnPriorities = opts?.columnPriorities ?? ['spend_amount'];

    vi.mocked(db.all).mockImplementation(async (sql: string) => {
      if (sql.includes('DISTINCT')) return [{ id: 'sup1', supplier_name: supplierName }];
      if (sql.includes('FROM transactions')) return txns;
      return [];
    });
    vi.mocked(db.get).mockImplementation(async (sql: string) => {
      if (sql.includes('supplier_parents')) return { supplier_name: supplierName, parent_name: null };
      if (sql.includes('COUNT')) return { cnt: txns.length };
      return undefined;
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
    vi.mocked(classificationAgent.selectCategories).mockResolvedValue(new Map([[1, categoryPath]]));
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
      // When all txns match rules, Call 1 and Call 2 should not be invoked
      expect(classificationAgent.selectCategories).not.toHaveBeenCalled();
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

    it('should mark transactions as error when Call 1 returns no category', async () => {
      setupBasicMocks();
      vi.mocked(classificationAgent.selectCategories).mockResolvedValue(new Map());

      await runner.classifyAll();

      // Should mark as error since no category was resolved
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ classificationStatus: 'classification_error' }),
        'pipeline'
      );
    });
  });

  describe('two-call architecture', () => {
    it('should call selectCategories (Call 1) then classifyL3 (Call 2)', async () => {
      setupBasicMocks();

      await runner.classifyAll();

      // Call 1 should be called
      expect(classificationAgent.selectCategories).toHaveBeenCalledWith(
        expect.objectContaining({
          suppliers: expect.arrayContaining([
            expect.objectContaining({ name: 'Acme' }),
          ]),
        })
      );

      // Call 2 should receive the category from Call 1
      expect(classificationAgent.classifyL3).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryPath: 'Indirect|IT',
          supplierName: 'Acme',
        })
      );
    });

    it('should filter taxonomy to L3 nodes under selected category for Call 2', async () => {
      setupBasicMocks({ categoryPath: 'Indirect|IT' });

      await runner.classifyAll();

      const call2Args = vi.mocked(classificationAgent.classifyL3).mock.calls[0][0];
      expect(call2Args.l3Taxonomy).toEqual([
        expect.objectContaining({ fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT' }),
      ]);
    });

    it('should retry individual suppliers when batch Call 1 misses them', async () => {
      setupBasicMocks();
      // Two suppliers
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) return [
          { id: 'sup1', supplier_name: 'SupA' },
          { id: 'sup2', supplier_name: 'SupB' },
        ];
        if (sql.includes('FROM transactions') && sql.includes('project_supplier_id')) {
          return [{ id: 'tx1', project_supplier_id: 'sup1', spend_amount: 1000, classification_status: 'unclassified' }];
        }
        return [];
      });
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_parents') && sql.includes('sup1')) return { supplier_name: 'SupA', parent_name: null };
        if (sql.includes('supplier_parents') && sql.includes('sup2')) return { supplier_name: 'SupB', parent_name: null };
        if (sql.includes('supplier_parents')) return { supplier_name: 'SupA', parent_name: null };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });

      // First batch returns only supplier 1; supplier 2 missing
      vi.mocked(classificationAgent.selectCategories)
        .mockResolvedValueOnce(new Map([[1, 'Indirect|IT']]))
        .mockResolvedValueOnce(new Map([[1, 'Indirect|Facilities']]));

      await runner.classifyAll();

      // selectCategories should be called at least twice (batch + individual retry)
      expect(classificationAgent.selectCategories).toHaveBeenCalledTimes(2);
    });
  });

  describe('supplier_name as column priority', () => {
    it('should send canonical supplier_name to LLM', async () => {
      setupBasicMocks({
        supplierName: 'Acme Inc',
        txns: [
          { id: 'tx1', project_supplier_id: 'sup1', supplier_name: 'ACME Corp', spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
          { id: 'tx2', project_supplier_id: 'sup1', supplier_name: 'Acme Corporation', spend_amount: 2000, gl_description: 'Software', classification_status: 'unclassified' },
        ],
        columnPriorities: ['supplier_name', 'gl_description'],
      });

      await runner.classifyAll();

      const call2Args = vi.mocked(classificationAgent.classifyL3).mock.calls[0][0];
      // Both transactions should carry the canonical name
      expect(call2Args.transactions[0]).toHaveProperty('supplier_name', 'Acme Inc');
      expect(call2Args.transactions[1]).toHaveProperty('supplier_name', 'Acme Inc');
    });
  });

  describe('parent name injection', () => {
    function setupParentTest(parentName: string | null, universeParent: string | null) {
      setupBasicMocks();
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_parents')) return { supplier_name: 'SubCo', parent_name: parentName };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(
        universeParent ? { parentCompanyName: universeParent } : null
      );
    }

    it('should resolve parent name from supplier_parents table', async () => {
      setupParentTest('ParentCorp', null);
      await runner.classifyAll();

      const call1Args = vi.mocked(classificationAgent.selectCategories).mock.calls[0][0];
      expect(call1Args.suppliers[0].parentName).toBe('ParentCorp');
    });

    it('should fall back to supplierResearch.parentCompanyName', async () => {
      setupParentTest(null, 'UniverseParent');
      await runner.classifyAll();

      const call1Args = vi.mocked(classificationAgent.selectCategories).mock.calls[0][0];
      expect(call1Args.suppliers[0].parentName).toBe('UniverseParent');
    });

    it('should return null when neither source has a parent', async () => {
      setupParentTest(null, null);
      await runner.classifyAll();

      const call1Args = vi.mocked(classificationAgent.selectCategories).mock.calls[0][0];
      expect(call1Args.suppliers[0].parentName).toBeNull();
    });
  });

  describe('research warning', () => {
    it('should log warning when supplier is_researched but no universe data found', async () => {
      setupBasicMocks();
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_parents')) return { supplier_name: 'Acme', parent_name: null, is_researched: true };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });
      // supplierUniverse.getSupplier returns null by default

      await runner.classifyAll();

      expect(debugLog).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('marked as researched')
      );
    });

    it('should NOT log research warning when universe data exists', async () => {
      setupBasicMocks();
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_parents')) return { supplier_name: 'Acme', parent_name: null, is_researched: true };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue({ supplierType: 'IT Services' });

      await runner.classifyAll();

      const warnCalls = vi.mocked(debugLog).mock.calls.filter(
        ([level, msg]) => level === 'WARN' && typeof msg === 'string' && msg.includes('marked as researched')
      );
      expect(warnCalls).toHaveLength(0);
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
        if (sql.includes('FROM transactions')) {
          return [{ id: 'tx1', project_supplier_id: 'sup1', spend_amount: 1000, classification_status: 'unclassified' }];
        }
        return [];
      });
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_parents')) return { supplier_name: 'FailSupplier', parent_name: null, is_researched: false };
        if (sql.includes('COUNT')) return { cnt: 2 };
        return undefined;
      });

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
        expect.objectContaining({ status: 'stopped' })
      );

      resolveQuery([]);
      await run.catch(() => {});
    });
  });
});
