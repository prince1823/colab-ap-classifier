import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClassificationRunner } from '../../../src/main/services/classification';
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
      runner.cancel();
    }
  });

  describe('getIsRunning', () => {
    it('should return false initially', () => {
      expect(runner.getIsRunning()).toBe(false);
    });
  });

  describe('classifyAll', () => {
    it('should complete with no unclassified suppliers', async () => {
      // No project_suppliers with unclassified transactions
      vi.mocked(db.all).mockResolvedValue([]);
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockResolvedValue(null);

      await runner.classifyAll();

      // Should emit completed progress
      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({
          status: 'completed',
          totalSuppliers: 0,
          percentage: 100,
        })
      );
    });

    it('should reject if already running', async () => {
      // Make a slow-resolving query so classifyAll doesn't finish immediately
      let resolveQuery!: (value: unknown[]) => void;
      vi.mocked(db.all).mockImplementation(async () => {
        return new Promise<unknown[]>((resolve) => { resolveQuery = resolve; });
      });
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockResolvedValue(null);

      const firstRun = runner.classifyAll();
      // Small delay for isRunning to be set
      await new Promise(r => setTimeout(r, 10));

      await expect(runner.classifyAll()).rejects.toThrow(
        'Classification is already running'
      );

      // Resolve the first query so the first run completes
      resolveQuery([]);
      await firstRun;
    });

    it('should classify suppliers and emit progress events', async () => {
      // Return one supplier with unclassified transactions
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'Acme' }];
        }
        if (sql.includes('FROM transactions')) {
          return [{
            id: 'tx1',
            project_supplier_id: 'sup1',
            row_index: 0,
            spend_amount: 1000,
            gl_description: 'Software license',
            classification_status: 'unclassified',
          }];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'Acme' };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });

      vi.mocked(taxonomy.getNodes).mockResolvedValue([{
        id: 'tid1', fullPath: 'Indirect|IT|Software',
        l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount', 'gl_description'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'gl_description', 'classification_status',
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
        assignments: { '1': [1] },
      });

      await runner.classifyAll();

      // Classification agent should have been called
      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalled();

      // Progress events should have been emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should apply override rules before LLM classification', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'Acme' }];
        }
        if (sql.includes('FROM transactions')) {
          return [
            { id: 'tx1', project_supplier_id: 'sup1', row_index: 0, spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
            { id: 'tx2', project_supplier_id: 'sup1', row_index: 1, spend_amount: 5000, gl_description: 'Cloud', classification_status: 'unclassified' },
          ];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'Acme' };
        if (sql.includes('COUNT')) return { cnt: 2 };
        return undefined;
      });

      vi.mocked(taxonomy.getNodes).mockResolvedValue([{
        id: 'tid1', fullPath: 'Indirect|IT|Software',
        l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount', 'gl_description'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'gl_description', 'classification_status',
      ]);

      // Rule matches tx1 only
      vi.mocked(rules.evaluateRules).mockResolvedValue(
        new Map([['tx1', { ruleId: 'rule1', targetTaxonomyNodeId: 'tid1' }]])
      );
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
        assignments: { '1': [1] },
      });

      await runner.classifyAll();

      // evaluateRules should have been called
      expect(rules.evaluateRules).toHaveBeenCalled();

      // Transaction update should have been called for rule-matched tx
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['tx1'],
          classificationStatus: 'classified_by_rule',
        }),
        'rule'
      );

      // AI classification should be called for remaining tx
      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalled();
    });

    it('should throw when column_priorities setting is missing', async () => {
      vi.mocked(db.all).mockResolvedValue([{ id: 'sup1', supplier_name: 'Acme' }]);
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return null;
        return null;
      });

      await expect(runner.classifyAll()).rejects.toThrow(
        'Column priorities must be configured'
      );
    });

    it('should throw when column_priorities is an empty array', async () => {
      vi.mocked(db.all).mockResolvedValue([{ id: 'sup1', supplier_name: 'Acme' }]);
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return [];
        return null;
      });

      await expect(runner.classifyAll()).rejects.toThrow(
        'Column priorities must be configured'
      );
    });

    it('should throw when column_priorities contains non-existent columns', async () => {
      vi.mocked(db.all).mockResolvedValue([{ id: 'sup1', supplier_name: 'Acme' }]);
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount', 'nonexistent_col'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'classification_status',
      ]);

      await expect(runner.classifyAll()).rejects.toThrow(
        'Column priorities contain columns not found in transactions table: nonexistent_col'
      );
    });

    it('should pass column priorities through to classification agent', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'Acme' }];
        }
        if (sql.includes('FROM transactions')) {
          return [{
            id: 'tx1',
            project_supplier_id: 'sup1',
            row_index: 0,
            spend_amount: 1000,
            classification_status: 'unclassified',
          }];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'Acme' };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });

      vi.mocked(taxonomy.getNodes).mockResolvedValue([{
        id: 'tid1', fullPath: 'Indirect|IT|Software',
        l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'classification_status',
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
        assignments: { '1': [1] },
      });

      await runner.classifyAll();

      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          columnPriorities: ['spend_amount'],
        })
      );
    });

    it('should handle multi-classification with assignments mapping different groups', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'MultiCo' }];
        }
        if (sql.includes('FROM transactions')) {
          return [
            { id: 'tx1', project_supplier_id: 'sup1', row_index: 0, spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
            { id: 'tx2', project_supplier_id: 'sup1', row_index: 1, spend_amount: 2000, gl_description: 'Cleaning', classification_status: 'unclassified' },
          ];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'MultiCo' };
        if (sql.includes('COUNT')) return { cnt: 2 };
        return undefined;
      });

      const taxonomyNodes = [
        { id: 'tid1', fullPath: 'Indirect|IT|Software', l1: 'Indirect', l2: 'IT', l3: 'Software', depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '' },
        { id: 'tid2', fullPath: 'Indirect|Facilities|Cleaning', l1: 'Indirect', l2: 'Facilities', l3: 'Cleaning', depth: 3, description: null, parentPath: 'Indirect|Facilities', createdAt: '' },
      ];
      vi.mocked(taxonomy.getNodes).mockResolvedValue(taxonomyNodes);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount', 'gl_description'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'gl_description', 'classification_status',
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());

      // Agent returns 2 classifications with different assignments
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [
          { id: 1, classificationPath: 'Indirect|IT|Software' },
          { id: 2, classificationPath: 'Indirect|Facilities|Cleaning' },
        ],
        assignments: { '1': [1], '2': [2] },
      });

      await runner.classifyAll();

      // updateTransactions should be called for each classification
      const updateCalls = vi.mocked(transactions.updateTransactions).mock.calls;
      const pipelineCalls = updateCalls.filter(([, source]) => source === 'pipeline');
      expect(pipelineCalls.length).toBe(2);
    });

    it('should retry on agent error and succeed on second attempt', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'RetryCo' }];
        }
        if (sql.includes('FROM transactions')) {
          return [{
            id: 'tx1',
            project_supplier_id: 'sup1',
            row_index: 0,
            spend_amount: 1000,
            classification_status: 'unclassified',
          }];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'RetryCo' };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });

      vi.mocked(taxonomy.getNodes).mockResolvedValue([{
        id: 'tid1', fullPath: 'Indirect|IT|Software',
        l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'classification_status',
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());

      // First call throws, second succeeds
      vi.mocked(classificationAgent.classifyInvoiceGroup)
        .mockRejectedValueOnce(new Error('Temporary LLM error'))
        .mockResolvedValueOnce({
          classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
          assignments: { '1': [1] },
        });

      await runner.classifyAll();

      // Agent should have been called twice (retry)
      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalledTimes(2);

      // Transaction should be classified successfully
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          classificationStatus: 'classified_by_ai',
        }),
        'pipeline'
      );
    });

    it('should mark transactions as classification_error after max retries exceeded', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'FailCo' }];
        }
        if (sql.includes('FROM transactions')) {
          return [{
            id: 'tx1',
            project_supplier_id: 'sup1',
            row_index: 0,
            spend_amount: 1000,
            classification_status: 'unclassified',
          }];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'FailCo' };
        if (sql.includes('COUNT')) return { cnt: 0 };
        return undefined;
      });

      vi.mocked(taxonomy.getNodes).mockResolvedValue([{
        id: 'tid1', fullPath: 'Indirect|IT|Software',
        l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'classification_status',
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());

      // All 3 attempts fail
      vi.mocked(classificationAgent.classifyInvoiceGroup)
        .mockRejectedValue(new Error('Persistent LLM error'));

      await runner.classifyAll();

      // Agent should have been called 3 times (max retries)
      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalledTimes(3);

      // Transaction should be marked as classification_error
      expect(transactions.updateTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['tx1'],
          classificationStatus: 'classification_error',
        }),
        'pipeline'
      );
    });

    it('should not pass historicalClassifications to agent', async () => {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) {
          return [{ id: 'sup1', supplier_name: 'Acme' }];
        }
        if (sql.includes('FROM transactions')) {
          return [{
            id: 'tx1',
            project_supplier_id: 'sup1',
            row_index: 0,
            spend_amount: 1000,
            classification_status: 'unclassified',
          }];
        }
        return [];
      });

      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return { supplier_name: 'Acme' };
        if (sql.includes('COUNT')) return { cnt: 1 };
        return undefined;
      });

      vi.mocked(taxonomy.getNodes).mockResolvedValue([{
        id: 'tid1', fullPath: 'Indirect|IT|Software',
        l1: 'Indirect', l2: 'IT', l3: 'Software',
        depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue([
        'id', 'row_index', 'spend_amount', 'classification_status',
      ]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
        assignments: { '1': [1] },
      });

      await runner.classifyAll();

      const agentCallArgs = vi.mocked(classificationAgent.classifyInvoiceGroup).mock.calls[0][0];
      expect(agentCallArgs).not.toHaveProperty('historicalClassifications');
    });
  });

  describe('supplier_name as column priority', () => {
    const taxonomyNode = {
      id: 'tid1', fullPath: 'Indirect|IT|Software',
      l1: 'Indirect', l2: 'IT', l3: 'Software',
      depth: 3, description: null, parentPath: 'Indirect|IT', createdAt: '',
    };

    function setupSupplierTest(supplierName: string, txns: Record<string, unknown>[]) {
      vi.mocked(db.all).mockImplementation(async (sql: string) => {
        if (sql.includes('DISTINCT')) return [{ id: 'sup1', supplier_name: supplierName }];
        if (sql.includes('FROM transactions')) return txns;
        return [];
      });
      vi.mocked(db.get).mockImplementation(async (sql: string) => {
        if (sql.includes('supplier_name')) return supplierName ? { supplier_name: supplierName } : undefined;
        if (sql.includes('COUNT')) return { cnt: txns.length };
        return undefined;
      });
      vi.mocked(taxonomy.getNodes).mockResolvedValue([taxonomyNode]);
      vi.mocked(rules.evaluateRules).mockResolvedValue(new Map());
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [{ id: 1, classificationPath: 'Indirect|IT|Software' }],
        assignments: { '1': [1] },
      });
    }

    it('should succeed when supplier_name is not in column priorities', async () => {
      setupSupplierTest('Acme Inc', [{
        id: 'tx1', project_supplier_id: 'sup1', supplier_name: 'ACME Corp',
        spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['spend_amount', 'gl_description'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue(['id', 'spend_amount', 'gl_description', 'classification_status', 'supplier_name']);

      await runner.classifyAll();

      const agentArgs = vi.mocked(classificationAgent.classifyInvoiceGroup).mock.calls[0][0];
      expect(agentArgs.columnPriorities).toEqual(['spend_amount', 'gl_description']);
      // Even though supplier_name is not in priorities, the canonical name is still injected
      expect(agentArgs.transactions[0]).toHaveProperty('supplier_name', 'Acme Inc');
    });

    it('should send canonical supplier_name to LLM when two aliases map to one project supplier', async () => {
      setupSupplierTest('Acme Inc', [
        { id: 'tx1', project_supplier_id: 'sup1', supplier_name: 'Acme Inc', original_supplier_name: 'ACME Corp', spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
        { id: 'tx2', project_supplier_id: 'sup1', supplier_name: 'Acme Inc', original_supplier_name: 'Acme Corporation', spend_amount: 2000, gl_description: 'Software', classification_status: 'unclassified' },
      ]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['supplier_name', 'gl_description'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue(['id', 'spend_amount', 'gl_description', 'classification_status', 'supplier_name']);

      await runner.classifyAll();

      const agentArgs = vi.mocked(classificationAgent.classifyInvoiceGroup).mock.calls[0][0];
      // Both transactions should carry the canonical name, not the raw aliases
      expect(agentArgs.transactions[0]).toHaveProperty('supplier_name', 'Acme Inc');
      expect(agentArgs.transactions[1]).toHaveProperty('supplier_name', 'Acme Inc');
    });

    it('should not crash when supplier_name is null (orphaned transaction)', async () => {
      setupSupplierTest('', [{
        id: 'tx1', project_supplier_id: 'sup1', supplier_name: null,
        spend_amount: 500, gl_description: 'Misc', classification_status: 'unclassified',
      }]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['supplier_name', 'spend_amount'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue(['id', 'spend_amount', 'classification_status', 'supplier_name']);

      await expect(runner.classifyAll()).resolves.not.toThrow();
      // supplier_name is null so extractFields filters it out — agent is still called
      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalled();
    });

    it('should produce two dedup groups when aliases share supplier_name but differ in another priority column', async () => {
      setupSupplierTest('Acme Inc', [
        { id: 'tx1', project_supplier_id: 'sup1', supplier_name: 'Acme Inc', original_supplier_name: 'ACME Corp', gl_description: 'Software', classification_status: 'unclassified' },
        { id: 'tx2', project_supplier_id: 'sup1', supplier_name: 'Acme Inc', original_supplier_name: 'Acme Corporation', gl_description: 'Hardware', classification_status: 'unclassified' },
      ]);
      vi.mocked(project.getSetting).mockImplementation(async (key: string) => {
        if (key === 'company_context') return { industry: 'Tech' };
        if (key === 'column_priorities') return ['supplier_name', 'gl_description'];
        return null;
      });
      vi.mocked(transactions.getColumns).mockResolvedValue(['id', 'gl_description', 'classification_status', 'supplier_name']);
      // Two different paths for the two groups
      vi.mocked(classificationAgent.classifyInvoiceGroup).mockResolvedValue({
        classifications: [
          { id: 1, classificationPath: 'Indirect|IT|Software' },
          { id: 2, classificationPath: 'Indirect|IT|Software' },
        ],
        assignments: { '1': [1], '2': [2] },
      });

      await runner.classifyAll();

      const agentArgs = vi.mocked(classificationAgent.classifyInvoiceGroup).mock.calls[0][0];
      // Both transactions passed through; they differ on gl_description so dedup produces 2 groups
      expect(agentArgs.transactions).toHaveLength(2);
      expect(agentArgs.transactions[0]).toHaveProperty('gl_description', 'Software');
      expect(agentArgs.transactions[1]).toHaveProperty('gl_description', 'Hardware');
    });
  });

  describe('cancel', () => {
    it('should emit cancelled progress', async () => {
      let resolveQuery!: (value: unknown[]) => void;
      vi.mocked(db.all).mockImplementation(async () => {
        return new Promise<unknown[]>((resolve) => { resolveQuery = resolve; });
      });
      vi.mocked(taxonomy.getNodes).mockResolvedValue([]);
      vi.mocked(project.getSetting).mockResolvedValue(null);

      const run = runner.classifyAll();
      await new Promise(r => setTimeout(r, 10));

      await runner.cancel();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'classification:progress',
        expect.objectContaining({ status: 'cancelled' })
      );

      // Resolve the query so the run completes
      resolveQuery([]);
      await run.catch(() => {});
    });
  });
});
