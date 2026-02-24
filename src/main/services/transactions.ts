import { databaseService } from './database';
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions } from '../../shared/types';

// Base columns that always exist on the transactions table
const BASE_COLUMNS = [
  'id', 'row_index', 'invoice_group_key', 'taxonomy_node_id',
  'review_score', 'classification_reasoning', 'created_at', 'updated_at',
];

// In-memory cache for transaction columns (avoids information_schema query per page load)
let cachedColumns: string[] | null = null;

/**
 * Invalidate the cached column list.
 * Must be called after ALTER TABLE adds new columns or when a new project is opened.
 */
export function invalidateColumnCache(): void {
  cachedColumns = null;
}

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

  // Pagination — return all rows when no pageSize specified
  const page = filters?.page || 1;
  const pageSize = filters?.pageSize;
  const offset = pageSize ? (page - 1) * pageSize : 0;

  // Get all dynamic columns to build SELECT
  const dynamicCols = validColumns.filter((c) => !BASE_COLUMNS.includes(c));

  const limitClause = pageSize ? `LIMIT ${pageSize} OFFSET ${offset}` : '';

  const sql = `
    SELECT t.*, tax.full_path as classification_path
    FROM transactions t
    LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
    ${whereSQL}
    ORDER BY t.${safeSortBy} ${safeOrder}
    ${limitClause}
  `;

  const rows = await databaseService.all<Record<string, unknown>>(sql, ...params);

  return rows.map((row) => {
    const canonicalFields: Record<string, unknown> = {};
    for (const col of dynamicCols) {
      if (row[col] !== undefined) {
        canonicalFields[col] = row[col];
      }
    }

    // Convert any BigInt values to Number for JSON serialization safety.
    // DuckDB may return BigInt for INTEGER columns depending on the driver version.
    const safeCanonicFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(canonicalFields)) {
      safeCanonicFields[k] = typeof v === 'bigint' ? Number(v) : v;
    }

    return {
      id: String(row.id),
      rowIndex: Number(row.row_index ?? 0),
      invoiceGroupKey: row.invoice_group_key ? String(row.invoice_group_key) : null,
      taxonomyNodeId: row.taxonomy_node_id ? String(row.taxonomy_node_id) : null,
      classificationPath: row.classification_path ? String(row.classification_path) : null,
      reviewScore: row.review_score != null ? Number(row.review_score) : null,
      classificationReasoning: row.classification_reasoning ? String(row.classification_reasoning) : null,
      canonicalFields: safeCanonicFields,
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
    total_rows: number | bigint;
    total_spend: number | bigint;
    unique_suppliers: number | bigint;
    classified_rows: number | bigint;
    flagged_rows: number | bigint;
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
    totalRows: Number(result?.total_rows ?? 0),
    totalSpend: Number(result?.total_spend ?? 0),
    uniqueSuppliers: Number(result?.unique_suppliers ?? 0),
    classifiedRows: Number(result?.classified_rows ?? 0),
    flaggedForReviewRows: Number(result?.flagged_rows ?? 0),
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
 * Get total count of transactions matching the given filters.
 */
export async function getCount(filters?: TransactionFilter): Promise<number> {
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
  const sql = `SELECT COUNT(*) as cnt FROM transactions t ${whereSQL}`;
  const result = await databaseService.get<{ cnt: number | bigint }>(sql, ...params);
  return Number(result?.cnt ?? 0);
}

/**
 * Query transactions with forced pagination for large datasets.
 * Returns rows + totalCount so frontend can track loading progress.
 */
export async function queryTransactionsPaginated(
  filters?: TransactionFilter
): Promise<PaginatedTransactions> {
  const page = filters?.page || 1;
  const pageSize = filters?.pageSize || 5000;
  const totalCount = await getCount(filters);

  const rows = await queryTransactions({
    ...filters,
    page,
    pageSize,
  });

  return {
    rows,
    totalCount,
    page,
    pageSize,
  };
}

/**
 * Ensure performance indexes exist on the transactions table.
 * Called once when a project is opened. DuckDB ignores IF NOT EXISTS
 * so we catch errors from duplicate index names.
 */
export async function ensureIndexes(): Promise<void> {
  const indexDefs = [
    'CREATE INDEX IF NOT EXISTS idx_transactions_review_score ON transactions(review_score)',
    'CREATE INDEX IF NOT EXISTS idx_transactions_row_index ON transactions(row_index)',
  ];

  // For dynamic canonical columns, only index well-known ones if they exist
  const cols = await getColumns();
  const optionalIndexCols = ['supplier_name', 'gl_description', 'spend_amount', 'line_description'];
  for (const col of optionalIndexCols) {
    if (cols.includes(col)) {
      indexDefs.push(
        `CREATE INDEX IF NOT EXISTS idx_transactions_${col} ON transactions(${col})`
      );
    }
  }

  for (const sql of indexDefs) {
    try {
      await databaseService.run(sql);
    } catch {
      // Index may already exist — safe to ignore
    }
  }
}

async function getTailSpendThreshold(): Promise<number> {
  const result = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
  );
  return result ? parseFloat(result.value) : 10000;
}
