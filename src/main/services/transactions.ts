import { databaseService } from './database';
import type { Transaction, TransactionFilter, TransactionStats } from '../../shared/types';

// Base columns that always exist on the transactions table
const BASE_COLUMNS = [
  'id', 'row_index', 'invoice_group_key', 'taxonomy_node_id',
  'review_score', 'classification_reasoning', 'created_at', 'updated_at',
];

// In-memory cache for transaction columns (avoids information_schema query per page load)
let cachedColumns: string[] | null = null;

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
 * Uses a single query with conditional aggregates instead of 5 separate queries.
 */
export async function getStats(): Promise<TransactionStats> {
  const columns = await getColumns();
  const hasSpend = columns.includes('spend_amount');
  const hasSupplier = columns.includes('supplier_name');

  const spendExpr = hasSpend
    ? 'COALESCE(SUM(TRY_CAST(spend_amount AS DOUBLE)), 0)'
    : '0';
  const supplierExpr = hasSupplier
    ? 'COUNT(DISTINCT supplier_name)'
    : '0';

  const result = await databaseService.get<{
    total_rows: number;
    total_spend: number;
    unique_suppliers: number;
    classified_rows: number;
    flagged_rows: number;
  }>(
    `SELECT
      COUNT(*) as total_rows,
      ${spendExpr} as total_spend,
      ${supplierExpr} as unique_suppliers,
      COUNT(CASE WHEN taxonomy_node_id IS NOT NULL THEN 1 END) as classified_rows,
      COUNT(CASE WHEN review_score > 0 THEN 1 END) as flagged_rows
    FROM transactions`
  );

  return {
    totalRows: result?.total_rows || 0,
    totalSpend: result?.total_spend || 0,
    uniqueSuppliers: result?.unique_suppliers || 0,
    classifiedRows: result?.classified_rows || 0,
    flaggedForReviewRows: result?.flagged_rows || 0,
  };
}

/**
 * Discover available columns on the transactions table.
 * Results are cached in memory — call invalidateColumnCache() after ALTER TABLE.
 */
export async function getColumns(): Promise<string[]> {
  if (cachedColumns) return cachedColumns;

  const rows = await databaseService.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
  );
  cachedColumns = rows.map((r) => r.column_name);
  return cachedColumns;
}

/**
 * Invalidate the cached column list.
 * Must be called after ALTER TABLE adds new columns or when a new project is opened.
 */
export function invalidateColumnCache(): void {
  cachedColumns = null;
}

async function getTailSpendThreshold(): Promise<number> {
  const result = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
  );
  return result ? parseFloat(result.value) : 10000;
}
