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
  createMockCatAAgent,
  createMockTaxonomyStore,
  createMockRuleStore,
} from '../../helpers/mock-services';
import type {
  SupplierUniverse, WebSearch, ResearchAgent, EventBus,
  SupplierService, ClassificationAgent, TransactionStore,
  CatAAgent, TaxonomyStore, RuleStore,
} from '../../../src/shared/types/services';
import type { TaxonomyNode } from '../../../src/shared/types/taxonomy';

const makeNode = (fullPath: string, id = fullPath): TaxonomyNode => ({
  id,
  fullPath,
  l1: fullPath.split('|')[0],
  l2: fullPath.split('|')[1] ?? null,
  l3: fullPath.split('|')[2] ?? null,
  depth: fullPath.split('|').length,
  description: null,
  parentPath: fullPath.split('|').slice(0, -1).join('|') || null,
  createdAt: '',
});

const taxonomyNodes: TaxonomyNode[] = [
  makeNode('Corporate Services|IT|Software', 'node-it-sw'),
  makeNode('Professional Services|Consulting|Strategy', 'node-consulting'),
];

const makeSupplier = (overrides: Partial<{
  id: string; supplierName: string; categoryASupplier: boolean;
  mappedTaxonomyPaths: string[] | null; isTailSpend: boolean; isResearched: boolean;
}> = {}) => ({
  id: 'sup-1',
  supplierName: 'Acme Software',
  confirmationStatus: 'pending' as const,
  isTailSpend: false,
  parentSupplierId: null,
  parentName: null,
  supplierInfo: null,
  mappedTaxonomyPaths: null,
  l1L2Path: null,
  universeMatch: false,
  isResearched: false,
  categoryASupplier: false,
  createdAt: '',
  ...overrides,
});

describe('resolveCatASupplier (via researchAll)', () => {
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

    vi.mocked(taxonomyStore.getNodes).mockResolvedValue(taxonomyNodes);

    researcher = new SupplierResearcher(
      supplierUniverse, webSearch, researchAgent, eventBus,
      supplierService, classificationAgent, transactions,
      catAAgent, taxonomyStore, ruleStore
    );
  });

  it('creates a cat A rule for a supplier with category_a_supplier=true and exact-match path', async () => {
    const supplier = makeSupplier({
      categoryASupplier: true,
      mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
    });
    vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([supplier]);
    vi.mocked(supplierUniverse.getSupplierRecord).mockResolvedValue(null);
    vi.mocked(catAAgent.resolve).mockResolvedValue({ resolvedPath: 'Corporate Services|IT|Software' });

    await researcher.researchAll();

    expect(ruleStore.createRule).toHaveBeenCalledWith(expect.objectContaining({
      source: 'supplier_universe',
      categoryASupplier: true,
      targetTaxonomyNodeId: 'node-it-sw',
    }));
    const call = vi.mocked(ruleStore.createRule).mock.calls[0][0];
    const conditions = call.groupedConditions.groups[0].conditions;
    expect(conditions).toEqual([{ field: 'supplier_name', operator: 'equals', value: 'Acme Software' }]);
  });

  it('calls LLM fallback and creates rule when path does not exactly match', async () => {
    const supplier = makeSupplier({
      categoryASupplier: true,
      mappedTaxonomyPaths: ['IT Software Tools'],
    });
    vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([supplier]);
    vi.mocked(supplierUniverse.getSupplierRecord).mockResolvedValue(null);
    vi.mocked(catAAgent.resolve).mockResolvedValue({ resolvedPath: 'Corporate Services|IT|Software' });

    await researcher.researchAll();

    expect(catAAgent.resolve).toHaveBeenCalledWith('IT Software Tools', taxonomyNodes);
    expect(ruleStore.createRule).toHaveBeenCalledWith(expect.objectContaining({
      targetTaxonomyNodeId: 'node-it-sw',
      categoryASupplier: true,
    }));
  });

  it('does not create cat A rules for suppliers with category_a_supplier=false', async () => {
    const supplier = makeSupplier({
      categoryASupplier: false,
      mappedTaxonomyPaths: ['Corporate Services|IT|Software'],
    });
    vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([supplier]);
    vi.mocked(supplierUniverse.getSupplierRecord).mockResolvedValue(null);

    await researcher.researchAll();

    expect(ruleStore.createRule).not.toHaveBeenCalled();
  });

  it('does not create rules when mappedTaxonomyPaths is empty', async () => {
    const supplier = makeSupplier({
      categoryASupplier: true,
      mappedTaxonomyPaths: [],
    });
    vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([supplier]);
    vi.mocked(supplierUniverse.getSupplierRecord).mockResolvedValue(null);

    await researcher.researchAll();

    expect(ruleStore.createRule).not.toHaveBeenCalled();
  });

  it('creates multiple rules for multiple mapped paths', async () => {
    const supplier = makeSupplier({
      categoryASupplier: true,
      mappedTaxonomyPaths: [
        'Corporate Services|IT|Software',
        'Professional Services|Consulting|Strategy',
      ],
    });
    vi.mocked(supplierService.listProjectSuppliers).mockResolvedValue([supplier]);
    vi.mocked(supplierUniverse.getSupplierRecord).mockResolvedValue(null);
    vi.mocked(catAAgent.resolve)
      .mockResolvedValueOnce({ resolvedPath: 'Corporate Services|IT|Software' })
      .mockResolvedValueOnce({ resolvedPath: 'Professional Services|Consulting|Strategy' });

    await researcher.researchAll();

    expect(ruleStore.createRule).toHaveBeenCalledTimes(2);
  });
});
