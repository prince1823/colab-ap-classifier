import { databaseService } from './database';
import { logChange } from './changelog';
import type {
  Transaction,
  TransactionFilter,
  TransactionStats,
  PaginatedTransactions,
  TransactionUpdate,
  FilterCondition,
  ClassificationStatus,
} from '../../shared/types';

// Base columns that always exist on the transactions table (v2 schema)
const BASE_COLUMNS = [
  'id', 'row_index', 'taxonomy_node_id',
  'classification_status', 'classification_reasoning',
  'created_at', 'updated_at',
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

// ---------------------------------------------------------------------------
// Shared Filter Engine — used by both UI queries and override rule evaluation
// ---------------------------------------------------------------------------

/**
 * Convert a single FilterCondition to a SQL clause.
 * Pushes bind-parameter values to `params` array.
 * Returns the SQL fragment, or null if operator is unknown.
 */
export function conditionToSQL(condition: FilterCondition, params: unknown[]): string | null {
  const { field, operator, value } = condition;
  const col = field; // canonical column name

  switch (operator) {
    case 'equals':
      params.push(value);
      return `${col} = ?`;
    case 'not_equals':
      params.push(value);
      return `${col} != ?`;
    case 'contains':
      params.push(`%${value}%`);
      return `${col} LIKE ?`;
    case 'not_contains':
      params.push(`%${value}%`);
      return `${col} NOT LIKE ?`;
    case 'starts_with':
      params.push(`${value}%`);
      return `${col} LIKE ?`;
    case 'ends_with':
      params.push(`%${value}`);
      return `${col} LIKE ?`;
    case 'regex':
      return `regexp_matches(${col}, '${String(value).replace(/'/g, "''")}')`;
    case 'in_list': {
      const listValues = Array.isArray(value)
        ? value
        : String(value).split(',').map((v: string) => v.trim());
      const placeholders = listValues.map(() => '?').join(',');
      params.push(...listValues);
      return `${col} IN (${placeholders})`;
    }
    case 'greater_than':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) > ?`;
    case 'less_than':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) < ?`;
    case 'greater_than_or_equal':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) >= ?`;
    case 'less_than_or_equal':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) <= ?`;
    default:
      return null;
  }
}

/**
 * Build a SQL WHERE clause from an array of FilterConditions.
 * Supports per-condition AND/OR connectors.
 * Returns { sql, params } where sql is the WHERE fragment (without the "WHERE" keyword),
 * or null if no conditions produce SQL.
 *
 * This is the shared filter engine — imported by rules.ts for rule evaluation.
 */
export function buildWhereClause(
  conditions: FilterCondition[]
): { sql: string; params: unknown[] } | null {
  const clauses: string[] = [];
  const connectors: string[] = [];
  const params: unknown[] = [];

  for (const condition of conditions) {
    const clause = conditionToSQL(condition, params);
    if (clause) {
      clauses.push(clause);
      connectors.push(condition.connector || 'AND');
    }
  }

  if (clauses.length === 0) return null;

  // Assemble using per-condition connectors
  let combined = clauses[0];
  for (let i = 1; i < clauses.length; i++) {
    combined += ` ${connectors[i - 1]} ${clauses[i]}`;
  }

  return { sql: combined, params };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

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
  if (filters?.classificationStatus) {
    whereClauses.push('t.classification_status = ?');
    params.push(filters.classificationStatus);
  }
  if (filters?.spendMin !== undefined) {
    whereClauses.push('t.spend_amount >= ?');
    params.push(filters.spendMin);
  }
  if (filters?.spendMax !== undefined) {
    whereClauses.push('t.spend_amount <= ?');
    params.push(filters.spendMax);
  }

  // Apply generic filter conditions
  if (filters?.conditions && filters.conditions.length > 0) {
    const built = buildWhereClause(filters.conditions);
    if (built) {
      whereClauses.push(`(${built.sql})`);
      params.push(...built.params);
    }
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
        // Convert BigInt values to Number for JSON serialization
        canonicalFields[col] = typeof row[col] === 'bigint' ? Number(row[col]) : row[col];
      }
    }

    return {
      id: String(row.id),
      rowIndex: Number(row.row_index ?? 0),
      taxonomyNodeId: row.taxonomy_node_id ? String(row.taxonomy_node_id) : null,
      classificationPath: row.classification_path ? String(row.classification_path) : null,
      classificationStatus: (row.classification_status as ClassificationStatus) || 'unclassified',
      classificationReasoning: row.classification_reasoning ? String(row.classification_reasoning) : null,
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
    unclassified_rows: number | bigint;
  }>(
    `SELECT
      COUNT(*) as total_rows,
      ${spendExpr} as total_spend,
      ${supplierExpr} as unique_suppliers,
      COUNT(CASE WHEN classification_status != 'unclassified' THEN 1 END) as classified_rows,
      COUNT(CASE WHEN classification_status = 'unclassified' THEN 1 END) as unclassified_rows
    FROM transactions`
  );

  return {
    totalRows: Number(result?.total_rows ?? 0),
    totalSpend: Number(result?.total_spend ?? 0),
    uniqueSuppliers: Number(result?.unique_suppliers ?? 0),
    classifiedRows: Number(result?.classified_rows ?? 0),
    unclassifiedRows: Number(result?.unclassified_rows ?? 0),
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
  if (filters?.classificationStatus) {
    whereClauses.push('t.classification_status = ?');
    params.push(filters.classificationStatus);
  }
  if (filters?.spendMin !== undefined) {
    whereClauses.push('t.spend_amount >= ?');
    params.push(filters.spendMin);
  }
  if (filters?.spendMax !== undefined) {
    whereClauses.push('t.spend_amount <= ?');
    params.push(filters.spendMax);
  }
  if (filters?.conditions && filters.conditions.length > 0) {
    const built = buildWhereClause(filters.conditions);
    if (built) {
      whereClauses.push(`(${built.sql})`);
      params.push(...built.params);
    }
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

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update transaction fields and log the change.
 * Used by: manual review edits, rule application, AI classification results.
 */
export async function updateTransactions(
  update: TransactionUpdate,
  source: 'manual' | 'pipeline' | 'rule' = 'manual'
): Promise<void> {
  if (!update.ids || update.ids.length === 0) return;

  // Capture old values for changelog
  const placeholders = update.ids.map(() => '?').join(',');
  const oldRows = await databaseService.all<Record<string, unknown>>(
    `SELECT id, taxonomy_node_id, classification_status, classification_reasoning FROM transactions WHERE id IN (${placeholders})`,
    ...update.ids
  );

  const oldValues: Record<string, unknown> = {};
  if (oldRows.length > 0) {
    oldValues.taxonomy_node_id = oldRows[0].taxonomy_node_id;
    oldValues.classification_status = oldRows[0].classification_status;
    oldValues.classification_reasoning = oldRows[0].classification_reasoning;
  }

  // Build SET clause
  const setClauses: string[] = [];
  const params: unknown[] = [];
  const newValues: Record<string, unknown> = {};

  if (update.taxonomyNodeId !== undefined) {
    setClauses.push('taxonomy_node_id = ?');
    params.push(update.taxonomyNodeId);
    newValues.taxonomy_node_id = update.taxonomyNodeId;
  }
  if (update.classificationStatus !== undefined) {
    setClauses.push('classification_status = ?');
    params.push(update.classificationStatus);
    newValues.classification_status = update.classificationStatus;
  }
  if (update.classificationReasoning !== undefined) {
    setClauses.push('classification_reasoning = ?');
    params.push(update.classificationReasoning);
    newValues.classification_reasoning = update.classificationReasoning;
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = CURRENT_TIMESTAMP');

  await databaseService.run(
    `UPDATE transactions SET ${setClauses.join(', ')} WHERE id IN (${placeholders})`,
    ...params,
    ...update.ids
  );

  // Log to changelog
  await logChange({
    source,
    affectedTable: 'transactions',
    affectedIds: update.ids,
    affectedCount: update.ids.length,
    oldValues,
    newValues,
    description: `Updated ${update.ids.length} transaction(s)`,
  });
}
