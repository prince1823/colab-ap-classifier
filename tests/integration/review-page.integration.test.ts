/**
 * ReviewPage data integration test (v2 architecture).
 *
 * Tests the data transformation layer between the v2 backend Transaction type
 * and the Dashboard component's expected row shape. This verifies that:
 * - v2 classification_status maps correctly (not v1 review_score)
 * - v2 Transaction type (no invoice_key / invoice_group_key) works
 * - canonicalFields are spread properly into dashboard rows
 * - Classification path is split into L1/L2/L3/L4
 *
 * Renamed from .tsx to .ts since no JSX is used — pure function tests.
 */
import { describe, expect, it } from 'vitest';
import { transactionToDashboardRow } from '../../src/renderer/utils/transactionTransform';
import type { Transaction } from '../../src/shared/types/transactions';

// ── Sample v2 transactions ─────────────────────────────────────────────

const SAMPLE_TRANSACTIONS: Transaction[] = [
  {
    id: 'tx1',
    rowIndex: 0,
    taxonomyNodeId: 'tid1',
    classificationPath: 'Non Clinical|Facilities|Facilities Maintenance Services',
    classificationStatus: 'classified_by_ai',
    humanReviewed: false,
    canonicalFields: {
      supplier_name: 'massey services',
      gl_description: '6600:repair & maintenance',
      line_description: 'commm pest prevention /3035 lakeland',
      spend_amount: '53.5',
    },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
  {
    id: 'tx2',
    rowIndex: 1,
    taxonomyNodeId: 'tid2',
    classificationPath: 'Non Clinical|Facilities|MRO Supplies',
    classificationStatus: 'classified_by_ai',
    humanReviewed: true,
    canonicalFields: {
      supplier_name: 'cintas corporation',
      gl_description: '6350:other expenses',
      line_description: 'lab coats, gowns, scrubs',
      spend_amount: '10000',
    },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
  {
    id: 'tx3',
    rowIndex: 2,
    taxonomyNodeId: null,
    classificationPath: null,
    classificationStatus: 'unclassified',
    humanReviewed: false,
    canonicalFields: {
      supplier_name: 'unknown vendor',
      gl_description: '7000:miscellaneous',
      spend_amount: '100',
    },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
];

// ── Tests ──────────────────────────────────────────────────────────────

describe('ReviewPage data integration (v2)', () => {
  it('transforms v2 transactions to dashboard rows with correct classification fields', () => {
    const row = transactionToDashboardRow(SAMPLE_TRANSACTIONS[0], 0);

    // Classification path should be split into L1/L2/L3
    expect(row.L1).toBe('Non Clinical');
    expect(row.L2).toBe('Facilities');
    expect(row.L3).toBe('Facilities Maintenance Services');
    expect(row.L4).toBeNull();

    // classification_status should be present (v2), not review_score (v1)
    expect(row.classification_status).toBe('classified_by_ai');
    expect(row).not.toHaveProperty('review_score');

    // No invoice_key in v2
    expect(row).not.toHaveProperty('invoice_key');
    expect(row).not.toHaveProperty('invoice_group_key');

    // Canonical fields should be spread
    expect(row.supplier_name).toBe('massey services');
    expect(row.gl_description).toBe('6600:repair & maintenance');
    expect(row.line_description).toBe('commm pest prevention /3035 lakeland');
  });

  it('maps spend_amount to multiple expected fields', () => {
    const row = transactionToDashboardRow(SAMPLE_TRANSACTIONS[0], 0);

    // Dashboard expects amount, invoice_amount, and spend_amount
    expect(row.amount).toBe('53.5');
    expect(row.invoice_amount).toBe('53.5');
    expect(row.spend_amount).toBe('53.5');
  });

  it('handles classified_by_ai status with human review flag', () => {
    const row = transactionToDashboardRow(SAMPLE_TRANSACTIONS[1], 1);

    expect(row.classification_status).toBe('classified_by_ai');
    expect(row.L1).toBe('Non Clinical');
    expect(row.L2).toBe('Facilities');
    expect(row.L3).toBe('MRO Supplies');
    expect(row.supplier_name).toBe('cintas corporation');
  });

  it('handles unclassified transactions with null classification path', () => {
    const row = transactionToDashboardRow(SAMPLE_TRANSACTIONS[2], 2);

    expect(row.classification_status).toBe('unclassified');
    expect(row.classification_path).toBe('');
    expect(row.L1).toBeNull();
    expect(row.L2).toBeNull();
    expect(row.L3).toBeNull();
    expect(row.taxonomy_node_id).toBeNull();
  });

  it('preserves transaction metadata in dashboard rows', () => {
    const row = transactionToDashboardRow(SAMPLE_TRANSACTIONS[0], 0);

    expect(row.id).toBe('tx1');
    expect(row.row_index).toBe(0);
    expect(row.taxonomy_node_id).toBe('tid1');
    expect(row.taxonomy_node_id).toBe('tid1');
  });

  it('transforms all transactions without errors', () => {
    const rows = SAMPLE_TRANSACTIONS.map((t, idx) => transactionToDashboardRow(t, idx));

    expect(rows).toHaveLength(3);

    // All rows should have the required dashboard fields
    for (const row of rows) {
      expect(row).toHaveProperty('supplier_name');
      expect(row).toHaveProperty('classification_status');
      expect(row).toHaveProperty('L1');
      expect(row).toHaveProperty('L2');
      expect(row).toHaveProperty('L3');
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('row_index');
      // v2 — no invoice_key or review_score
      expect(row).not.toHaveProperty('review_score');
      expect(row).not.toHaveProperty('invoice_key');
    }
  });
});
