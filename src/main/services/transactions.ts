import { databaseService } from './database';
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions, GroupedRow, GroupedTransactionsResult, PivotAggregationRow, PivotAggregationResult } from '../../shared/types';

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
 * Build WHERE clauses + params from a TransactionFilter.
 * Shared by queryTransactions, getCount, queryGroupedByColumn, etc.
 * Table alias defaults to 't'.
 *
 * Returns `needsTaxonomyJoin: true` when an L1-L4 classification filter
 * is present — callers that don't already JOIN taxonomy must add:
 *   LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
 */
async function buildFilterClauses(
  filters?: TransactionFilter,
  alias = 't'
): Promise<{ whereSQL: string; params: unknown[]; needsTaxonomyJoin: boolean }> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let needsTaxonomyJoin = false;

  if (filters?.supplierName) {
    whereClauses.push(`${alias}.supplier_name = ?`);
    params.push(filters.supplierName);
  }
  if (filters?.taxonomyNodeId) {
    whereClauses.push(`${alias}.taxonomy_node_id = ?`);
    params.push(filters.taxonomyNodeId);
  }
  if (filters?.reviewScoreMin !== undefined) {
    whereClauses.push(`${alias}.review_score >= ?`);
    params.push(filters.reviewScoreMin);
  }
  if (filters?.reviewScoreMax !== undefined) {
    whereClauses.push(`${alias}.review_score <= ?`);
    params.push(filters.reviewScoreMax);
  }
  if (filters?.spendMin !== undefined) {
    whereClauses.push(`${alias}.spend_amount >= ?`);
    params.push(filters.spendMin);
  }
  if (filters?.spendMax !== undefined) {
    whereClauses.push(`${alias}.spend_amount <= ?`);
    params.push(filters.spendMax);
  }
  if (filters?.excludeTailSpend) {
    const threshold = await getTailSpendThreshold();
    whereClauses.push(`${alias}.spend_amount >= ?`);
    params.push(threshold);
  }

  // Arbitrary column-value filters with per-pair AND/OR connectors
  if (filters?.columnFilters?.length) {
    const validCols = await getColumns();
    const globalCombinator = filters.filterCombinator || 'AND';
    const connectors = filters.filterConnectors || {};

    // Build one SQL clause per ColumnFilter (grouping multi-value operators)
    const perFilterClauses: { column: string; sql: string }[] = [];
    const perFilterParams: unknown[][] = [];

    for (const cf of filters.columnFilters) {
      // Handle virtual L1/L2/L3/L4 classification columns
      // These are derived from taxonomy.full_path (pipe-delimited), not real DB columns
      const classLevelMatch = /^L(\d)$/i.exec(cf.column);
      if (classLevelMatch) {
        needsTaxonomyJoin = true;
        const levelIdx = parseInt(classLevelMatch[1], 10);
        const taxExpr = `TRIM(string_split(tax.full_path, '|')[${levelIdx}])`;
        const cfParams: unknown[] = [];
        let clause: string;

        switch (cf.operator) {
          case 'is':
            if (cf.values.length === 1) {
              clause = `${taxExpr} = ?`;
              cfParams.push(cf.values[0]);
            } else {
              clause = `${taxExpr} IN (${cf.values.map(() => '?').join(', ')})`;
              cfParams.push(...cf.values);
            }
            break;
          case 'is_not':
            if (cf.values.length === 1) {
              clause = `${taxExpr} != ?`;
              cfParams.push(cf.values[0]);
            } else {
              clause = `${taxExpr} NOT IN (${cf.values.map(() => '?').join(', ')})`;
              cfParams.push(...cf.values);
            }
            break;
          case 'contains':
            if (cf.values.length === 1) {
              clause = `${taxExpr} ILIKE ?`;
              cfParams.push(`%${cf.values[0]}%`);
            } else {
              clause = `(${cf.values.map(() => `${taxExpr} ILIKE ?`).join(' OR ')})`;
              cfParams.push(...cf.values.map(v => `%${v}%`));
            }
            break;
          case 'not_contains':
            if (cf.values.length === 1) {
              clause = `${taxExpr} NOT ILIKE ?`;
              cfParams.push(`%${cf.values[0]}%`);
            } else {
              clause = `(${cf.values.map(() => `${taxExpr} NOT ILIKE ?`).join(' AND ')})`;
              cfParams.push(...cf.values.map(v => `%${v}%`));
            }
            break;
          case 'starts_with':
            if (cf.values.length === 1) {
              clause = `${taxExpr} ILIKE ?`;
              cfParams.push(`${cf.values[0]}%`);
            } else {
              clause = `(${cf.values.map(() => `${taxExpr} ILIKE ?`).join(' OR ')})`;
              cfParams.push(...cf.values.map(v => `${v}%`));
            }
            break;
          case 'ends_with':
            if (cf.values.length === 1) {
              clause = `${taxExpr} ILIKE ?`;
              cfParams.push(`%${cf.values[0]}`);
            } else {
              clause = `(${cf.values.map(() => `${taxExpr} ILIKE ?`).join(' OR ')})`;
              cfParams.push(...cf.values.map(v => `%${v}`));
            }
            break;
          default:
            continue;
        }

        perFilterClauses.push({ column: cf.column, sql: clause });
        perFilterParams.push(cfParams);
        continue;
      }

      if (!validCols.includes(cf.column)) continue;
      const col = `${alias}.${cf.column}`;
      const cfParams: unknown[] = [];
      let clause: string;

      switch (cf.operator) {
        case 'is':
          if (cf.values.length === 1) {
            clause = `${col} = ?`;
            cfParams.push(cf.values[0]);
          } else {
            clause = `${col} IN (${cf.values.map(() => '?').join(', ')})`;
            cfParams.push(...cf.values);
          }
          break;
        case 'is_not':
          if (cf.values.length === 1) {
            clause = `${col} != ?`;
            cfParams.push(cf.values[0]);
          } else {
            clause = `${col} NOT IN (${cf.values.map(() => '?').join(', ')})`;
            cfParams.push(...cf.values);
          }
          break;
        case 'contains':
          if (cf.values.length === 1) {
            clause = `${col} ILIKE ?`;
            cfParams.push(`%${cf.values[0]}%`);
          } else {
            // Multiple contains values: any match → OR them
            clause = `(${cf.values.map(() => `${col} ILIKE ?`).join(' OR ')})`;
            cfParams.push(...cf.values.map(v => `%${v}%`));
          }
          break;
        case 'not_contains':
          if (cf.values.length === 1) {
            clause = `${col} NOT ILIKE ?`;
            cfParams.push(`%${cf.values[0]}%`);
          } else {
            // Multiple not_contains values: none match → AND them
            clause = `(${cf.values.map(() => `${col} NOT ILIKE ?`).join(' AND ')})`;
            cfParams.push(...cf.values.map(v => `%${v}%`));
          }
          break;
        case 'starts_with':
          if (cf.values.length === 1) {
            clause = `${col} ILIKE ?`;
            cfParams.push(`${cf.values[0]}%`);
          } else {
            clause = `(${cf.values.map(() => `${col} ILIKE ?`).join(' OR ')})`;
            cfParams.push(...cf.values.map(v => `${v}%`));
          }
          break;
        case 'ends_with':
          if (cf.values.length === 1) {
            clause = `${col} ILIKE ?`;
            cfParams.push(`%${cf.values[0]}`);
          } else {
            clause = `(${cf.values.map(() => `${col} ILIKE ?`).join(' OR ')})`;
            cfParams.push(...cf.values.map(v => `%${v}`));
          }
          break;
        default:
          continue;
      }

      perFilterClauses.push({ column: cf.column, sql: clause });
      perFilterParams.push(cfParams);
    }

    if (perFilterClauses.length > 0) {
      // Apply SQL-like AND/OR precedence: AND binds tighter than OR.
      // Group consecutive AND-connected filters, then OR the groups.
      const hasConnectors = Object.keys(connectors).length > 0;

      if (!hasConnectors || perFilterClauses.length === 1) {
        // Simple case: use global combinator
        const combined = perFilterClauses.map(c => c.sql).join(` ${globalCombinator} `);
        whereClauses.push(`(${combined})`);
        for (const p of perFilterParams) params.push(...p);
      } else {
        // Build AND groups (same algorithm as client-side evaluateFilterConditions)
        const andGroups: { sqls: string[]; params: unknown[][] }[] = [
          { sqls: [perFilterClauses[0].sql], params: [perFilterParams[0]] }
        ];

        for (let i = 1; i < perFilterClauses.length; i++) {
          const prevColumn = perFilterClauses[i - 1].column;
          const connector = connectors[prevColumn] || 'AND';

          if (connector === 'OR') {
            andGroups.push({ sqls: [perFilterClauses[i].sql], params: [perFilterParams[i]] });
          } else {
            andGroups[andGroups.length - 1].sqls.push(perFilterClauses[i].sql);
            andGroups[andGroups.length - 1].params.push(perFilterParams[i]);
          }
        }

        // Each AND group: join with AND. Then OR the groups.
        const groupSqls = andGroups.map(g => {
          if (g.sqls.length === 1) return g.sqls[0];
          return `(${g.sqls.join(' AND ')})`;
        });

        const combined = groupSqls.length === 1
          ? groupSqls[0]
          : `(${groupSqls.join(' OR ')})`;

        whereClauses.push(combined);
        for (const g of andGroups) {
          for (const p of g.params) params.push(...p);
        }
      }
    }
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  return { whereSQL, params, needsTaxonomyJoin };
}

/**
 * Query transactions with dynamic filters, pagination, sorting.
 */
export async function queryTransactions(
  filters?: TransactionFilter
): Promise<Transaction[]> {
  const { whereSQL, params } = await buildFilterClauses(filters);

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
  const { whereSQL, params, needsTaxonomyJoin } = await buildFilterClauses(filters);
  const taxJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';
  const sql = `SELECT COUNT(*) as cnt FROM transactions t ${taxJoin} ${whereSQL}`;
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

/**
 * GROUP BY on a classification level (L1–L4) extracted from taxonomy.full_path.
 * DuckDB's string_split gives us pipe-delimited path segments.
 */
async function queryGroupedByClassificationLevel(
  column: string,
  levelIndex: number,
  filters?: TransactionFilter
): Promise<GroupedTransactionsResult> {
  const { whereSQL, params } = await buildFilterClauses(filters)
  const validCols = await getColumns()
  const hasSpend = validCols.includes('spend_amount')

  const amountExpr = hasSpend
    ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)'
    : '0'

  // DuckDB string_split is 1-indexed
  const sql = `
    SELECT
      COALESCE(TRIM(string_split(tax.full_path, '|')[${levelIndex}]), '(blank)') as value,
      ${amountExpr} as amount,
      COUNT(*) as count
    FROM transactions t
    LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
    ${whereSQL}
    GROUP BY value
    HAVING value != '(blank)' AND value != ''
    ORDER BY ${hasSpend ? 'amount DESC' : 'count DESC'}
  `

  const rows = await databaseService.all<{
    value: string
    amount: number | bigint
    count: number | bigint
  }>(sql, ...params)

  const groupedRows: GroupedRow[] = rows.map((r) => ({
    value: String(r.value),
    amount: Number(r.amount),
    count: Number(r.count),
  }))

  const totalAmount = groupedRows.reduce((sum, r) => sum + r.amount, 0)
  const totalCount = groupedRows.reduce((sum, r) => sum + r.count, 0)

  return { column, rows: groupedRows, totalAmount, totalCount }
}

/**
 * Server-side GROUP BY aggregation for a single column.
 * Returns grouped rows with SUM(spend_amount) and COUNT(*).
 * DuckDB handles millions of rows in milliseconds.
 */
export async function queryGroupedByColumn(
  column: string,
  filters?: TransactionFilter
): Promise<GroupedTransactionsResult> {
  // Handle virtual classification level columns (L1, L2, L3, L4)
  // These are derived from taxonomy.full_path (pipe-delimited), not real DB columns
  const classLevelMatch = /^L(\d)$/i.exec(column)
  if (classLevelMatch) {
    const levelIndex = parseInt(classLevelMatch[1], 10)
    return queryGroupedByClassificationLevel(column, levelIndex, filters)
  }

  const validCols = await getColumns();
  if (!validCols.includes(column)) {
    return { column, rows: [], totalAmount: 0, totalCount: 0 };
  }

  const { whereSQL, params, needsTaxonomyJoin } = await buildFilterClauses(filters);
  const hasSpend = validCols.includes('spend_amount');

  const amountExpr = hasSpend
    ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)'
    : '0';

  const taxJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';

  const sql = `
    SELECT
      COALESCE(CAST(t.${column} AS VARCHAR), '(blank)') as value,
      ${amountExpr} as amount,
      COUNT(*) as count
    FROM transactions t
    ${taxJoin}
    ${whereSQL}
    GROUP BY t.${column}
    ORDER BY ${hasSpend ? 'amount DESC' : 'count DESC'}
  `;

  const rows = await databaseService.all<{
    value: string;
    amount: number | bigint;
    count: number | bigint;
  }>(sql, ...params);

  const groupedRows: GroupedRow[] = rows.map((r) => ({
    value: String(r.value),
    amount: Number(r.amount),
    count: Number(r.count),
  }));

  const totalAmount = groupedRows.reduce((sum, r) => sum + r.amount, 0);
  const totalCount = groupedRows.reduce((sum, r) => sum + r.count, 0);

  return { column, rows: groupedRows, totalAmount, totalCount };
}

/**
 * Return distinct values for a column (for filter dropdowns).
 */
export async function queryDistinctValues(
  column: string,
  limit = 1000
): Promise<string[]> {
  const validCols = await getColumns();
  if (!validCols.includes(column)) return [];

  const sql = `
    SELECT DISTINCT CAST(t.${column} AS VARCHAR) as value
    FROM transactions t
    WHERE t.${column} IS NOT NULL
    ORDER BY value
    LIMIT ${limit}
  `;

  const rows = await databaseService.all<{ value: string }>(sql);
  return rows.map((r) => String(r.value));
}

/**
 * Fetch transaction IDs for a specific column value.
 * Used for on-demand reclassification when a grouped row is dragged.
 */
export async function getTransactionIdsByColumnValue(
  column: string,
  value: string,
  filters?: TransactionFilter
): Promise<string[]> {
  const validCols = await getColumns();
  if (!validCols.includes(column)) return [];

  const { whereSQL, params, needsTaxonomyJoin } = await buildFilterClauses(filters);

  // Add the column=value condition
  const valueCondition = value === '(blank)'
    ? `t.${column} IS NULL`
    : `CAST(t.${column} AS VARCHAR) = ?`;
  if (value !== '(blank)') params.push(value);

  const fullWhere = whereSQL
    ? `${whereSQL} AND ${valueCondition}`
    : `WHERE ${valueCondition}`;

  const taxJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';
  const sql = `SELECT CAST(t.id AS VARCHAR) as id FROM transactions t ${taxJoin} ${fullWhere}`;
  const rows = await databaseService.all<{ id: string }>(sql, ...params);
  return rows.map((r) => String(r.id));
}

async function getTailSpendThreshold(): Promise<number> {
  const result = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
  );
  return result ? parseFloat(result.value) : 10000;
}

/**
 * Server-side multi-level pivot aggregation.
 * Runs GROUP BY on multiple dimensions, returning aggregated amounts and counts.
 * Replaces client-side useHierarchicalPivotData for 4M+ row datasets.
 */
export async function queryPivotAggregation(
  dimensions: string[],
  valueDimension: string = 'spend_amount',
  filters?: TransactionFilter
): Promise<PivotAggregationResult> {
  if (!dimensions.length) {
    return { dimensionColumns: [], rows: [], totalAmount: 0, totalCount: 0 };
  }

  const validCols = await getColumns();

  // Validate dimensions — only use columns that exist
  const safeDimensions = dimensions.filter((d) => validCols.includes(d));
  if (!safeDimensions.length) {
    return { dimensionColumns: dimensions, rows: [], totalAmount: 0, totalCount: 0 };
  }

  const { whereSQL, params, needsTaxonomyJoin } = await buildFilterClauses(filters);
  const hasValue = validCols.includes(valueDimension);

  const amountExpr = hasValue
    ? `COALESCE(SUM(TRY_CAST(t.${valueDimension} AS DOUBLE)), 0)`
    : '0';

  const taxJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';

  // Build SELECT and GROUP BY for all dimension columns
  const dimSelects = safeDimensions.map(
    (d, i) => `COALESCE(CAST(t.${d} AS VARCHAR), '') as dim_${i}`
  );
  const dimGroupBy = safeDimensions.map((_, i) => `dim_${i}`);

  const sql = `
    SELECT
      ${dimSelects.join(',\n      ')},
      ${amountExpr} as amount,
      COUNT(*) as count
    FROM transactions t
    ${taxJoin}
    ${whereSQL}
    GROUP BY ${dimGroupBy.join(', ')}
    ORDER BY amount DESC
  `;

  const rows = await databaseService.all<Record<string, unknown>>(sql, ...params);

  const pivotRows: PivotAggregationRow[] = rows.map((r) => ({
    dimensions: safeDimensions.map((_, i) => String(r[`dim_${i}`] ?? '')),
    amount: Number(r.amount),
    count: Number(r.count),
  }));

  const totalAmount = pivotRows.reduce((sum, r) => sum + r.amount, 0);
  const totalCount = pivotRows.reduce((sum, r) => sum + r.count, 0);

  return { dimensionColumns: safeDimensions, rows: pivotRows, totalAmount, totalCount };
}
