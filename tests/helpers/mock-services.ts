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
    ]),
    run: vi.fn(),
    exec: vi.fn(),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
  };
}

export function createMockSupplierUniverse(): SupplierUniverse {
  return {
    open: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    getSupplier: vi.fn().mockResolvedValue(null),
    getSuppliersByNames: vi.fn().mockResolvedValue(new Map()),
    upsertSupplier: vi.fn(),
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
    classifyInvoiceGroup: vi.fn().mockResolvedValue({
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
    queryTransactions: vi.fn().mockResolvedValue([]),
    queryTransactionsPaginated: vi.fn().mockResolvedValue({ rows: [], totalCount: 0, page: 1, pageSize: 50 }),
    getStats: vi.fn().mockResolvedValue({ totalRows: 0, totalSpend: 0, uniqueSuppliers: 0, classifiedRows: 0, unclassifiedRows: 0 }),
    getColumns: vi.fn().mockResolvedValue([]),
    getCount: vi.fn().mockResolvedValue(0),
    updateTransactions: vi.fn(),
    invalidateColumnCache: vi.fn(),
    getIdsByConditions: vi.fn().mockResolvedValue([]),
    getIdsByGroupedConditions: vi.fn().mockResolvedValue([]),
    applyRule: vi.fn().mockResolvedValue(0),
  };
}

export function createMockTaxonomyStore(): TaxonomyStore {
  return {
    getNodes: vi.fn().mockResolvedValue([]),
    addNode: vi.fn().mockResolvedValue({ id: 'node-1', fullPath: 'L1|L2|L3', l1: 'L1', l2: 'L2', l3: 'L3', depth: 3, description: null, parentPath: 'L1|L2', createdAt: '' }),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
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
    addAlias: vi.fn(),
    getAliases: vi.fn().mockResolvedValue([]),
    renameSupplier: vi.fn(),
    updateSupplier: vi.fn(),
    listProjectSuppliers: vi.fn().mockResolvedValue([]),
    getProjectSupplier: vi.fn().mockResolvedValue(null),
    confirmSupplier: vi.fn(),
    assignParent: vi.fn(),
    filterTailSpend: vi.fn().mockResolvedValue([]),
    isTailSpend: vi.fn().mockResolvedValue(false),
    markResearched: vi.fn(),
    getFilterFields: vi.fn().mockReturnValue([]),
  };
}

export function createMockRuleStore(): RuleStore {
  return {
    listRules: vi.fn().mockResolvedValue([]),
    createRule: vi.fn().mockResolvedValue({ id: 'rule-1' }),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    evaluateRules: vi.fn().mockResolvedValue(new Map()),
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
    cancel: vi.fn(),
  };
}

export function createMockClassificationRunner(): ClassificationRunner {
  return {
    classifyAll: vi.fn(),
    classifySupplier: vi.fn(),
    getIsRunning: vi.fn().mockReturnValue(false),
    cancel: vi.fn(),
  };
}
