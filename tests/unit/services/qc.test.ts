import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QCRunner } from '../../../src/main/services/qc';
import { createMockDatabase, createMockTransactionStore, createMockEventBus } from '../../helpers/mock-services';
import type { Database, TransactionStore, EventBus } from '../../../src/shared/types/services';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Supplier row returned by the first db.all query */
const makeSupplier = (id = 'sup-1', name = 'Acme') => ({ project_supplier_id: id, supplier_name: name });

/** Spend-group row returned by the per-supplier aggregation query */
const makeGroup = (taxonomyNodeId: string, l2: string, spend: number) => ({ taxonomy_node_id: taxonomyNodeId, l2, spend });

/**
 * Wire up db.all so that:
 *  - the supplier-list query  (contains "DISTINCT") returns `suppliers`
 *  - the spend-group query    (contains "GROUP BY")  returns `groups`
 *  - the outlier-ID query     (contains "!=")        returns `outlierIds`
 *  - the flag-all-IDs query   (fallback)             returns `allIds`
 */
function mockDbAll(
  db: Database,
  {
    suppliers = [makeSupplier()],
    groups = [] as ReturnType<typeof makeGroup>[],
    outlierIds = [] as { id: string }[],
    allIds = [] as { id: string }[],
  }
) {
  vi.mocked(db.all).mockImplementation(async (sql: string) => {
    if (sql.includes('DISTINCT')) return suppliers;
    if (sql.includes('GROUP BY')) return groups;
    if (sql.includes('!=')) return outlierIds;
    return allIds;
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('QCRunner', () => {
  let db: Database;
  let transactions: TransactionStore;
  let eventBus: EventBus;
  let runner: QCRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    transactions = createMockTransactionStore();
    eventBus = createMockEventBus();
    runner = new QCRunner(db, transactions, eventBus);
  });

  // ── No classified transactions ──────────────────────────────────────────────

  it('does nothing when there are no classified transactions', async () => {
    mockDbAll(db, { suppliers: [] });
    await runner.runQC();
    expect(transactions.updateTransactions).not.toHaveBeenCalled();
  });

  // ── Already clean (single L3) ──────────────────────────────────────────────

  it('does nothing when all transactions are already in one L3', async () => {
    mockDbAll(db, {
      groups: [makeGroup('node-software', 'IT', 10_000)],
    });
    await runner.runQC();
    expect(transactions.updateTransactions).not.toHaveBeenCalled();
  });

  // ── Pass 1: L3 threshold met ───────────────────────────────────────────────

  it('Pass 1 — moves outliers when ≥95% of spend is in one L3', async () => {
    // Software: $9,700 (97%) — Hardware: $300 (3%)
    mockDbAll(db, {
      groups: [
        makeGroup('node-software', 'IT', 9_700),
        makeGroup('node-hardware', 'IT', 300),
      ],
      outlierIds: [{ id: 'txn-hardware-1' }, { id: 'txn-hardware-2' }],
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledOnce();
    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      {
        ids: ['txn-hardware-1', 'txn-hardware-2'],
        taxonomyNodeId: 'node-software',
        classificationStatus: 'classified_by_qc_agent',
      },
      'pipeline'
    );
  });

  it('Pass 1 — does NOT fire when dominant L3 is exactly at threshold (95%)', async () => {
    // Software: $9,500 (95%) — exactly at threshold, should fire
    mockDbAll(db, {
      groups: [
        makeGroup('node-software', 'IT', 9_500),
        makeGroup('node-hardware', 'IT', 500),
      ],
      outlierIds: [{ id: 'txn-hardware-1' }],
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledOnce();
    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ taxonomyNodeId: 'node-software', classificationStatus: 'classified_by_qc_agent' }),
      'pipeline'
    );
  });

  it('Pass 1 — does NOT fire when best L3 is below 95%', async () => {
    // Software: $9,000 (90%) — below threshold
    // Should fall through to Pass 2 or flag
    mockDbAll(db, {
      groups: [
        makeGroup('node-software', 'IT', 9_000),
        makeGroup('node-hardware', 'IT', 1_000),
      ],
      allIds: [{ id: 'txn-1' }, { id: 'txn-2' }],
    });

    await runner.runQC();

    // Pass 2: IT = 100% of spend, software = 90% of IT → below 95% → flag
    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      { ids: ['txn-1', 'txn-2'], flaggedForReview: true },
      'pipeline'
    );
  });

  // ── Pass 2: L2 threshold met ───────────────────────────────────────────────

  it('Pass 2 — consolidates when ≥95% in one L2 and ≥95% of that L2 in one L3', async () => {
    // IT = $9,700 (97% of total). Within IT: Software = $9,400 (96.9% of IT). Facilities = $300.
    mockDbAll(db, {
      groups: [
        makeGroup('node-software', 'IT', 9_400),
        makeGroup('node-hardware', 'IT', 300),
        makeGroup('node-facilities', 'Facilities', 300),
      ],
      outlierIds: [{ id: 'txn-hardware-1' }, { id: 'txn-facilities-1' }],
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledOnce();
    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      {
        ids: ['txn-hardware-1', 'txn-facilities-1'],
        taxonomyNodeId: 'node-software',
        classificationStatus: 'classified_by_qc_agent',
      },
      'pipeline'
    );
  });

  it('Pass 2 — does NOT fire when L2 meets threshold but L3 within it does not', async () => {
    // IT = $9,700 (97%), but within IT: Software = $5,000 (51%), Hardware = $4,700 (48%)
    // → L3 within L2 is split, neither reaches 95%
    mockDbAll(db, {
      groups: [
        makeGroup('node-software', 'IT', 5_000),
        makeGroup('node-hardware', 'IT', 4_700),
        makeGroup('node-facilities', 'Facilities', 300),
      ],
      allIds: [{ id: 'txn-1' }, { id: 'txn-2' }, { id: 'txn-3' }],
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      { ids: ['txn-1', 'txn-2', 'txn-3'], flaggedForReview: true },
      'pipeline'
    );
  });

  it('Pass 2 — does NOT fire when the best L2 is below 95%', async () => {
    // IT = $6,000 (60%), Facilities = $4,000 (40%) — no L2 is dominant
    mockDbAll(db, {
      groups: [
        makeGroup('node-software', 'IT', 6_000),
        makeGroup('node-facilities', 'Facilities', 4_000),
      ],
      allIds: [{ id: 'txn-1' }, { id: 'txn-2' }],
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      { ids: ['txn-1', 'txn-2'], flaggedForReview: true },
      'pipeline'
    );
  });

  // ── Flagging ───────────────────────────────────────────────────────────────

  it('flags all supplier transactions when neither pass fires', async () => {
    mockDbAll(db, {
      groups: [
        makeGroup('node-a', 'L2-A', 5_000),
        makeGroup('node-b', 'L2-B', 5_000),
      ],
      allIds: [{ id: 'txn-1' }, { id: 'txn-2' }, { id: 'txn-3' }],
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      { ids: ['txn-1', 'txn-2', 'txn-3'], flaggedForReview: true },
      'pipeline'
    );
  });

  it('does nothing when there are no IDs to flag', async () => {
    mockDbAll(db, {
      groups: [
        makeGroup('node-a', 'L2-A', 5_000),
        makeGroup('node-b', 'L2-B', 5_000),
      ],
      allIds: [],
    });

    await runner.runQC();
    expect(transactions.updateTransactions).not.toHaveBeenCalled();
  });

  // ── Multiple suppliers processed independently ─────────────────────────────

  it('processes each supplier independently', async () => {
    const suppliers = [makeSupplier('sup-1', 'Acme'), makeSupplier('sup-2', 'Globex')];

    vi.mocked(db.all).mockImplementation(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('DISTINCT')) return suppliers;

      if (sql.includes('GROUP BY')) {
        const supplierId = args[0];
        if (supplierId === 'sup-1') {
          // Acme: Pass 1 fires
          return [makeGroup('node-software', 'IT', 9_700), makeGroup('node-hardware', 'IT', 300)];
        }
        // Globex: split — flag
        return [makeGroup('node-a', 'L2-A', 5_000), makeGroup('node-b', 'L2-B', 5_000)];
      }

      if (sql.includes('!=')) return [{ id: 'txn-hardware-1' }]; // Acme outliers
      return [{ id: 'txn-globex-1' }, { id: 'txn-globex-2' }];   // Globex all IDs
    });

    await runner.runQC();

    expect(transactions.updateTransactions).toHaveBeenCalledTimes(2);
    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      { ids: ['txn-hardware-1'], taxonomyNodeId: 'node-software', classificationStatus: 'classified_by_qc_agent' },
      'pipeline'
    );
    expect(transactions.updateTransactions).toHaveBeenCalledWith(
      { ids: ['txn-globex-1', 'txn-globex-2'], flaggedForReview: true },
      'pipeline'
    );
  });

  // ── Progress events ────────────────────────────────────────────────────────

  it('emits completed progress event when done', async () => {
    mockDbAll(db, { suppliers: [] });
    await runner.runQC();

    expect(eventBus.emit).toHaveBeenCalledWith('qc:progress', expect.objectContaining({ status: 'completed' }));
  });

  it('emits running events during processing', async () => {
    mockDbAll(db, {
      groups: [makeGroup('node-software', 'IT', 10_000)],
    });

    await runner.runQC();

    const emitCalls = vi.mocked(eventBus.emit).mock.calls;
    const statuses = emitCalls.map(([, payload]) => (payload as { status: string }).status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('completed');
  });

  // ── Zero spend edge case ───────────────────────────────────────────────────

  it('skips a supplier when total spend is zero', async () => {
    mockDbAll(db, {
      groups: [
        makeGroup('node-a', 'IT', 0),
        makeGroup('node-b', 'IT', 0),
      ],
    });

    await runner.runQC();
    expect(transactions.updateTransactions).not.toHaveBeenCalled();
  });

  // ── getIsRunning ───────────────────────────────────────────────────────────

  it('reports isRunning=false before and after runQC', async () => {
    mockDbAll(db, { suppliers: [] });
    expect(runner.getIsRunning()).toBe(false);
    await runner.runQC();
    expect(runner.getIsRunning()).toBe(false);
  });
});
