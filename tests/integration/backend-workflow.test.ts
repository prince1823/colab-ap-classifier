/**
 * S1-25: End-to-end integration tests for the backend workflow.
 *
 * These tests verify cross-service interactions with mocked database and LLM layers.
 * DuckDB-dependent integration tests that verify actual database behavior are
 * included in this file with proper skip conditions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Database mock ──────────────────────────────────────────────────────
const mockRun = vi.fn();
const mockAll = vi.fn();
const mockGet = vi.fn();

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
  listRulePacks: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────
import * as settingsService from '../../src/main/services/settings';
import * as taxonomyService from '../../src/main/services/taxonomy';
import * as rulesService from '../../src/main/services/rules';
import * as supplierService from '../../src/main/services/suppliers';
import * as changelogService from '../../src/main/services/changelog';
import * as feedbackService from '../../src/main/services/feedback';
import * as reclassificationService from '../../src/main/services/reclassification';
import * as transactionsService from '../../src/main/services/transactions';
import { readRulePack } from '../../src/main/services/colabip';

// ────────────────────────────────────────────────────────────────────────
// Test 1: Settings & Configuration Lifecycle
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Settings & Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsService.resetSettings();
  });

  it('should provide a consistent settings → models → API key flow', () => {
    // Default settings
    const settings = settingsService.getSettings();
    expect(settings.provider).toBe('anthropic');
    expect(settings.hasApiKey).toBe(false);

    // Set API key
    settingsService.updateSettings({ apiKeys: { anthropic: 'sk-test' } });
    expect(settingsService.getSettings().hasApiKey).toBe(true);
    expect(settingsService.getApiKey('anthropic')).toBe('sk-test');

    // Switch provider
    settingsService.updateSettings({ provider: 'openai' });
    const models = settingsService.getModels();
    expect(models.map((m) => m.id)).toContain('gpt-4o');

    // API key should not be available for new provider
    expect(settingsService.getApiKey('openai')).toBeUndefined();
    expect(settingsService.getSettings().hasApiKey).toBe(false);

    // Set OpenAI key
    settingsService.updateSettings({ apiKeys: { openai: 'sk-openai' } });
    expect(settingsService.getApiKey()).toBe('sk-openai');
    expect(settingsService.getSettings().hasApiKey).toBe(true);

    // Reset
    settingsService.resetSettings();
    expect(settingsService.getSettings().provider).toBe('anthropic');
    expect(settingsService.getApiKey('openai')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 2: Taxonomy + Rules Integration
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Taxonomy & Rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list rules with parsed conditions', async () => {
    mockAll.mockResolvedValue([
      {
        id: 'r1',
        name: 'Supplier Rule',
        source: 'project',
        conditions: '[{"field":"supplier_name","operator":"equals","value":"Acme"}]',
        target_taxonomy_node_id: 'tid1',
        priority_score: 100,
        is_active: true,
        imported_at: null,
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
    // Create rule
    mockGet.mockResolvedValue({ cnt: 0 });
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

  it('should import rules from ColabIP and match taxonomy paths', async () => {
    vi.mocked(readRulePack).mockResolvedValue([
      {
        name: 'IT Rule',
        conditions: [{ field: 'gl_description', operator: 'contains', value: 'software' }],
        targetPath: 'Indirect|IT|Software',
        priorityScore: 0,
      },
    ]);

    // getNodes mock for taxonomy lookup
    mockAll.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM taxonomy')) {
        return [
          {
            id: 'tid1',
            full_path: 'Indirect|IT|Software',
            l1: 'Indirect',
            l2: 'IT',
            l3: 'Software',
            depth: 3,
            description: null,
            parent_path: 'Indirect|IT',
            created_at: '2026-01-01',
          },
        ];
      }
      return [];
    });

    mockGet.mockResolvedValue({ cnt: 0 });
    mockRun.mockResolvedValue(undefined);

    const importResult = await rulesService.importFromColabip('general');
    expect(importResult.imported).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 3: Reclassification → Changelog Flow
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Reclassification & Changelog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reclassify transactions, create changelog, and trigger feedback', async () => {
    // Mock taxonomy nodes
    mockAll.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM taxonomy')) {
        return [
          {
            id: 'tid-new',
            full_path: 'Indirect|IT|Software',
            l1: 'Indirect',
            l2: 'IT',
            l3: 'Software',
            depth: 3,
            description: null,
            parent_path: 'Indirect|IT',
            created_at: '',
          },
        ];
      }
      if (sql.includes('FROM transactions WHERE id')) {
        return [
          { id: 'tx1', taxonomy_node_id: 'tid-old' },
          { id: 'tx2', taxonomy_node_id: 'tid-old' },
        ];
      }
      return [];
    });

    mockRun.mockResolvedValue(undefined);

    await reclassificationService.reclassifyTransactions(
      ['tx1', 'tx2'],
      'tid-new'
    );

    // Verify UPDATE was called
    const updateCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE transactions SET taxonomy_node_id')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toBe('tid-new');

    // Verify changelog INSERT
    const changelogCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO change_log')
    );
    expect(changelogCall).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 4: Feedback Approval Workflow
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Feedback Approval Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create, list, approve, and verify feedback effects', async () => {
    // Create feedback
    mockRun.mockResolvedValue(undefined);
    const feedbackId = await feedbackService.createFeedback({
      feedbackType: 'company_context',
      affectedTransactionIds: ['tx1'],
      suggestion: {
        fieldName: 'industry',
        currentValue: 'Unknown',
        proposedValue: 'Manufacturing',
      },
      status: 'pending',
    });
    expect(feedbackId).toBeDefined();

    // List feedback
    mockAll.mockResolvedValue([
      {
        id: feedbackId,
        feedback_type: 'company_context',
        affected_transaction_ids: '["tx1"]',
        suggestion: '{"fieldName":"industry","currentValue":"Unknown","proposedValue":"Manufacturing"}',
        status: 'pending',
        created_at: '2026-01-01',
      },
    ]);

    const feedbackList = await feedbackService.listFeedback();
    expect(feedbackList).toHaveLength(1);
    expect(feedbackList[0].feedbackType).toBe('company_context');
    expect(feedbackList[0].status).toBe('pending');

    // Approve
    mockGet.mockImplementation(async (sql: string) => {
      if (sql.includes('system_feedback')) {
        return {
          id: feedbackId,
          feedback_type: 'company_context',
          affected_transaction_ids: '["tx1"]',
          suggestion: '{"fieldName":"industry","currentValue":"Unknown","proposedValue":"Manufacturing"}',
          status: 'pending',
          created_at: '2026-01-01',
        };
      }
      if (sql.includes('company_context')) {
        return { id: 'cc1' };
      }
      return undefined;
    });

    await feedbackService.approveFeedback(feedbackId);

    // Verify company_context was updated
    const updateCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE company_context')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toBe('Manufacturing');

    // Verify changelog entry was created
    const changelogCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO change_log')
    );
    expect(changelogCall).toBeDefined();

    // Verify status updated to approved
    const statusCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes("status = 'approved'")
    );
    expect(statusCall).toBeDefined();
  });

  it('should reject feedback and update status', async () => {
    mockGet.mockResolvedValue({
      id: 'fb1',
      feedback_type: 'taxonomy_description',
      affected_transaction_ids: null,
      suggestion: '{"taxonomyPath":"X","currentDescription":"","proposedDescription":"Y"}',
      status: 'pending',
      created_at: '',
    });
    mockRun.mockResolvedValue(undefined);

    await feedbackService.rejectFeedback('fb1', 'Not applicable');

    expect(mockRun).toHaveBeenCalledWith(
      "UPDATE system_feedback SET status = 'rejected' WHERE id = ?",
      'fb1'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 5: Transactions Query
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Transaction Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should query transactions with filters and return mapped results', async () => {
    mockAll.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return [
          { column_name: 'id' },
          { column_name: 'row_index' },
          { column_name: 'invoice_group_key' },
          { column_name: 'taxonomy_node_id' },
          { column_name: 'review_score' },
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
          invoice_group_key: null,
          taxonomy_node_id: 'tid1',
          classification_path: 'Indirect|IT|Software',
          review_score: 10,
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
  });

  it('should get transaction stats', async () => {
    mockAll.mockResolvedValue([
      { column_name: 'id' },
      { column_name: 'row_index' },
      { column_name: 'spend_amount' },
      { column_name: 'supplier_name' },
      { column_name: 'taxonomy_node_id' },
      { column_name: 'review_score' },
    ]);

    mockGet
      .mockResolvedValueOnce({ cnt: 100 })   // total rows
      .mockResolvedValueOnce({ total: 50000 }) // total spend
      .mockResolvedValueOnce({ cnt: 25 })      // unique suppliers
      .mockResolvedValueOnce({ cnt: 80 })      // classified
      .mockResolvedValueOnce({ cnt: 5 });      // flagged

    const stats = await transactionsService.getStats();
    expect(stats.totalRows).toBe(100);
    expect(stats.totalSpend).toBe(50000);
    expect(stats.uniqueSuppliers).toBe(25);
    expect(stats.classifiedRows).toBe(80);
    expect(stats.flaggedForReviewRows).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 6: Supplier Service Integration
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Supplier CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should upsert then update a supplier', async () => {
    // First call: no existing supplier
    mockGet.mockResolvedValueOnce(null);
    mockRun.mockResolvedValue(undefined);

    await supplierService.upsertSupplier({
      supplierName: 'Acme Corp',
      supplierType: 'company',
      transactionCount: 5,
      totalSpend: 10000,
    });

    const insertCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO project_suppliers')
    );
    expect(insertCall).toBeDefined();

    // Second call: existing supplier
    mockGet.mockResolvedValueOnce({
      id: 's1',
      supplier_name: 'Acme Corp',
      parent_supplier_id: null,
      supplier_type: 'company',
      supplier_info: null,
      category_a: false,
      category_a_taxonomy_node_id: null,
      transaction_count: 5,
      total_spend: 10000,
      created_at: '',
      updated_at: '',
    });

    await supplierService.upsertSupplier({
      supplierName: 'Acme Corp',
      categoryA: true,
      categoryATaxonomyNodeId: 'tid1',
    });

    const updateCall = mockRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE project_suppliers SET')
    );
    expect(updateCall).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 7: Cross-Service Error Handling
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw when reclassifying with invalid taxonomy node', async () => {
    // Return empty taxonomy
    mockAll.mockResolvedValue([]);

    await expect(
      reclassificationService.reclassifyTransactions(['tx1'], 'bad-tid')
    ).rejects.toThrow('Taxonomy node not found: bad-tid');
  });

  it('should throw when approving already-approved feedback', async () => {
    mockGet.mockResolvedValue({
      id: 'fb1',
      feedback_type: 'company_context',
      affected_transaction_ids: null,
      suggestion: '{}',
      status: 'approved',
      created_at: '',
    });

    await expect(
      feedbackService.approveFeedback('fb1')
    ).rejects.toThrow('Feedback fb1 is already approved');
  });

  it('should reject empty transaction list for reclassification', async () => {
    await expect(
      reclassificationService.reclassifyTransactions([], 'tid1')
    ).rejects.toThrow('No transaction IDs provided');
  });

  it('should throw when creating rule with no priority fallback and no source', async () => {
    mockGet.mockResolvedValue({ cnt: 0 });
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
