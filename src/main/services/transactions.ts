import { databaseService } from './database';
import type { Transaction, TransactionFilter, TransactionStats } from '../../shared/types';

// Base columns that always exist on the transactions table
const BASE_COLUMNS = [
  'id', 'row_index', 'invoice_group_key', 'taxonomy_node_id',
  'review_score', 'classification_reasoning', 'created_at', 'updated_at',
];

/**
 * Query transactions with dynamic filters, pagination, sorting.
 */
export async function queryTransactions(
  filters?: TransactionFilter
): Promise<Transaction[]> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (filters?.supplierName) {
    whereClauses.push('t.supplier_name = ?');
    params.push(filters.supplierName);
  }
  if (filters?.taxonomyNodeId) {
    whereClauses.push('t.taxonomy_node_id = ?');
    params.push(filters.taxonomyNodeId);
  }
  if (filters?.reviewScoreMin !== undefined) {
    whereClauses.push('t.review_score >= ?');
    params.push(filters.reviewScoreMin);
  }
  if (filters?.reviewScoreMax !== undefined) {
    whereClauses.push('t.review_score <= ?');
    params.push(filters.reviewScoreMax);
  }
  if (filters?.spendMin !== undefined) {
    whereClauses.push('t.spend_amount >= ?');
    params.push(filters.spendMin);
  }
  if (filters?.spendMax !== undefined) {
    whereClauses.push('t.spend_amount <= ?');
    params.push(filters.spendMax);
  }
  if (filters?.excludeTailSpend) {
    const threshold = await getTailSpendThreshold();
    whereClauses.push('t.spend_amount >= ?');
    params.push(threshold);
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Sorting
  const sortBy = filters?.sortBy || 'row_index';
  const sortOrder = filters?.sortOrder || 'asc';
  const validColumns = await getColumns();
  const safeSortBy = validColumns.includes(sortBy) ? sortBy : 'row_index';
  const safeOrder = sortOrder === 'desc' ? 'DESC' : 'ASC';

  // Pagination
  const page = filters?.page || 1;
  const pageSize = filters?.pageSize || 50;
  const offset = (page - 1) * pageSize;

  // Get all dynamic columns to build SELECT
  const dynamicCols = validColumns.filter((c) => !BASE_COLUMNS.includes(c));

  const sql = `
    SELECT t.*, tax.full_path as classification_path
    FROM transactions t
    LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
    ${whereSQL}
    ORDER BY t.${safeSortBy} ${safeOrder}
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const rows = await databaseService.all<Record<string, unknown>>(sql, ...params);

  return rows.map((row) => {
    const canonicalFields: Record<string, unknown> = {};
    for (const col of dynamicCols) {
      if (row[col] !== undefined) {
        canonicalFields[col] = row[col];
      }
    }

    return {
      id: row.id as string,
      rowIndex: row.row_index as number,
      invoiceGroupKey: (row.invoice_group_key as string) || null,
      taxonomyNodeId: (row.taxonomy_node_id as string) || null,
      classificationPath: (row.classification_path as string) || null,
      reviewScore: row.review_score !== null ? (row.review_score as number) : null,
      classificationReasoning: (row.classification_reasoning as string) || null,
      canonicalFields,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  });
}

/**
 * Get aggregate stats for all transactions.
 */
export async function getStats(): Promise<TransactionStats> {
  const columns = await getColumns();
  const hasSpend = columns.includes('spend_amount');
  const hasSupplier = columns.includes('supplier_name');

  const totalResult = await databaseService.get<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM transactions'
  );
  const totalRows = totalResult?.cnt || 0;

  let totalSpend = 0;
  if (hasSpend) {
    const spendResult = await databaseService.get<{ total: number }>(
      'SELECT COALESCE(SUM(CAST(spend_amount AS DOUBLE)), 0) as total FROM transactions'
    );
    totalSpend = spendResult?.total || 0;
  }

  let uniqueSuppliers = 0;
  if (hasSupplier) {
    const supplierResult = await databaseService.get<{ cnt: number }>(
      'SELECT COUNT(DISTINCT supplier_name) as cnt FROM transactions'
    );
    uniqueSuppliers = supplierResult?.cnt || 0;
  }

  const classifiedResult = await databaseService.get<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM transactions WHERE taxonomy_node_id IS NOT NULL'
  );
  const classifiedRows = classifiedResult?.cnt || 0;

  const flaggedResult = await databaseService.get<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM transactions WHERE review_score > 0'
  );
  const flaggedForReviewRows = flaggedResult?.cnt || 0;

  return {
    totalRows,
    totalSpend,
    uniqueSuppliers,
    classifiedRows,
    flaggedForReviewRows,
  };
}

/**
 * Discover available columns on the transactions table.
 */
export async function getColumns(): Promise<string[]> {
  const rows = await databaseService.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
  );
  return rows.map((r) => r.column_name);
}

async function getTailSpendThreshold(): Promise<number> {
  const result = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
  );
  return result ? parseFloat(result.value) : 10000;
}
