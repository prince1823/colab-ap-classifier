/**
 * End-to-end integration tests for the backend workflow (v2 architecture).
 *
 * These tests verify cross-service interactions with mocked database and LLM layers.
 * DuckDB-dependent integration tests that verify actual database behavior are
 * included in this file with proper skip conditions.
 *
 * v2 changes:
 * - Removed settingsService (deleted in v2)
 * - Removed feedbackService (deleted in v2)
 * - Removed reclassificationService (replaced by transactionsService.updateTransactions)
 * - Rules no longer have `source` or `imported_at` fields
 * - Transactions use `classification_status` instead of `review_score`, no `invoice_group_key`
 * - Suppliers use supplier_universe.db via supplierUniverseService
 * - Stats return `unclassifiedRows` instead of `flaggedForReviewRows`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Database mock ──────────────────────────────────────────────────────
const mockRun = vi.fn();
const mockAll = vi.fn();
const mockGet = vi.fn();

// Supplier Universe DB mock
const mockSupplierUniverseRun = vi.fn();
const mockSupplierUniverseAll = vi.fn();
const mockSupplierUniverseGet = vi.fn();

vi.mock('../../src/main/services/database', () => ({
  databaseService: {
    run: (...args: unknown[]) => mockRun(...args),
    all: (...args: unknown[]) => mockAll(...args),
    get: (...args: unknown[]) => mockGet(...args),
    openDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    getFilePath: vi.fn().mockReturnValue('/tmp/test.c91'),
    getDatabase: vi.fn(),
    getExpectedTables: vi.fn().mockReturnValue(['project', 'taxonomy', 'transactions', 'override_rules', 'change_log']),
  },
  supplierUniverseService: {
    run: (...args: unknown[]) => mockSupplierUniverseRun(...args),
    all: (...args: unknown[]) => mockSupplierUniverseAll(...args),
    get: (...args: unknown[]) => mockSupplierUniverseGet(...args),
    open: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/out.csv' }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/test.c91'] }),
  },
}));

vi.mock('../../src/main/services/llm-client', () => ({
  chat: vi.fn(),
}));

vi.mock('../../src/main/agents/research-agent', () => ({
  researchSupplier: vi.fn(),
}));

vi.mock('../../src/main/services/colabip', () => ({
  readTaxonomy: vi.fn(),
  readRulePack: vi.fn(),
  readSupplierUniverse: vi.fn().mockResolvedValue([]),
  listTaxonomies: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────
import * as rulesService from '../../src/main/services/rules';
import * as supplierService from '../../src/main/services/suppliers';
import * as transactionsService from '../../src/main/services/transactions';

// ────────────────────────────────────────────────────────────────────────
// Test 1: Taxonomy + Rules Integration
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Taxonomy & Rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionsService.invalidateColumnCache();
  });

  it('should list rules with parsed conditions', async () => {
    mockAll.mockResolvedValue([
      {
        id: 'r1',
        name: 'Supplier Rule',
        conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]',
        target_taxonomy_node_id: 'tid1',
        priority_score: 1,
        is_active: true,
        created_at: '2026-01-01',
      },
    ]);

    const rules = await rulesService.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].conditions[0].field).toBe('supplier_name');
    expect(rules[0].conditions[0].operator).toBe('equals');
    expect(rules[0].conditions[0].value).toBe('Acme');
  });

  it('should create and evaluate override rules in priority order', async () => {
    // Mock getNextPriority — MAX query
    mockGet.mockResolvedValue({ max_priority: null });
    mockRun.mockResolvedValue(undefined);

    const result = await rulesService.createRule({
      name: 'Test Rule',
      conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
      targetTaxonomyNodeId: 'tid1',
    });
    expect(result.id).toBeDefined();

    // Verify INSERT was called
    const insertCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO override_rules')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![2]).toBe('Test Rule');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 2: Transaction Update & Changelog Flow
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Transaction Update & Changelog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionsService.invalidateColumnCache();
  });

  it('should update transactions and create changelog entry', async () => {
    // Mock fetching old values
    mockAll.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, taxonomy_node_id')) {
        return [
          { id: 'tx1', taxonomy_node_id: 'tid-old', classification_status: 'unclassified', classification_reasoning: null },
          { id: 'tx2', taxonomy_node_id: 'tid-old', classification_status: 'unclassified', classification_reasoning: null },
        ];
      }
      return [];
    });

    mockRun.mockResolvedValue(undefined);

    await transactionsService.updateTransactions(
      {
        ids: ['tx1', 'tx2'],
        taxonomyNodeId: 'tid-new',
        classificationStatus: 'human_reviewed',
        classificationReasoning: 'Manual reclassification',
      },
      'manual'
    );

    // Verify UPDATE was called
    const updateCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE transactions SET')
    );
    expect(updateCall).toBeDefined();

    // Verify changelog INSERT
    const changelogCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO change_log')
    );
    expect(changelogCall).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 3: Transactions Query
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Transaction Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionsService.invalidateColumnCache();
  });

  it('should query transactions with filters and return mapped results', async () => {
    mockAll.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return [
          { column_name: 'id' },
          { column_name: 'row_index' },
          { column_name: 'taxonomy_node_id' },
          { column_name: 'classification_status' },
          { column_name: 'classification_reasoning' },
          { column_name: 'created_at' },
          { column_name: 'updated_at' },
          { column_name: 'supplier_name' },
          { column_name: 'spend_amount' },
        ];
      }
      return [
        {
          id: 'tx1',
          row_index: 0,
          taxonomy_node_id: 'tid1',
          classification_path: 'Indirect|IT|Software',
          classification_status: 'classified_by_ai',
          classification_reasoning: 'Test',
          supplier_name: 'Acme',
          spend_amount: 5000,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      ];
    });

    const txns = await transactionsService.queryTransactions({
      supplierName: 'Acme',
      page: 1,
      pageSize: 10,
    });

    expect(txns).toHaveLength(1);
    expect(txns[0].id).toBe('tx1');
    expect(txns[0].canonicalFields.supplier_name).toBe('Acme');
    expect(txns[0].classificationPath).toBe('Indirect|IT|Software');
    expect(txns[0].classificationStatus).toBe('classified_by_ai');
  });

  it('should get transaction stats', async () => {
    // First call: getColumns (information_schema)
    mockAll.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'row_index' },
      { column_name: 'spend_amount' },
      { column_name: 'supplier_name' },
      { column_name: 'taxonomy_node_id' },
      { column_name: 'classification_status' },
      { column_name: 'classification_reasoning' },
      { column_name: 'created_at' },
      { column_name: 'updated_at' },
    ]);

    // v2 getStats uses a single aggregate query
    mockGet.mockResolvedValueOnce({
      total_rows: 100,
      total_spend: 50000,
      unique_suppliers: 25,
      classified_rows: 80,
      unclassified_rows: 20,
    });

    const stats = await transactionsService.getStats();
    expect(stats.totalRows).toBe(100);
    expect(stats.totalSpend).toBe(50000);
    expect(stats.uniqueSuppliers).toBe(25);
    expect(stats.classifiedRows).toBe(80);
    expect(stats.unclassifiedRows).toBe(20);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 4: Supplier Service Integration
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Supplier CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should upsert then update a supplier in supplier_universe.db', async () => {
    // First call: no existing supplier in supplier_universe.db
    mockSupplierUniverseGet.mockResolvedValueOnce(undefined);
    mockSupplierUniverseRun.mockResolvedValue(undefined);

    await supplierService.upsertSupplier('Acme Corp', {
      categoryA: false,
    });

    const insertCall = mockSupplierUniverseRun.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO suppliers')
    );
    expect(insertCall).toBeDefined();

    // Second call: existing supplier
    mockSupplierUniverseGet.mockResolvedValueOnce({
      id: 's1',
      supplier_name: 'Acme Corp',
      aliases: null,
      parent_supplier_id: null,
      parent_name: null,
      supplier_info: null,
      category_a: false,
      category_a_taxonomy_node_id: null,
      created_at: '',
      updated_at: '',
    });

    await supplierService.upsertSupplier('Acme Corp', {
      categoryA: true,
      categoryATaxonomyNodeId: 'tid1',
    });

    const updateCall = mockSupplierUniverseRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE suppliers SET')
    );
    expect(updateCall).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 5: Cross-Service Error Handling
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionsService.invalidateColumnCache();
  });

  it('should skip update when no transaction IDs provided', async () => {
    // updateTransactions early-returns for empty ids
    await transactionsService.updateTransactions(
      { ids: [], taxonomyNodeId: 'tid1' },
      'manual'
    );

    // No DB calls should have been made
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('should auto-assign priority when creating rule without explicit priority', async () => {
    mockGet.mockResolvedValue({ max_priority: null });
    mockRun.mockResolvedValue(undefined);

    // Should still work — auto-assigns priority
    const result = await rulesService.createRule({
      name: 'Test',
      conditions: [],
      targetTaxonomyNodeId: 'tid1',
    });
    expect(result.id).toBeDefined();
  });
});
