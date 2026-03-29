import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupplierResearcher } from '../../../src/main/services/supplier-research';
import {
  createMockSupplierUniverse,
  createMockWebSearch,
  createMockResearchAgent,
  createMockEventBus,
  createMockSupplierService,
  createMockClassificationAgent,
  createMockTransactionStore,
} from '../../helpers/mock-services';
import type {
  SupplierUniverse, WebSearch, ResearchAgent, EventBus,
  SupplierService, ClassificationAgent, TransactionStore,
} from '../../../src/shared/types/services';

describe('SupplierResearcher', () => {
  let supplierUniverse: SupplierUniverse;
  let webSearch: WebSearch;
  let researchAgent: ResearchAgent;
  let eventBus: EventBus;
  let supplierService: SupplierService;
  let classificationAgent: ClassificationAgent;
  let transactions: TransactionStore;
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
    researcher = new SupplierResearcher(
      supplierUniverse, webSearch, researchAgent, eventBus,
      supplierService, classificationAgent, transactions
    );
  });

  describe('researchSingle', () => {
    it('should return cached info from universe if available', async () => {
      const cached = { supplierType: 'Corporation', industry: 'Technology', description: 'A tech company' };
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(cached);

      const result = await researcher.researchSingle('Acme');
      expect(result).toEqual(cached);
      expect(webSearch.searchSupplier).not.toHaveBeenCalled();
      expect(researchAgent.researchSupplier).not.toHaveBeenCalled();
    });

    it('should fall back to web search + LLM when not in universe', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(webSearch.searchSupplier).mockResolvedValue(['Acme Corp is a tech company']);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
        industry: 'Software',
      });

      const result = await researcher.researchSingle('Acme Corp');

      // searchSupplier is called with (name, address) — address may be undefined
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', undefined);
      expect(researchAgent.researchSupplier).toHaveBeenCalled();
      expect(supplierUniverse.upsertSupplier).toHaveBeenCalled();
      expect(result).toMatchObject({ supplierType: 'Corporation', industry: 'Software' });
    });

    it('should skip web search when not available', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(webSearch.isAvailable).mockReturnValue(false);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
        industry: 'Software',
      });

      await researcher.researchSingle('Test Corp');

      expect(webSearch.searchSupplier).not.toHaveBeenCalled();
      expect(researchAgent.researchSupplier).toHaveBeenCalled();
    });

    it('should pass transaction address to web search and research agent when supplierId provided', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(transactions.getSupplierAddress).mockResolvedValue('123 Main St, Springfield');
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
        industry: 'Software',
      });

      await researcher.researchSingle('Acme Corp', undefined, 'supplier-123');

      expect(transactions.getSupplierAddress).toHaveBeenCalledWith('supplier-123');
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', '123 Main St, Springfield');
      expect(researchAgent.researchSupplier).toHaveBeenCalledWith(
        'Acme Corp',
        undefined,
        '123 Main St, Springfield',
        expect.any(Array)
      );
    });

    it('should pass undefined address when supplierId not provided', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
      });

      await researcher.researchSingle('Acme Corp');

      expect(transactions.getSupplierAddress).not.toHaveBeenCalled();
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', undefined);
      expect(researchAgent.researchSupplier).toHaveBeenCalledWith(
        'Acme Corp',
        undefined,
        undefined,
        expect.any(Array)
      );
    });

    it('should pass undefined address when transaction has no supplier_address column', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(transactions.getSupplierAddress).mockResolvedValue(undefined);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
      });

      await researcher.researchSingle('Acme Corp', undefined, 'supplier-123');

      expect(transactions.getSupplierAddress).toHaveBeenCalledWith('supplier-123');
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', undefined);
      expect(researchAgent.researchSupplier).toHaveBeenCalledWith(
        'Acme Corp',
        undefined,
        undefined,
        expect.any(Array)
      );
    });
  });

  describe('researchAll', () => {
    it('should emit a progress event when no suppliers to research', async () => {
      await researcher.researchAll();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'suppliers:research:progress',
        expect.objectContaining({ currentStep: 'No suppliers to research' })
      );
    });

    it('should emit starting research when there are candidates', async () => {
      vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
        {
          id: 'sup1', supplierName: 'Acme', confirmationStatus: 'pending',
          isTailSpend: false, parentSupplierId: null, parentName: null,
          supplierInfo: null, mappedTaxonomyPaths: null,
          l1L2Path: null, universeMatch: false, isResearched: false,
          createdAt: '', transactionCount: 5, totalSpend: 1000, aliases: [],
        },
      ] as any);

      await researcher.researchAll();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'suppliers:research:progress',
        expect.objectContaining({ currentStep: 'Starting research' })
      );
    });
  });

  describe('categorizeWithSupplierInfo', () => {
    it('should call selectCategories for non-tail-spend suppliers with supplierInfo and no l1L2Path', async () => {
      vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
        {
          id: 'sup1', supplierName: 'Acme', confirmationStatus: 'pending',
          isTailSpend: false, parentSupplierId: null, parentName: null,
          supplierInfo: { industry: 'Tech' }, mappedTaxonomyPaths: null,
          l1L2Path: null, universeMatch: false, isResearched: true,
          createdAt: '', transactionCount: 5, totalSpend: 1000, aliases: [],
        },
      ] as any);

      const taxonomy = [
        { id: 't1', fullPath: 'L1|L2', l1: 'L1', l2: 'L2', l3: null, depth: 2, description: null, parentPath: 'L1', createdAt: '' },
      ];
      vi.mocked(classificationAgent.selectCategories).mockResolvedValue(new Map([[1, 'L1|L2']]));

      await researcher.categorizeWithSupplierInfo(taxonomy as any, { industry: 'Tech' });

      expect(classificationAgent.selectCategories).toHaveBeenCalledTimes(1);
      expect(supplierService.updateSupplier).toHaveBeenCalledWith('sup1', { l1L2Path: 'L1|L2' });
    });

    it('should skip suppliers that already have l1L2Path', async () => {
      vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
        {
          id: 'sup1', supplierName: 'Acme', confirmationStatus: 'pending',
          isTailSpend: false, parentSupplierId: null, parentName: null,
          supplierInfo: { industry: 'Tech' }, mappedTaxonomyPaths: null,
          l1L2Path: 'Already|Set', universeMatch: false, isResearched: true,
          createdAt: '', transactionCount: 5, totalSpend: 1000, aliases: [],
        },
      ] as any);

      await researcher.categorizeWithSupplierInfo([], { industry: 'Tech' });

      expect(classificationAgent.selectCategories).not.toHaveBeenCalled();
    });

    it('should skip tail spend suppliers', async () => {
      vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
        {
          id: 'sup1', supplierName: 'SmallCo', confirmationStatus: 'pending',
          isTailSpend: true, parentSupplierId: null, parentName: null,
          supplierInfo: { industry: 'Tech' }, mappedTaxonomyPaths: null,
          l1L2Path: null, universeMatch: false, isResearched: true,
          createdAt: '', transactionCount: 1, totalSpend: 50, aliases: [],
        },
      ] as any);

      await researcher.categorizeWithSupplierInfo([], { industry: 'Tech' });

      expect(classificationAgent.selectCategories).not.toHaveBeenCalled();
    });
  });

  describe('categorizeTailSpend', () => {
    it('should call selectCategoriesForTailSpend for tail spend suppliers', async () => {
      vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
        {
          id: 'sup1', supplierName: 'SmallCo', confirmationStatus: 'pending',
          isTailSpend: true, parentSupplierId: null, parentName: null,
          supplierInfo: null, mappedTaxonomyPaths: null,
          l1L2Path: null, universeMatch: false, isResearched: false,
          createdAt: '', transactionCount: 2, totalSpend: 50, aliases: [],
        },
      ] as any);
      vi.mocked(supplierService.getProjectSupplier).mockResolvedValue({
        id: 'sup1', supplierName: 'SmallCo', confirmationStatus: 'pending',
        isTailSpend: true, parentSupplierId: null, parentName: null,
        supplierInfo: null, mappedTaxonomyPaths: null,
        l1L2Path: null, universeMatch: false, isResearched: false, createdAt: '',
      });
      vi.mocked(transactions.queryBySupplier).mockResolvedValue([
        { id: 'tx1', project_supplier_id: 'sup1', spend_amount: 25, gl_description: 'Office supplies' },
        { id: 'tx2', project_supplier_id: 'sup1', spend_amount: 25, gl_description: 'Pens' },
      ]);

      const taxonomy = [
        { id: 't1', fullPath: 'L1|L2', l1: 'L1', l2: 'L2', l3: null, depth: 2, description: null, parentPath: 'L1', createdAt: '' },
      ];
      vi.mocked(classificationAgent.selectCategoriesForTailSpend).mockResolvedValue(new Map([[1, 'L1|L2']]));

      await researcher.categorizeTailSpend(taxonomy as any, { industry: 'Tech' }, ['gl_description']);

      expect(classificationAgent.selectCategoriesForTailSpend).toHaveBeenCalledTimes(1);
      expect(supplierService.updateSupplier).toHaveBeenCalledWith('sup1', { l1L2Path: 'L1|L2' });
    });

    it('should skip suppliers that already have l1L2Path', async () => {
      vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([
        {
          id: 'sup1', supplierName: 'SmallCo', confirmationStatus: 'pending',
          isTailSpend: true, parentSupplierId: null, parentName: null,
          supplierInfo: null, mappedTaxonomyPaths: null,
          l1L2Path: 'Already|Set', universeMatch: false, isResearched: false,
          createdAt: '', transactionCount: 2, totalSpend: 50, aliases: [],
        },
      ] as any);

      await researcher.categorizeTailSpend([], { industry: 'Tech' }, ['gl_description']);

      expect(classificationAgent.selectCategoriesForTailSpend).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('should be callable without error', () => {
      expect(() => researcher.cancel()).not.toThrow();
    });
  });
});
