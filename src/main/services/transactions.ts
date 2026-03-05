import type {
  Database,
  TransactionStore as ITransactionStore,
  ChangelogStore as IChangelogStore,
} from '../../shared/types/services';
import type {
  Transaction,
  TransactionFilter,
  TransactionStats,
  PaginatedTransactions,
  TransactionUpdate,
  GroupedRow,
  GroupedTransactionsResult,
  PivotAggregationRow,
  PivotAggregationResult,
  ClassificationStatus,
} from '../../shared/types';
import type { ChangeSource } from '../../shared/types/changelog';
import { buildWhereClause } from '../utils/query-builder';

const BASE_COLUMNS = [
  'id', 'row_index', 'upload_id', 'taxonomy_node_id',
  'classification_status', 'human_reviewed', 'classification_reasoning',
  'original_supplier_name', 'project_supplier_id',
  'created_at', 'updated_at',
];

export class TransactionStore implements ITransactionStore {
  private cachedColumns: string[] | null = null;

  constructor(
    private db: Database,
    private changelog: IChangelogStore
  ) {}

  invalidateColumnCache(): void {
    this.cachedColumns = null;
  }

  private buildFilterSQL(filters?: TransactionFilter): { whereSQL: string; params: unknown[] } {
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
      whereClauses.push('CAST(t.spend_amount AS DOUBLE) >= ?');
      params.push(filters.spendMin);
    }
    if (filters?.spendMax !== undefined) {
      whereClauses.push('CAST(t.spend_amount AS DOUBLE) <= ?');
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
    return { whereSQL, params };
  }

  async queryTransactions(filters?: TransactionFilter): Promise<Transaction[]> {
    const { whereSQL, params } = this.buildFilterSQL(filters);

    const sortBy = filters?.sortBy || 'row_index';
    const sortOrder = filters?.sortOrder || 'asc';
    const validColumns = await this.getColumns();
    const safeSortBy = validColumns.includes(sortBy) ? sortBy : 'row_index';
    const safeOrder = sortOrder === 'desc' ? 'DESC' : 'ASC';

    const page = filters?.page || 1;
    const pageSize = filters?.pageSize;
    const offset = pageSize ? (page - 1) * pageSize : 0;
    const limitClause = pageSize ? `LIMIT ${pageSize} OFFSET ${offset}` : '';

    const dynamicCols = validColumns.filter((c) => !BASE_COLUMNS.includes(c));

    const sql = `
      SELECT t.*, tax.full_path as classification_path
      FROM transactions t
      LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
      ${whereSQL}
      ORDER BY t.${safeSortBy} ${safeOrder}
      ${limitClause}
    `;

    const rows = await this.db.all<Record<string, unknown>>(sql, ...params);

    return rows.map((row) => {
      const canonicalFields: Record<string, unknown> = {};
      for (const col of dynamicCols) {
        if (row[col] !== undefined) {
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
        humanReviewed: Boolean(row.human_reviewed),
        canonicalFields,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  async queryTransactionsPaginated(filters?: TransactionFilter): Promise<PaginatedTransactions> {
    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 5000;
    const totalCount = await this.getCount(filters);
    const rows = await this.queryTransactions({ ...filters, page, pageSize });
    return { rows, totalCount, page, pageSize };
  }

  async getStats(): Promise<TransactionStats> {
    const columns = await this.getColumns();
    const hasSpend = columns.includes('spend_amount');

    const spendExpr = hasSpend ? 'COALESCE(SUM(TRY_CAST(spend_amount AS DOUBLE)), 0)' : '0';

    const result = await this.db.get<{
      total_rows: number | bigint;
      total_spend: number | bigint;
      unique_suppliers: number | bigint;
      classified_rows: number | bigint;
      unclassified_rows: number | bigint;
    }>(
      `SELECT
        COUNT(*) as total_rows,
        ${spendExpr} as total_spend,
        COUNT(DISTINCT project_supplier_id) as unique_suppliers,
        COUNT(CASE WHEN classification_status IN ('classified_by_ai', 'classified_by_rule') THEN 1 END) as classified_rows,
        COUNT(CASE WHEN classification_status = 'unclassified' OR classification_status = 'classification_failed' THEN 1 END) as unclassified_rows
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

  async getColumns(): Promise<string[]> {
    if (this.cachedColumns) return this.cachedColumns;

    const rows = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
    );
    this.cachedColumns = rows.map((r) => r.column_name);
    return this.cachedColumns;
  }

  async getCount(filters?: TransactionFilter): Promise<number> {
    const { whereSQL, params } = this.buildFilterSQL(filters);
    const sql = `SELECT COUNT(*) as cnt FROM transactions t ${whereSQL}`;
    const result = await this.db.get<{ cnt: number | bigint }>(sql, ...params);
    return Number(result?.cnt ?? 0);
  }

  async updateTransactions(update: TransactionUpdate, source: ChangeSource = 'manual'): Promise<void> {
    if (!update.ids || update.ids.length === 0) return;

    const placeholders = update.ids.map(() => '?').join(',');
    const oldRows = await this.db.all<Record<string, unknown>>(
      `SELECT id, taxonomy_node_id, classification_status, classification_reasoning FROM transactions WHERE id IN (${placeholders})`,
      ...update.ids
    );

    const oldValues: Record<string, unknown> = {};
    if (oldRows.length > 0) {
      oldValues.taxonomy_node_id = oldRows[0].taxonomy_node_id;
      oldValues.classification_status = oldRows[0].classification_status;
      oldValues.classification_reasoning = oldRows[0].classification_reasoning;
    }

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

    await this.db.run(
      `UPDATE transactions SET ${setClauses.join(', ')} WHERE id IN (${placeholders})`,
      ...params, ...update.ids
    );

    await this.changelog.logChange({
      source,
      affectedTable: 'transactions',
      affectedIds: update.ids,
      affectedCount: update.ids.length,
      oldValues,
      newValues,
      description: `Updated ${update.ids.length} transaction(s)`,
    });
  }

  /**
   * Server-side GROUP BY aggregation for a single column.
   * Handles virtual L1-L4 classification level columns derived from taxonomy.full_path.
   */
  async queryGroupedByColumn(
    column: string,
    filters?: TransactionFilter
  ): Promise<GroupedTransactionsResult> {
    const classLevelMatch = /^L(\d)$/i.exec(column);
    if (classLevelMatch) {
      const levelIndex = parseInt(classLevelMatch[1], 10);
      return this.queryGroupedByClassificationLevel(column, levelIndex, filters);
    }

    if (column === 'classification_path') {
      return this.queryGroupedByClassificationPath(filters);
    }

    const validCols = await this.getColumns();
    if (!validCols.includes(column)) {
      return { column, rows: [], totalAmount: 0, totalCount: 0 };
    }

    const { whereSQL, params } = this.buildFilterSQL(filters);
    const hasSpend = validCols.includes('spend_amount');

    const amountExpr = hasSpend
      ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)'
      : '0';

    const sql = `
      SELECT
        COALESCE(CAST(t.${column} AS VARCHAR), '(blank)') as value,
        ${amountExpr} as amount,
        COUNT(*) as count
      FROM transactions t
      ${whereSQL}
      GROUP BY t.${column}
      ORDER BY ${hasSpend ? 'amount DESC' : 'count DESC'}
    `;

    const rows = await this.db.all<{
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
  async queryDistinctValues(column: string, limit = 1000): Promise<string[]> {
    const validCols = await this.getColumns();
    if (!validCols.includes(column)) return [];

    const sql = `
      SELECT DISTINCT CAST(t.${column} AS VARCHAR) as value
      FROM transactions t
      WHERE t.${column} IS NOT NULL
      ORDER BY value
      LIMIT ${limit}
    `;

    const rows = await this.db.all<{ value: string }>(sql);
    return rows.map((r) => String(r.value));
  }

  /**
   * Fetch transaction IDs for a specific column value.
   */
  async getTransactionIdsByColumnValue(
    column: string,
    value: string,
    filters?: TransactionFilter
  ): Promise<string[]> {
    const validCols = await this.getColumns();
    if (!validCols.includes(column)) return [];

    const { whereSQL, params } = this.buildFilterSQL(filters);

    const valueCondition = value === '(blank)'
      ? `t.${column} IS NULL`
      : `CAST(t.${column} AS VARCHAR) = ?`;
    if (value !== '(blank)') params.push(value);

    const fullWhere = whereSQL
      ? `${whereSQL} AND ${valueCondition}`
      : `WHERE ${valueCondition}`;

    const sql = `SELECT CAST(t.id AS VARCHAR) as id FROM transactions t ${fullWhere}`;
    const rows = await this.db.all<{ id: string }>(sql, ...params);
    return rows.map((r) => String(r.id));
  }

  /**
   * Server-side multi-level pivot aggregation.
   */
  async queryPivotAggregation(
    dimensions: string[],
    valueDimension: string = 'spend_amount',
    filters?: TransactionFilter
  ): Promise<PivotAggregationResult> {
    if (!dimensions.length) {
      return { dimensionColumns: [], rows: [], totalAmount: 0, totalCount: 0 };
    }

    const validCols = await this.getColumns();
    const safeDimensions = dimensions.filter((d) => validCols.includes(d));
    if (!safeDimensions.length) {
      return { dimensionColumns: dimensions, rows: [], totalAmount: 0, totalCount: 0 };
    }

    const { whereSQL, params } = this.buildFilterSQL(filters);
    const hasValue = validCols.includes(valueDimension);

    const amountExpr = hasValue
      ? `COALESCE(SUM(TRY_CAST(t.${valueDimension} AS DOUBLE)), 0)`
      : '0';

    const dimSelects = safeDimensions.map(
      (d, i) => `COALESCE(CAST(t.${d} AS VARCHAR), '') as dim_${i}`
    );
    const dimGroupBy = safeDimensions.map((_, i) => `dim_${i}`);

    const sql = `
      SELECT
        ${dimSelects.join(',\n        ')},
        ${amountExpr} as amount,
        COUNT(*) as count
      FROM transactions t
      ${whereSQL}
      GROUP BY ${dimGroupBy.join(', ')}
      ORDER BY amount DESC
    `;

    const rows = await this.db.all<Record<string, unknown>>(sql, ...params);

    const pivotRows: PivotAggregationRow[] = rows.map((r) => ({
      dimensions: safeDimensions.map((_, i) => String(r[`dim_${i}`] ?? '')),
      amount: Number(r.amount),
      count: Number(r.count),
    }));

    const totalAmount = pivotRows.reduce((sum, r) => sum + r.amount, 0);
    const totalCount = pivotRows.reduce((sum, r) => sum + r.count, 0);

    return { dimensionColumns: safeDimensions, rows: pivotRows, totalAmount, totalCount };
  }

  private async queryGroupedByClassificationLevel(
    column: string,
    levelIndex: number,
    filters?: TransactionFilter
  ): Promise<GroupedTransactionsResult> {
    const { whereSQL, params } = this.buildFilterSQL(filters);
    const validCols = await this.getColumns();
    const hasSpend = validCols.includes('spend_amount');

    const amountExpr = hasSpend
      ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)'
      : '0';

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
    `;

    const rows = await this.db.all<{
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

  private async queryGroupedByClassificationPath(
    filters?: TransactionFilter
  ): Promise<GroupedTransactionsResult> {
    const { whereSQL, params } = this.buildFilterSQL(filters);
    const validCols = await this.getColumns();
    const hasSpend = validCols.includes('spend_amount');

    const amountExpr = hasSpend
      ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)'
      : '0';

    const sql = `
      SELECT
        tax.full_path as value,
        ${amountExpr} as amount,
        COUNT(*) as count
      FROM transactions t
      LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
      ${whereSQL}
      GROUP BY tax.full_path
      HAVING tax.full_path IS NOT NULL AND tax.full_path != ''
      ORDER BY ${hasSpend ? 'amount DESC' : 'count DESC'}
    `;

    const rows = await this.db.all<{
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

    return { column: 'classification_path', rows: groupedRows, totalAmount, totalCount };
  }
}
