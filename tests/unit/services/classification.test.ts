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
        if (sql.includes('project_suppliers') || sql.includes('DISTINCT')) {
          return [{ id: 'sup1', canonical_name: 'Acme', project_supplier_id: 'sup1' }];
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
        classificationPath: 'Indirect|IT|Software',
        reasoning: 'Test reasoning',
        descriptionSupplierAligned: true,
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
        if (sql.includes('project_suppliers') || sql.includes('DISTINCT')) {
          return [{ id: 'sup1', canonical_name: 'Acme', project_supplier_id: 'sup1' }];
        }
        if (sql.includes('FROM transactions')) {
          return [
            { id: 'tx1', project_supplier_id: 'sup1', row_index: 0, spend_amount: 1000, gl_description: 'Software', classification_status: 'unclassified' },
            { id: 'tx2', project_supplier_id: 'sup1', row_index: 1, spend_amount: 5000, gl_description: 'Cloud', classification_status: 'unclassified' },
          ];
        }
        return [];
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
        classificationPath: 'Indirect|IT|Software',
        reasoning: 'AI reasoning',
        descriptionSupplierAligned: true,
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
        if (sql.includes('project_suppliers') || sql.includes('DISTINCT')) {
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
        classificationPath: 'Indirect|IT|Software',
        reasoning: 'Test',
        descriptionSupplierAligned: true,
      });

      await runner.classifyAll();

      expect(classificationAgent.classifyInvoiceGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          columnPriorities: ['spend_amount'],
        })
      );
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
