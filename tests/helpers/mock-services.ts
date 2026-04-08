import { vi } from 'vitest';
import type {
  Database,
  SupplierUniverse,
  EventBus,
  LLMClient,
  WebSearch,
  ClassificationAgent,
  ResearchAgent,
  ColumnMappingAgent,
  QCAgent,
  CatAAgent,
  ProjectStore,
  TransactionStore,
  TaxonomyStore,
  SupplierService,
  RuleStore,
  ChangelogStore,
  IngestService,
  ExportService,
  SupplierResearcher,
  ClassificationRunner,
} from '../../src/shared/types/services';

export function createMockDatabase(): Database {
  return {
    openDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    getFilePath: vi.fn().mockReturnValue('/test.c91'),
    getExpectedTables: vi.fn().mockReturnValue([
      'project_settings', 'taxonomy', 'transactions',
      'override_rules', 'change_log', 'uploads', 'project_suppliers',
      'rule_conditions',
    ]),
    run: vi.fn(),
    exec: vi.fn(),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
  };
}

export function createMockSupplierUniverse(): SupplierUniverse {
  return {
    open: vi.fn().mockResolvedValue({ created: false }),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    configure: vi.fn(),
    getConfiguredPath: vi.fn().mockReturnValue(null),
    getSupplier: vi.fn().mockResolvedValue(null),
    getSuppliersByNames: vi.fn().mockResolvedValue(new Map()),
    upsertSupplier: vi.fn(),
    upsertSupplierFull: vi.fn(),
    getSupplierRecord: vi.fn().mockResolvedValue(null as import('../../src/shared/types/suppliers').SupplierRecord | null),
    searchVariants: vi.fn().mockResolvedValue([]),
  };
}

export function createMockEventBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

export function createMockLLMClient(): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue('{}'),
  };
}

export function createMockWebSearch(): WebSearch {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    searchSupplier: vi.fn().mockResolvedValue([]),
  };
}

export function createMockClassificationAgent(): ClassificationAgent {
  return {
    selectCategories: vi.fn().mockResolvedValue(new Map([[1, 'L1|L2']])),
    selectCategoriesForTailSpend: vi.fn().mockResolvedValue(new Map([[1, 'L1|L2']])),
    classifyL3: vi.fn().mockResolvedValue({
      classifications: [{ id: 1, classificationPath: 'L1|L2|L3' }],
      assignments: { '1': [1] },
    }),
    classifyL3ForTailSpend: vi.fn().mockResolvedValue(new Map([[1, 'L1|L2|L3']])),
    classifyTransactionGroup: vi.fn().mockResolvedValue({
      classifications: [{ id: 1, classificationPath: 'L1|L2|L3' }],
      assignments: { '1': [1] },
    }),
  };
}

export function createMockResearchAgent(): ResearchAgent {
  return {
    researchSupplier: vi.fn().mockResolvedValue({
      supplierType: 'Corporation',
      industry: 'Technology',
    }),
  };
}

export function createMockColumnMappingAgent(): ColumnMappingAgent {
  return {
    suggestMappings: vi.fn().mockResolvedValue({
      mappings: {},
      confidence: 'high',
      unmappedClientColumns: [],
      importantUnmappedColumns: [],
      unmappedCanonicalColumns: [],
      reasoning: 'test',
    }),
  };
}

export function createMockQCAgent(): QCAgent {
  return {
    review: vi.fn().mockResolvedValue({ recommendations: [], noChangeNeeded: true }),
  };
}

export function createMockCatAAgent(): CatAAgent {
  return {
    resolve: vi.fn().mockResolvedValue({ resolvedPath: 'L1|L2|L3' }),
  };
}

export function createMockProjectStore(): ProjectStore {
  return {
    createProject: vi.fn().mockResolvedValue({ filePath: '/test.c91', name: 'Test' }),
    openProject: vi.fn().mockResolvedValue({ filePath: '/test.c91', name: 'Test' }),
    closeProject: vi.fn(),
    isProjectOpen: vi.fn().mockReturnValue(true),
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn(),
    deleteSetting: vi.fn(),
    getAllSettings: vi.fn().mockResolvedValue({}),
    selectSavePath: vi.fn().mockResolvedValue(null),
    selectOpenPath: vi.fn().mockResolvedValue(null),
  };
}

export function createMockTransactionStore(): TransactionStore {
  return {
    setProjectStore: vi.fn(),
    queryTransactions: vi.fn().mockResolvedValue([]),
    queryTransactionsPaginated: vi.fn().mockResolvedValue({ rows: [], totalCount: 0, page: 1, pageSize: 50 }),
    getStats: vi.fn().mockResolvedValue({ totalRows: 0, totalSpend: 0, uniqueSuppliers: 0, classifiedRows: 0, unclassifiedRows: 0 }),
    getColumns: vi.fn().mockResolvedValue([]),
    getColumnsForPivot: vi.fn().mockResolvedValue([]),
    getCount: vi.fn().mockResolvedValue(0),
    updateTransactions: vi.fn(),
    invalidateColumnCache: vi.fn(),
    getIdsByConditions: vi.fn().mockResolvedValue([]),
    getIdsByGroupedConditions: vi.fn().mockResolvedValue([]),
    applyRule: vi.fn().mockResolvedValue(0),
    getSupplierAddress: vi.fn().mockResolvedValue(undefined),
    getSpendByTaxonomy: vi.fn().mockResolvedValue([]),
    getTransactionsByTaxonomy: vi.fn().mockResolvedValue([]),
    queryBySupplier: vi.fn().mockResolvedValue([]),
    getIdsBySupplier: vi.fn().mockResolvedValue([]),
  };
}

export function createMockTaxonomyStore(): TaxonomyStore {
  return {
    getNodes: vi.fn().mockResolvedValue([]),
    addNode: vi.fn().mockResolvedValue({ id: 'node-1', fullPath: 'L1|L2|L3', l1: 'L1', l2: 'L2', l3: 'L3', depth: 3, description: null, parentPath: 'L1|L2', createdAt: '' }),
    updateNode: vi.fn(),
    deleteNode: vi.fn().mockResolvedValue({}),
    renameNode: vi.fn(),
    mergeNodes: vi.fn().mockResolvedValue({ transactionsMoved: 0 }),
    importFromFile: vi.fn().mockResolvedValue({ nodeCount: 0 }),
    createFromText: vi.fn().mockResolvedValue({ nodeCount: 0 }),
  };
}

export function createMockSupplierService(): SupplierService {
  return {
    normalizeSupplierName: vi.fn().mockResolvedValue('supplier-id'),
    normalizeAllTransactions: vi.fn(),
    assignAlias: vi.fn(),
    getProjectAliases: vi.fn().mockResolvedValue([]),
    getAllProjectAliasesWithSpend: vi.fn().mockResolvedValue({}),
    renameSupplier: vi.fn(),
    mergeSuppliers: vi.fn(),
    deleteSupplier: vi.fn(),
    updateSupplier: vi.fn(),
    listProjectSuppliers: vi.fn().mockResolvedValue([]),
    getProjectSupplier: vi.fn().mockResolvedValue(null),
    confirmSupplier: vi.fn(),
    filterTailSpend: vi.fn().mockResolvedValue([]),
    isTailSpend: vi.fn().mockResolvedValue(false),
    markResearched: vi.fn(),
    getFilterFields: vi.fn().mockReturnValue([]),
    queryDistinctValues: vi.fn().mockResolvedValue([]),
    listParents: vi.fn().mockResolvedValue([]),
    addParent: vi.fn().mockResolvedValue({ id: 'parent-1', name: 'Parent', createdAt: '' }),
    findParentByName: vi.fn().mockResolvedValue(null),
    assignParent: vi.fn(),
    renameParent: vi.fn(),
    deleteParent: vi.fn(),
    mergeParents: vi.fn(),
    syncToUniverse: vi.fn().mockResolvedValue({ synced: 0, failed: 0, errors: [] }),
    getProjectSupplierByName: vi.fn().mockResolvedValue(null),
  };
}

export function createMockRuleStore(): RuleStore {
  return {
    listRules: vi.fn().mockResolvedValue([]),
    listRulesPaginated: vi.fn().mockResolvedValue({ rules: [], total: 0 }),
    listRulesByGroup: vi.fn().mockResolvedValue({ rules: [], total: 0 }),
    getRule: vi.fn().mockResolvedValue(null),
    createRule: vi.fn().mockResolvedValue({ id: 'rule-1' }),
    createAndApplyRule: vi.fn().mockResolvedValue({ id: 'rule-1', matchedCount: 0 }),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    evaluateRules: vi.fn().mockResolvedValue(new Map()),
    evaluateRulesBulk: vi.fn().mockResolvedValue(new Map()),
    previewRules: vi.fn().mockResolvedValue({ token: 'mock-token', affectedRowCount: 0, matchingRuleCount: 0 }),
    applyRules: vi.fn().mockResolvedValue({ matchedCount: 0, ruleCount: 0 }),
    generate_rules_preview: vi.fn().mockResolvedValue({ rulesCreated: 0, suppliersProcessed: 0 }),
    listGroups: vi.fn().mockResolvedValue([]),
    createGroup: vi.fn().mockResolvedValue({ id: 'group-1' }),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    reorderGroups: vi.fn(),
    moveRuleToGroup: vi.fn(),
    assignToGroup: vi.fn(),
    filterAndAssignToGroup: vi.fn().mockResolvedValue({ matched: 0 }),
    getCatARuleForSupplier: vi.fn().mockResolvedValue(null),
    reassignSupplierRules: vi.fn(),
  };
}

export function createMockChangelogStore(): ChangelogStore {
  return {
    listChanges: vi.fn().mockResolvedValue([]),
    logChange: vi.fn().mockResolvedValue('change-1'),
    revertChange: vi.fn(),
  };
}

export function createMockIngestService(): IngestService {
  return {
    selectFile: vi.fn().mockResolvedValue(null),
    parseCSVPreview: vi.fn().mockReturnValue({ columns: [], sampleRows: [], totalRows: 0 }),
    suggestMappings: vi.fn().mockResolvedValue({ mappings: {}, confidence: 'high', unmappedClientColumns: [], importantUnmappedColumns: [], unmappedCanonicalColumns: [], reasoning: '' }),
    getStoredMappings: vi.fn().mockResolvedValue(null),
    importCSV: vi.fn().mockResolvedValue({ rowsInserted: 0, uploadId: 'upload-1' }),
    getUploadHistory: vi.fn().mockResolvedValue([]),
    getUploadStatsBatch: vi.fn().mockResolvedValue({}),
    deleteUpload: vi.fn().mockResolvedValue({ deletedRows: 0 }),
  };
}

export function createMockExportService(): ExportService {
  return {
    exportCSV: vi.fn().mockResolvedValue(null),
  };
}

export function createMockSupplierResearcher(): SupplierResearcher {
  return {
    researchSingle: vi.fn().mockResolvedValue({ supplierType: 'Corporation' }),
    researchAll: vi.fn(),
    categorizeWithSupplierInfo: vi.fn(),
    categorizeTailSpend: vi.fn(),
    cancel: vi.fn(),
  };
}

export function createMockClassificationRunner(): ClassificationRunner {
  return {
    classifyAll: vi.fn(),
    classifySupplierTransactions: vi.fn(),
    getScopeCount: vi.fn().mockResolvedValue(0),
    getIsRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
  };
}
