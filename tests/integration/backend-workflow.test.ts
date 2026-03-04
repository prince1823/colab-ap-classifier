/**
 * End-to-end integration tests for the backend workflow (v2 DI architecture).
 *
 * These tests verify cross-service interactions using constructor injection
 * with mock database and LLM layers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockDatabase,
  createMockChangelogStore,
  createMockTransactionStore,
  createMockSupplierUniverse,
} from '../helpers/mock-services';
import { RuleStore } from '../../src/main/services/rules';
import { TransactionStore } from '../../src/main/services/transactions';
import type { Database, ChangelogStore, TransactionStore as ITransactionStore } from '../../src/shared/types/services';

// ────────────────────────────────────────────────────────────────────────
// Test 1: Rules Integration
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Rules', () => {
  let db: Database;
  let rules: RuleStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    rules = new RuleStore(db);
  });

  it('should list rules with parsed conditions', async () => {
    vi.mocked(db.all).mockResolvedValue([
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

    const result = await rules.listRules();
    expect(result).toHaveLength(1);
    expect(result[0].conditions[0].field).toBe('supplier_name');
    expect(result[0].conditions[0].operator).toBe('equals');
    expect(result[0].conditions[0].value).toBe('Acme');
  });

  it('should create rules with auto-assigned priority', async () => {
    vi.mocked(db.get).mockResolvedValue({ max_priority: null });
    vi.mocked(db.run).mockResolvedValue(undefined);

    const result = await rules.createRule({
      name: 'Test Rule',
      conditions: [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }],
      targetTaxonomyNodeId: 'tid1',
    });
    expect(result.id).toBeDefined();

    const insertCall = vi.mocked(db.run).mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO override_rules')
    );
    expect(insertCall).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 2: Transaction Update & Changelog Flow
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Transaction Update & Changelog', () => {
  let db: Database;
  let changelog: ChangelogStore;
  let transactions: ITransactionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    changelog = createMockChangelogStore();
    transactions = new TransactionStore(db, changelog);
  });

  it('should update transactions and create changelog entry', async () => {
    vi.mocked(db.all).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, taxonomy_node_id')) {
        return [
          { id: 'tx1', taxonomy_node_id: 'tid-old', classification_status: 'unclassified', classification_reasoning: null },
          { id: 'tx2', taxonomy_node_id: 'tid-old', classification_status: 'unclassified', classification_reasoning: null },
        ];
      }
      return [];
    });

    vi.mocked(db.run).mockResolvedValue(undefined);

    await transactions.updateTransactions(
      {
        ids: ['tx1', 'tx2'],
        taxonomyNodeId: 'tid-new',
        classificationStatus: 'human_reviewed',
        classificationReasoning: 'Manual reclassification',
      },
      'manual'
    );

    // Verify UPDATE was called
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );

    // Verify changelog logChange was called
    expect(changelog.logChange).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 3: Transactions Query
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Transaction Queries', () => {
  let db: Database;
  let changelog: ChangelogStore;
  let transactions: ITransactionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    changelog = createMockChangelogStore();
    transactions = new TransactionStore(db, changelog);
  });

  it('should get transaction stats', async () => {
    vi.mocked(db.all).mockResolvedValue([
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

    vi.mocked(db.get).mockResolvedValueOnce({
      total_rows: 100,
      total_spend: 50000,
      unique_suppliers: 25,
      classified_rows: 80,
      unclassified_rows: 20,
    });

    const stats = await transactions.getStats();
    expect(stats.totalRows).toBe(100);
    expect(stats.totalSpend).toBe(50000);
    expect(stats.uniqueSuppliers).toBe(25);
    expect(stats.classifiedRows).toBe(80);
    expect(stats.unclassifiedRows).toBe(20);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Test 4: Error Handling
// ────────────────────────────────────────────────────────────────────────
describe('Integration: Error Handling', () => {
  let db: Database;
  let changelog: ChangelogStore;
  let transactions: ITransactionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    changelog = createMockChangelogStore();
    transactions = new TransactionStore(db, changelog);
  });

  it('should skip update when no transaction IDs provided', async () => {
    await transactions.updateTransactions(
      { ids: [], taxonomyNodeId: 'tid1' },
      'manual'
    );

    expect(db.run).not.toHaveBeenCalled();
  });
});
