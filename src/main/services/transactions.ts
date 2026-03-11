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
  FilterCondition,
  FieldDefinition,
} from '../../shared/types';
import type { ChangeSource } from '../../shared/types/changelog';
import { buildWhereClause } from '../utils/query-builder';

const BASE_COLUMNS = [
  'id', 'row_index', 'upload_id', 'taxonomy_node_id',
  'classification_status', 'human_reviewed', 'classification_reasoning',
  'original_supplier_name', 'project_supplier_id',
  'created_at', 'updated_at',
];

/** Columns that don't exist on transactions but are resolved via JOINs. */
const VIRTUAL_COLUMNS: Record<string, string> = {
  supplier_name: 'ps.supplier_name',
};

const SUPPLIER_JOIN = 'LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id';

export class TransactionStore implements ITransactionStore {
  private cachedColumns: string[] | null = null;

  constructor(
    private db: Database,
    private changelog: IChangelogStore
  ) {}

  invalidateColumnCache(): void {
    this.cachedColumns = null;
  }

  /** Check if a column is valid (physical on transactions or virtual via JOIN). */
  private isValidColumn(column: string, physicalCols: string[]): boolean {
    return physicalCols.includes(column) || column in VIRTUAL_COLUMNS;
  }

  /** Resolve a column name to its SQL expression (handles virtual columns). */
  private resolveColumn(column: string): string {
    return VIRTUAL_COLUMNS[column] ?? `t.${column}`;
  }

  /** Whether any columns in use require the supplier JOIN. */
  private needsSupplierJoin(columns: string[]): boolean {
    return columns.some((c) => c in VIRTUAL_COLUMNS);
  }

  private buildFilterSQL(filters?: TransactionFilter): { whereSQL: string; params: unknown[]; needsTaxonomyJoin: boolean } {
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let needsTaxonomyJoin = false;

    if (filters?.supplierName) {
      whereClauses.push('ps.supplier_name = ?');
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
      if (filters.conditions.some((c) => c.field.startsWith('classification_l'))) {
        needsTaxonomyJoin = true;
      }
      const FILTER_VIRTUAL_DIMS: Record<string, string> = {
        classification_l1: 'tax.l1',
        classification_l2: 'tax.l2',
        classification_l3: 'tax.l3',
        supplier_name: 'ps.supplier_name',
        is_researched: 'ps.is_researched',
      };
      const resolver = (field: string) => FILTER_VIRTUAL_DIMS[field] ?? `t."${field}"`;
      const built = buildWhereClause(filters.conditions, resolver);
      if (built) {
        whereClauses.push(`(${built.sql})`);
        params.push(...built.params);
      }
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    return { whereSQL, params, needsTaxonomyJoin };
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
      SELECT t.*, ps.supplier_name, tax.full_path as classification_path
      FROM transactions t
      ${SUPPLIER_JOIN}
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
    const physical = rows.map((r) => r.column_name);
    // Include virtual columns (resolved via JOINs) so consumers see them as available
    for (const vc of Object.keys(VIRTUAL_COLUMNS)) {
      if (!physical.includes(vc)) physical.push(vc);
    }
    this.cachedColumns = physical;
    return this.cachedColumns;
  }

  /** Known column types for richer FilterConditionBuilder UI. */
  private static readonly KNOWN_FIELD_TYPES: Record<string, Omit<FieldDefinition, 'name'>> = {
    classification_status: { label: 'Classification Status', type: 'enum', enumValues: ['unclassified', 'classified_by_ai', 'classified_by_rule', 'classification_failed'] },
    human_reviewed: { label: 'Human Reviewed', type: 'boolean' },
    spend_amount: { label: 'Spend Amount', type: 'number' },
    supplier_name: { label: 'Supplier Name', type: 'string', group: 'Supplier' },
    is_researched: { label: 'Researched', type: 'boolean', group: 'Supplier' },
    classification_l1: { label: 'Classification L1', type: 'string' },
    classification_l2: { label: 'Classification L2', type: 'string' },
    classification_l3: { label: 'Classification L3', type: 'string' },
  };

  async getFilterFields(): Promise<FieldDefinition[]> {
    const columns = await this.getColumns();
    // Exclude internal columns not useful for filtering
    const excluded = new Set(['id', 'row_index', 'upload_id', 'taxonomy_node_id', 'project_supplier_id', 'created_at', 'updated_at']);
    const fields: FieldDefinition[] = [];
    for (const col of columns) {
      if (excluded.has(col)) continue;
      const known = TransactionStore.KNOWN_FIELD_TYPES[col];
      if (known) {
        fields.push({ name: col, ...known });
      } else {
        // Dynamic canonical columns — default to string, humanize the label
        fields.push({ name: col, label: col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), type: 'string' });
      }
    }
    // Add virtual dimensions (classification levels, supplier fields) if not already present
    for (const virt of ['classification_l1', 'classification_l2', 'classification_l3', 'is_researched']) {
      if (!fields.some(f => f.name === virt)) {
        const known = TransactionStore.KNOWN_FIELD_TYPES[virt]!;
        fields.push({ name: virt, ...known });
      }
    }
    return fields;
  }

  async getCount(filters?: TransactionFilter): Promise<number> {
    const { whereSQL, params, needsTaxonomyJoin } = this.buildFilterSQL(filters);
    const taxonomyJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';
    const sql = `SELECT COUNT(*) as cnt FROM transactions t ${SUPPLIER_JOIN} ${taxonomyJoin} ${whereSQL}`;
    const result = await this.db.get<{ cnt: number | bigint }>(sql, ...params);
    return Number(result?.cnt ?? 0);
  }

  async updateTransactions(update: TransactionUpdate, source: ChangeSource = 'manual'): Promise<string | undefined> {
    if (!update.ids || update.ids.length === 0) return undefined;

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

    if (setClauses.length === 0) return undefined;
    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    await this.db.run(
      `UPDATE transactions SET ${setClauses.join(', ')} WHERE id IN (${placeholders})`,
      ...params, ...update.ids
    );

    const changelogId = await this.changelog.logChange({
      source,
      affectedTable: 'transactions',
      affectedIds: update.ids,
      affectedCount: update.ids.length,
      oldValues,
      newValues,
      description: `Updated ${update.ids.length} transaction(s)`,
    });
    return changelogId;
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
    if (!this.isValidColumn(column, validCols)) {
      return { column, rows: [], totalAmount: 0, totalCount: 0 };
    }

    const { whereSQL, params, needsTaxonomyJoin } = this.buildFilterSQL(filters);
    const hasSpend = validCols.includes('spend_amount');
    const colExpr = this.resolveColumn(column);
    const supplierJoin = this.needsSupplierJoin([column]) ? SUPPLIER_JOIN : '';
    const taxonomyJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';

    const amountExpr = hasSpend
      ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)'
      : '0';

    const sql = `
      SELECT
        COALESCE(CAST(${colExpr} AS VARCHAR), '(blank)') as value,
        ${amountExpr} as amount,
        COUNT(*) as count
      FROM transactions t
      ${supplierJoin}
      ${taxonomyJoin}
      ${whereSQL}
      GROUP BY ${colExpr}
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
    if (!this.isValidColumn(column, validCols)) return [];

    const colExpr = this.resolveColumn(column);
    const supplierJoin = this.needsSupplierJoin([column]) ? SUPPLIER_JOIN : '';

    const sql = `
      SELECT DISTINCT CAST(${colExpr} AS VARCHAR) as value
      FROM transactions t
      ${supplierJoin}
      WHERE ${colExpr} IS NOT NULL
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
    if (!this.isValidColumn(column, validCols)) return [];

    const { whereSQL, params, needsTaxonomyJoin } = this.buildFilterSQL(filters);
    const colExpr = this.resolveColumn(column);
    const supplierJoin = this.needsSupplierJoin([column]) ? SUPPLIER_JOIN : '';
    const taxonomyJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';

    const valueCondition = value === '(blank)'
      ? `${colExpr} IS NULL`
      : `CAST(${colExpr} AS VARCHAR) = ?`;
    if (value !== '(blank)') params.push(value);

    const fullWhere = whereSQL
      ? `${whereSQL} AND ${valueCondition}`
      : `WHERE ${valueCondition}`;

    const sql = `SELECT CAST(t.id AS VARCHAR) as id FROM transactions t ${supplierJoin} ${taxonomyJoin} ${fullWhere}`;
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

    const PIVOT_VIRTUAL_DIMS: Record<string, string> = {
      classification_l1: "COALESCE(tax.l1, '(Unclassified)')",
      classification_l2: "COALESCE(tax.l2, '(Unclassified)')",
      classification_l3: "COALESCE(tax.l3, '(Unclassified)')",
      supplier_name: "COALESCE(ps.supplier_name, '')",
    };

    const validCols = await this.getColumns();
    const safeDimensions = dimensions.filter(
      (d) => validCols.includes(d) || d in PIVOT_VIRTUAL_DIMS
    );
    if (!safeDimensions.length) {
      return { dimensionColumns: dimensions, rows: [], totalAmount: 0, totalCount: 0 };
    }

    const { whereSQL, params, needsTaxonomyJoin: filterNeedsTaxonomy } = this.buildFilterSQL(filters);
    const hasValue = validCols.includes(valueDimension);

    const amountExpr = hasValue
      ? `COALESCE(SUM(TRY_CAST(t.${valueDimension} AS DOUBLE)), 0)`
      : '0';

    const needsTaxonomyJoin = filterNeedsTaxonomy || safeDimensions.some((d) =>
      d.startsWith('classification_l')
    );
    const taxonomyJoin = needsTaxonomyJoin
      ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id'
      : '';
    const supplierJoin = this.needsSupplierJoin(safeDimensions) ? SUPPLIER_JOIN : '';

    const dimSelects = safeDimensions.map((d, i) => {
      const expr = PIVOT_VIRTUAL_DIMS[d] ?? `COALESCE(CAST(t.${d} AS VARCHAR), '')`;
      return `${expr} as dim_${i}`;
    });
    const dimGroupBy = safeDimensions.map((_, i) => `dim_${i}`);

    const sql = `
      SELECT
        ${dimSelects.join(',\n        ')},
        ${amountExpr} as amount,
        COUNT(*) as count
      FROM transactions t
      ${supplierJoin}
      ${taxonomyJoin}
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

  /**
   * Return transaction IDs matching the given filter conditions.
   * Handles JOINs for virtual columns: supplier_name, classification_l1/l2/l3.
   */
  async getIdsByConditions(
    conditions: FilterCondition[],
    scopeToIds?: string[]
  ): Promise<string[]> {
    /** Virtual dim → SQL expression (same as pivot aggregation) */
    const VIRTUAL_DIM_EXPRS: Record<string, string> = {
      classification_l1: 'tax.l1',
      classification_l2: 'tax.l2',
      classification_l3: 'tax.l3',
      supplier_name: 'ps.supplier_name',
      is_researched: 'ps.is_researched',
    };

    const resolveColumn = (field: string) =>
      VIRTUAL_DIM_EXPRS[field] ?? `t."${field}"`;

    const built = buildWhereClause(conditions, resolveColumn);
    if (!built) return [];

    const needsTaxonomy = conditions.some((c) => c.field.startsWith('classification_l'));
    const taxonomyJoin = needsTaxonomy
      ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id'
      : '';

    let sql = `SELECT t.id FROM transactions t ${SUPPLIER_JOIN} ${taxonomyJoin} WHERE (${built.sql})`;
    const params = [...built.params];

    if (scopeToIds && scopeToIds.length > 0) {
      sql += ` AND t.id IN (${scopeToIds.map(() => '?').join(',')})`;
      params.push(...scopeToIds);
    }

    const rows = await this.db.all<{ id: string }>(sql, ...params);
    return rows.map((r) => String(r.id));
  }
}
