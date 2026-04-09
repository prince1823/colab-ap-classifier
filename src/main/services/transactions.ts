import type {
  Database,
  TransactionStore as ITransactionStore,
  ChangelogStore as IChangelogStore,
  ProjectStore as IProjectStore,
} from '../../shared/types/services';
import { VIRTUAL_COLUMN_REGISTRY, VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';
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
  GroupedFilter,
} from '../../shared/types';
import type { ChangeSource } from '../../shared/types/changelog';
import { buildWhereClause, buildGroupedWhereClause } from '../utils/query-builder';

const BASE_COLUMNS = [
  'id', 'row_index', 'upload_id', 'taxonomy_node_id',
  'classification_status', 'human_reviewed', 'flagged_for_review',
  'original_supplier_name', 'project_supplier_id',
  'applied_rule_id',
  'created_at', 'updated_at',
];

/** Columns that don't exist on transactions but are resolved via JOINs. Derived from VIRTUAL_COLUMN_REGISTRY. */
const VIRTUAL_COLUMNS: Record<string, string> = Object.fromEntries(
  Object.entries(VIRTUAL_COLUMN_REGISTRY).map(([name, def]) => [name, def.selectExpr])
);

const SUPPLIER_JOIN = 'LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id';
/** Must always appear after SUPPLIER_JOIN — depends on the ps alias. */
const SUPPLIER_PARENT_JOIN = 'LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id';
const TAXONOMY_JOIN = 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id';
const RULES_JOIN = 'LEFT JOIN override_rules ar ON t.applied_rule_id = ar.id';
const UPLOAD_JOIN = 'LEFT JOIN uploads upl ON t.upload_id = upl.id';

/** Virtual column → SQL expression for filter/ID-lookup queries. */
const FILTER_VIRTUAL_EXPRS: Record<string, string> = {
  classification_l1: 'tax.l1',
  classification_l2: 'tax.l2',
  classification_l3: 'tax.l3',
  classification_path: "CONCAT_WS(' > ', COALESCE(tax.l1, '(Unclassified)'), COALESCE(tax.l2, ''), COALESCE(tax.l3, ''))",
  supplier_name: 'ps.supplier_name',
  is_researched: 'ps.is_researched',
  is_tail_spend: 'ps.is_tail_spend',
  confirmation_status: 'ps.confirmation_status',
  applied_rule_name: 'ar.name',
  parent_name: 'sp.name',
  source_file: "upl.file_name || ' (' || strftime(upl.created_at, '%Y-%m-%d %H:%M') || ')'",
};

export class TransactionStore implements ITransactionStore {
  private cachedColumns: string[] | null = null;
  private cachedMasterDateExpr: string | undefined = undefined;
  private project?: IProjectStore;

  constructor(
    private db: Database,
    private changelog: IChangelogStore
  ) {}

  /** Break circular dependency: ProjectStore depends on TransactionStore, so inject lazily via setter. */
  setProjectStore(project: IProjectStore): void {
    this.project = project;
  }

  invalidateColumnCache(): void {
    this.cachedColumns = null;
    this.cachedMasterDateExpr = undefined;
  }

  /**
   * Returns a TRY_STRPTIME expression for master_date using the project's detected format.
   * Falls back to a multi-format COALESCE for old projects without a stored format.
   * Result is cached on the instance.
   */
  private async getMasterDateExpr(): Promise<string> {
    if (this.cachedMasterDateExpr !== undefined) return this.cachedMasterDateExpr;
    const fmt = this.project
      ? await this.project.getSetting('master_date_format') as string | undefined
      : undefined;
    this.cachedMasterDateExpr = fmt
      ? `TRY_STRPTIME(t.master_date, '${fmt}')`
      : `COALESCE(TRY_STRPTIME(t.master_date, ['%Y-%m-%d', '%m/%d/%Y', '%d/%m/%Y']), TRY_CAST(t.master_date AS DATE))`;
    return this.cachedMasterDateExpr;
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
    return columns.some((c) =>
      VIRTUAL_COLUMN_REGISTRY[c]?.requiredJoin === 'supplier' ||
      VIRTUAL_COLUMN_REGISTRY[c]?.requiredJoin === 'supplier_parent'
    );
  }

  /** Whether any columns in use require the taxonomy JOIN. */
  private needsTaxonomyJoinForColumns(columns: string[]): boolean {
    return columns.some((c) => c.startsWith('classification_'));
  }

  /** Whether any columns in use require the rules JOIN. */
  private needsRulesJoin(columns: string[]): boolean {
    return columns.some((c) => c === 'applied_rule_name');
  }

  /** Whether any columns in use require the uploads JOIN. */
  private needsUploadJoin(columns: string[]): boolean {
    return columns.some((c) => VIRTUAL_COLUMN_REGISTRY[c]?.requiredJoin === 'upload');
  }

  /** Whether any columns in use require the supplier_parents JOIN (must appear after SUPPLIER_JOIN). */
  private needsSupplierParentJoin(columns: string[]): boolean {
    return columns.some((c) => VIRTUAL_COLUMN_REGISTRY[c]?.requiredJoin === 'supplier_parent');
  }

  private buildFilterSQL(filters?: TransactionFilter): { whereSQL: string; params: unknown[]; needsTaxonomyJoin: boolean; needsSupplierParentJoin: boolean; needsUploadJoin: boolean } {
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

    // Resolve virtual columns used in conditions — use module-level FILTER_VIRTUAL_EXPRS
    // (which has COALESCE variants for display) rather than duplicating the map here.
    const resolver = (field: string) => FILTER_VIRTUAL_EXPRS[field] ?? `t."${field}"`;

    // Check if any conditions reference taxonomy, supplier_parent, or upload columns
    const allConditionFields = filters?.groupedConditions
      ? filters.groupedConditions.groups.flatMap(g => g.conditions.map(c => c.field))
      : (filters?.conditions ?? []).map(c => c.field);
    if (allConditionFields.some(f => f.startsWith('classification_'))) {
      needsTaxonomyJoin = true;
    }
    const needsSupplierParentJoin = allConditionFields.includes('parent_name');
    const needsUploadJoin = allConditionFields.includes('source_file');

    // Prefer groupedConditions (proper parenthesization) over flat conditions
    if (filters?.groupedConditions && filters.groupedConditions.groups.length > 0) {
      const built = buildGroupedWhereClause(filters.groupedConditions, resolver);
      if (built) {
        whereClauses.push(`(${built.sql})`);
        params.push(...built.params);
      }
    } else if (filters?.conditions && filters.conditions.length > 0) {
      const built = buildWhereClause(filters.conditions, resolver);
      if (built) {
        whereClauses.push(`(${built.sql})`);
        params.push(...built.params);
      }
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    return { whereSQL, params, needsTaxonomyJoin, needsSupplierParentJoin, needsUploadJoin };
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
      SELECT t.*, ps.supplier_name, tax.full_path as classification_path, ar.name as applied_rule_name
      FROM transactions t
      ${SUPPLIER_JOIN}
      LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
      ${RULES_JOIN}
      ${whereSQL}
      ORDER BY ${filters?.randomize ? 'RANDOM()' : `t.${safeSortBy} ${safeOrder}`}
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
        humanReviewed: Boolean(row.human_reviewed),
        flaggedForReview: Boolean(row.flagged_for_review),
        appliedRuleId: row.applied_rule_id ? String(row.applied_rule_id) : null,
        appliedRuleName: row.applied_rule_name ? String(row.applied_rule_name) : null,
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
        COUNT(CASE WHEN classification_status IN ('classified_by_ai', 'classified_by_rule', 'classified_by_qc_agent') THEN 1 END) as classified_rows,
        COUNT(CASE WHEN classification_status = 'unclassified' OR classification_status = 'classification_error' THEN 1 END) as unclassified_rows
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
    // Append virtual columns (resolved via JOINs) so consumers see them as available for
    // filtering/display. They are excluded from column_priorities by VIRTUAL_COLUMN_NAMES.
    for (const vc of VIRTUAL_COLUMN_NAMES) {
      if (!physical.includes(vc)) physical.push(vc);
    }
    this.cachedColumns = physical;
    return this.cachedColumns;
  }

  /**
   * Like getColumns(), but also appends master_year and master_month as virtual dimensions
   * when master_date is present. Used by the IPC layer (pivot toolbar discovery).
   * Internal methods use getColumns() directly to avoid SQL resolution issues.
   */
  async getColumnsForPivot(): Promise<string[]> {
    const cols = await this.getColumns();
    if (cols.includes('master_date')) {
      return [...cols, 'master_year', 'master_month'];
    }
    return cols;
  }

  /** Known column types for richer FilterConditionBuilder UI. */
  private static readonly KNOWN_FIELD_TYPES: Record<string, Omit<FieldDefinition, 'name'>> = {
    classification_status: { label: 'Classification Status', type: 'enum', enumValues: ['unclassified', 'classified_by_ai', 'classified_by_rule', 'classified_by_qc_agent', 'classification_error'] },
    human_reviewed: { label: 'Human Reviewed', type: 'boolean' },
    flagged_for_review: { label: 'Flagged for Review', type: 'boolean' },
    spend_amount: { label: 'Spend Amount', type: 'number' },
    supplier_name: { label: 'Supplier Name', type: 'string', group: 'Supplier' },
    parent_name: { label: 'Parent Name', type: 'string', group: 'Supplier' },
    is_researched: { label: 'Researched', type: 'boolean', group: 'Supplier' },
    is_tail_spend: { label: 'Tail Spend', type: 'boolean', group: 'Supplier' },
    confirmation_status: { label: 'Confirmation Status', type: 'enum', enumValues: ['pending', 'confirmed', 'rejected', 'merged'], group: 'Supplier' },
    classification_l1: { label: 'Classification L1', type: 'string' },
    classification_l2: { label: 'Classification L2', type: 'string' },
    classification_l3: { label: 'Classification L3', type: 'string' },
    applied_rule_name: { label: 'Applied Rule', type: 'string' },
    source_file: { label: 'Source File', type: 'string', group: 'Upload' },
  };

  async getFilterFields(): Promise<FieldDefinition[]> {
    const columns = await this.getColumns();
    // Exclude internal columns not useful for filtering
    const excluded = new Set(['id', 'row_index', 'upload_id', 'taxonomy_node_id', 'project_supplier_id', 'applied_rule_id', 'created_at', 'updated_at']);
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
    // Add virtual dimensions (classification levels) if not already present.
    // Supplier virtual fields (supplier_name, is_researched, is_tail_spend, parent_name) are
    // included automatically via getColumns() → VIRTUAL_COLUMN_NAMES.
    for (const virt of ['classification_l1', 'classification_l2', 'classification_l3']) {
      if (!fields.some(f => f.name === virt)) {
        const known = TransactionStore.KNOWN_FIELD_TYPES[virt]!;
        fields.push({ name: virt, ...known });
      }
    }
    return fields;
  }

  async getCount(filters?: TransactionFilter): Promise<number> {
    const { whereSQL, params, needsTaxonomyJoin, needsSupplierParentJoin, needsUploadJoin } = this.buildFilterSQL(filters);
    const taxonomyJoin = needsTaxonomyJoin ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id' : '';
    const supplierParentJoin = needsSupplierParentJoin ? SUPPLIER_PARENT_JOIN : '';
    const uploadJoin = needsUploadJoin ? UPLOAD_JOIN : '';
    const sql = `SELECT COUNT(*) as cnt FROM transactions t ${SUPPLIER_JOIN} ${supplierParentJoin} ${taxonomyJoin} ${uploadJoin} ${whereSQL}`;
    const result = await this.db.get<{ cnt: number | bigint }>(sql, ...params);
    return Number(result?.cnt ?? 0);
  }

  async updateTransactions(update: TransactionUpdate, source: ChangeSource = 'manual'): Promise<string | undefined> {
    if (!update.ids || update.ids.length === 0) return undefined;

    // For large ID sets, avoid spreading thousands of args (causes call stack overflow).
    // Instead, insert IDs into a temp table and use a subquery.
    const BULK_THRESHOLD = 5_000;
    const useTempTable = update.ids.length > BULK_THRESHOLD;
    let tempTableName: string | null = null;
    let idsCondition: string;
    let idsParams: unknown[];

    if (useTempTable) {
      const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      tempTableName = `_upd_ids_${runId}`;
      await this.db.run(`CREATE TEMP TABLE ${tempTableName} (id VARCHAR PRIMARY KEY)`);
      for (let i = 0; i < update.ids.length; i += 10_000) {
        const chunk = update.ids.slice(i, i + 10_000);
        const ph = chunk.map(() => '(?)').join(',');
        await this.db.run(`INSERT INTO ${tempTableName} VALUES ${ph}`, ...chunk);
      }
      idsCondition = `id IN (SELECT id FROM ${tempTableName})`;
      idsParams = [];
    } else {
      idsCondition = `id IN (${update.ids.map(() => '?').join(',')})`;
      idsParams = update.ids;
    }

    try {
    const oldRows = await this.db.all<Record<string, unknown>>(
      `SELECT t.id, t.taxonomy_node_id, t.classification_status, ps.supplier_name
       FROM transactions t
       LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
       WHERE t.${idsCondition}`,
      ...idsParams
    );

    const oldValues: Record<string, unknown> = {};
    if (oldRows.length > 0) {
      // Store representative values (first row) for display summary
      oldValues.taxonomy_node_id = oldRows[0].taxonomy_node_id;
      oldValues.classification_status = oldRows[0].classification_status;

      // Store per-transaction old values so revert restores each row accurately
      const perTransaction: Record<string, Record<string, unknown>> = {};
      for (const row of oldRows) {
        perTransaction[row.id as string] = {
          taxonomy_node_id: row.taxonomy_node_id,
          classification_status: row.classification_status,
          supplier_name: row.supplier_name ?? null,
        };
      }
      oldValues._perTransaction = perTransaction;
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
    if (update.flaggedForReview !== undefined) {
      setClauses.push('flagged_for_review = ?');
      params.push(update.flaggedForReview);
      newValues.flagged_for_review = update.flaggedForReview;
    }
    if (update.appliedRuleId !== undefined) {
      setClauses.push('applied_rule_id = ?');
      params.push(update.appliedRuleId);
      newValues.applied_rule_id = update.appliedRuleId;
    }
    if (setClauses.length === 0) return undefined;
    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    await this.db.run(
      `UPDATE transactions SET ${setClauses.join(', ')} WHERE ${idsCondition}`,
      ...params, ...idsParams
    );

    // Only log classification changes (taxonomy / status) — not internal signals like flagged_for_review
    const hasClassificationChange = newValues.taxonomy_node_id !== undefined || newValues.classification_status !== undefined;
    if (!hasClassificationChange) return undefined;

    // Build a descriptive changelog message with supplier names and classification
    let description = `Reclassified ${update.ids.length} transaction(s)`;
    try {
      // Get all distinct supplier names from affected transactions
      const supplierRows = await this.db.all<{ supplier_name: string }>(
        `SELECT DISTINCT ps.supplier_name FROM transactions t
         LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
         WHERE t.${idsCondition} AND ps.supplier_name IS NOT NULL`,
        ...idsParams
      );
      // Get target classification path
      let classPath: string | null = null;
      if (update.taxonomyNodeId) {
        const taxRow = await this.db.get<{ full_path: string }>(
          'SELECT full_path FROM taxonomy WHERE id = ?',
          update.taxonomyNodeId
        );
        if (taxRow) classPath = taxRow.full_path.split('|').map(s => s.trim()).join(' > ');
      }

      const parts: string[] = [];
      // Include supplier names from query and/or filter context for searchability
      const supplierNames = supplierRows.map(r => r.supplier_name);
      if (supplierNames.length > 0) {
        const displayNames = supplierNames.length <= 3
          ? supplierNames.join(', ')
          : `${supplierNames.slice(0, 3).join(', ')} +${supplierNames.length - 3} more`;
        parts.push(displayNames);
      }
      parts.push(`${update.ids.length} txn${update.ids.length !== 1 ? 's' : ''}`);
      if (classPath) parts.push(`→ ${classPath}`);
      description = parts.join(' ');
    } catch { /* fall back to generic description */ }

    const changelogId = await this.changelog.logChange({
      source,
      affectedTable: 'transactions',
      affectedIds: update.ids,
      affectedCount: update.ids.length,
      oldValues,
      newValues,
      description,
      filterContext: update.filterContext ?? null,
      ruleId: update.appliedRuleId ?? null,
    });
    return changelogId;
    } finally {
      if (tempTableName) {
        try { await this.db.run(`DROP TABLE IF EXISTS ${tempTableName}`); } catch { /* ignore */ }
      }
    }
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

    const { whereSQL, params, needsTaxonomyJoin, needsSupplierParentJoin: filterNeedsParentJoin, needsUploadJoin: filterNeedsUpload } = this.buildFilterSQL(filters);
    const hasSpend = validCols.includes('spend_amount');
    const colExpr = this.resolveColumn(column);
    const supplierJoin = this.needsSupplierJoin([column]) ? SUPPLIER_JOIN : '';
    const supplierParentJoin = (filterNeedsParentJoin || this.needsSupplierParentJoin([column])) ? SUPPLIER_PARENT_JOIN : '';
    const taxonomyJoin = (needsTaxonomyJoin || this.needsTaxonomyJoinForColumns([column])) ? TAXONOMY_JOIN : '';
    const uploadJoin = (filterNeedsUpload || this.needsUploadJoin([column])) ? UPLOAD_JOIN : '';

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
      ${supplierParentJoin}
      ${taxonomyJoin}
      ${uploadJoin}
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
    const supplierParentJoin = this.needsSupplierParentJoin([column]) ? SUPPLIER_PARENT_JOIN : '';
    const taxonomyJoin = this.needsTaxonomyJoinForColumns([column]) ? TAXONOMY_JOIN : '';
    const rulesJoin = this.needsRulesJoin([column]) ? RULES_JOIN : '';
    const uploadJoin = this.needsUploadJoin([column]) ? UPLOAD_JOIN : '';

    const sql = `
      SELECT DISTINCT CAST(${colExpr} AS VARCHAR) as value
      FROM transactions t
      ${supplierJoin}
      ${supplierParentJoin}
      ${taxonomyJoin}
      ${rulesJoin}
      ${uploadJoin}
      WHERE ${colExpr} IS NOT NULL
      ORDER BY value
      LIMIT ${limit}
    `;

    const rows = await this.db.all<{ value: string }>(sql);
    return rows.map((r) => String(r.value));
  }

  /**
   * Return the count of distinct non-null values for a column.
   */
  async countDistinctValues(column: string): Promise<number> {
    const validCols = await this.getColumns();
    if (!this.isValidColumn(column, validCols)) return 0;

    const colExpr = this.resolveColumn(column);
    const supplierJoin = this.needsSupplierJoin([column]) ? SUPPLIER_JOIN : '';
    const supplierParentJoin = this.needsSupplierParentJoin([column]) ? SUPPLIER_PARENT_JOIN : '';
    const taxonomyJoin = this.needsTaxonomyJoinForColumns([column]) ? TAXONOMY_JOIN : '';
    const rulesJoin = this.needsRulesJoin([column]) ? RULES_JOIN : '';
    const uploadJoin = this.needsUploadJoin([column]) ? UPLOAD_JOIN : '';

    const sql = `
      SELECT COUNT(DISTINCT CAST(${colExpr} AS VARCHAR)) as cnt
      FROM transactions t
      ${supplierJoin}
      ${supplierParentJoin}
      ${taxonomyJoin}
      ${rulesJoin}
      ${uploadJoin}
      WHERE ${colExpr} IS NOT NULL
    `;

    const rows = await this.db.all<{ cnt: number }>(sql);
    return rows.length > 0 ? Number(rows[0].cnt) : 0;
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

    const { whereSQL, params, needsTaxonomyJoin, needsSupplierParentJoin: filterNeedsParentJoin, needsUploadJoin: filterNeedsUpload } = this.buildFilterSQL(filters);
    const colExpr = this.resolveColumn(column);
    const supplierJoin = this.needsSupplierJoin([column]) ? SUPPLIER_JOIN : '';
    const supplierParentJoin = (filterNeedsParentJoin || this.needsSupplierParentJoin([column])) ? SUPPLIER_PARENT_JOIN : '';
    const taxonomyJoin = (needsTaxonomyJoin || this.needsTaxonomyJoinForColumns([column])) ? TAXONOMY_JOIN : '';
    const uploadJoin = (filterNeedsUpload || this.needsUploadJoin([column])) ? UPLOAD_JOIN : '';

    const valueCondition = value === '(blank)'
      ? `${colExpr} IS NULL`
      : `CAST(${colExpr} AS VARCHAR) = ?`;
    if (value !== '(blank)') params.push(value);

    const fullWhere = whereSQL
      ? `${whereSQL} AND ${valueCondition}`
      : `WHERE ${valueCondition}`;

    const sql = `SELECT CAST(t.id AS VARCHAR) as id FROM transactions t ${supplierJoin} ${supplierParentJoin} ${taxonomyJoin} ${uploadJoin} ${fullWhere}`;
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

    const masterDateExpr = await this.getMasterDateExpr();
    const PIVOT_VIRTUAL_DIMS: Record<string, string> = {
      classification_l1: "COALESCE(tax.l1, '(Unclassified)')",
      classification_l2: "COALESCE(tax.l2, '(Unclassified)')",
      classification_l3: "COALESCE(tax.l3, '(Unclassified)')",
      classification_path: "CONCAT_WS(' > ', COALESCE(tax.l1, '(Unclassified)'), COALESCE(tax.l2, ''), COALESCE(tax.l3, ''))",
      supplier_name: "COALESCE(ps.supplier_name, '')",
      parent_name: "COALESCE(sp.name, '')",
      applied_rule_name: "COALESCE(ar.name, '')",
      source_file: "COALESCE(upl.file_name || ' (' || strftime(upl.created_at, '%Y-%m-%d %H:%M') || ')', '')",
      master_year: `YEAR(${masterDateExpr})`,
      master_month: `strftime('%B', ${masterDateExpr})`,
    };

    const validCols = await this.getColumns();
    const safeDimensions = dimensions.filter(
      (d) => validCols.includes(d) || d in PIVOT_VIRTUAL_DIMS
    );
    if (!safeDimensions.length) {
      return { dimensionColumns: dimensions, rows: [], totalAmount: 0, totalCount: 0 };
    }

    const { whereSQL, params, needsTaxonomyJoin: filterNeedsTaxonomy, needsUploadJoin: filterNeedsUpload } = this.buildFilterSQL(filters);
    const hasValue = validCols.includes(valueDimension);

    const amountExpr = hasValue
      ? `COALESCE(SUM(TRY_CAST(t.${valueDimension} AS DOUBLE)), 0)`
      : '0';

    const needsTaxonomyJoin = filterNeedsTaxonomy || safeDimensions.some((d) =>
      d.startsWith('classification_')
    );
    const taxonomyJoin = needsTaxonomyJoin
      ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id'
      : '';
    const supplierJoin = this.needsSupplierJoin(safeDimensions) ? SUPPLIER_JOIN : '';
    const supplierParentJoin = this.needsSupplierParentJoin(safeDimensions) ? SUPPLIER_PARENT_JOIN : '';
    const rulesJoin = this.needsRulesJoin(safeDimensions) ? RULES_JOIN : '';
    const uploadJoin = (filterNeedsUpload || this.needsUploadJoin(safeDimensions)) ? UPLOAD_JOIN : '';

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
      ${supplierParentJoin}
      ${taxonomyJoin}
      ${rulesJoin}
      ${uploadJoin}
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
    const resolveColumn = (field: string) =>
      FILTER_VIRTUAL_EXPRS[field] ?? `t."${field}"`;

    const built = buildWhereClause(conditions, resolveColumn);
    if (!built) return [];

    const needsTaxonomy = conditions.some((c) => c.field.startsWith('classification_'));
    const taxonomyJoin = needsTaxonomy
      ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id'
      : '';
    const rulesJoin = conditions.some((c) => c.field === 'applied_rule_name') ? RULES_JOIN : '';
    const supplierParentJoin = conditions.some((c) => c.field === 'parent_name') ? SUPPLIER_PARENT_JOIN : '';
    const uploadJoin = conditions.some((c) => c.field === 'source_file') ? UPLOAD_JOIN : '';

    let sql = `SELECT t.id FROM transactions t ${SUPPLIER_JOIN} ${supplierParentJoin} ${taxonomyJoin} ${rulesJoin} ${uploadJoin} WHERE (${built.sql})`;
    const params = [...built.params];

    if (scopeToIds && scopeToIds.length > 0) {
      sql += ` AND t.id IN (${scopeToIds.map(() => '?').join(',')})`;
      params.push(...scopeToIds);
    }

    const rows = await this.db.all<{ id: string }>(sql, ...params);
    return rows.map((r) => String(r.id));
  }

  /**
   * Return transaction IDs matching grouped filter conditions (preserving AND/OR group logic).
   */
  async getIdsByGroupedConditions(
    grouped: GroupedFilter,
    scopeToIds?: string[]
  ): Promise<string[]> {
    const resolveColumn = (field: string) =>
      FILTER_VIRTUAL_EXPRS[field] ?? `t."${field}"`;

    const built = buildGroupedWhereClause(grouped, resolveColumn);
    if (!built) return [];

    const allConditions = grouped.groups.flatMap(g => g.conditions);
    const needsTaxonomy = allConditions.some((c) => c.field.startsWith('classification_'));
    const taxonomyJoin = needsTaxonomy
      ? 'LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id'
      : '';
    const rulesJoin = allConditions.some((c) => c.field === 'applied_rule_name') ? RULES_JOIN : '';
    const supplierParentJoin = allConditions.some((c) => c.field === 'parent_name') ? SUPPLIER_PARENT_JOIN : '';
    const uploadJoin = allConditions.some((c) => c.field === 'source_file') ? UPLOAD_JOIN : '';

    let sql = `SELECT t.id FROM transactions t ${SUPPLIER_JOIN} ${supplierParentJoin} ${taxonomyJoin} ${rulesJoin} ${uploadJoin} WHERE (${built.sql})`;
    const params = [...built.params];

    if (scopeToIds && scopeToIds.length > 0) {
      sql += ` AND t.id IN (${scopeToIds.map(() => '?').join(',')})`;
      params.push(...scopeToIds);
    }

    const rows = await this.db.all<{ id: string }>(sql, ...params);
    return rows.map((r) => String(r.id));
  }

  /**
   * Applies a rule's conditions to matching transactions.
   * Caller (RuleStore) is responsible for ensuring ruleId exists.
   */
  async applyRule(
    ruleId: string,
    groupedConditions: GroupedFilter,
    targetTaxonomyNodeId: string
  ): Promise<number> {
    const rule = await this.db.get<{ id: string }>('SELECT id FROM override_rules WHERE id = ?', ruleId);
    if (!rule) throw new Error(`Rule not found: ${ruleId}`);

    const ids = await this.getIdsByGroupedConditions(groupedConditions);
    if (ids.length === 0) return 0;

    await this.updateTransactions(
      { ids, taxonomyNodeId: targetTaxonomyNodeId, classificationStatus: 'classified_by_rule', appliedRuleId: ruleId },
      'rule'
    );
    return ids.length;
  }

    async getSpendByTaxonomy(supplierId: string): Promise<import('../../shared/types/classification').SpendByTaxonomyResult[]> {
    const columns = await this.getColumns();
    if (!columns.includes('spend_amount')) {
      throw new Error("spend_amount column not found in transactions table. Ensure your CSV import maps a column to spend_amount.");
    }

    const CLASSIFIED_STATUSES = `('classified_by_ai', 'classified_by_rule', 'classified_by_qc_agent')`;
    const rows = await this.db.all<{
      taxonomy_node_id: string;
      full_path: string;
      l1: string;
      l2: string;
      spend: number;
      txn_count: number;
    }>(
      `SELECT CAST(t.taxonomy_node_id AS VARCHAR) as taxonomy_node_id,
              tax.full_path,
              tax.l1,
              tax.l2,
              COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) as spend,
              COUNT(*) as txn_count
       FROM transactions t
       LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}
         AND t.taxonomy_node_id IS NOT NULL
       GROUP BY t.taxonomy_node_id, tax.full_path, tax.l1, tax.l2`,
      supplierId
    );

    if (rows.length === 0) {
      throw new Error(`No classified transactions found for supplier ${supplierId}`);
    }

    return rows.map((r) => ({
      taxonomyNodeId: r.taxonomy_node_id,
      fullPath: r.full_path ?? '',
      l1: r.l1 ?? '',
      l2: r.l2 ?? '',
      spend: r.spend,
      txnCount: Number(r.txn_count),
    }));
  }

  async getTransactionsByTaxonomy(
    supplierId: string,
    taxonomyNodeId: string,
    columnPriorities: string[]
  ): Promise<Array<Record<string, unknown>>> {
    const CLASSIFIED_STATUSES = `('classified_by_ai', 'classified_by_rule', 'classified_by_qc_agent')`;

    // Resolve virtual columns (e.g., supplier_name → ps.supplier_name) and add JOINs
    const cols = columnPriorities.length > 0
      ? ['t.id', ...columnPriorities.filter((c) => c !== 'id').map((c) => `${this.resolveColumn(c)} AS ${c}`)]
      : ['t.*'];
    const selectCols = cols.join(', ');

    const supplierJoin = this.needsSupplierJoin(columnPriorities) ? SUPPLIER_JOIN : '';
    const taxonomyJoin = this.needsTaxonomyJoinForColumns(columnPriorities) ? TAXONOMY_JOIN : '';

    return this.db.all<Record<string, unknown>>(
      `SELECT ${selectCols}
       FROM transactions t
       ${supplierJoin}
       ${taxonomyJoin}
       WHERE CAST(t.project_supplier_id AS VARCHAR) = ?
         AND CAST(t.taxonomy_node_id AS VARCHAR) = ?
         AND t.classification_status IN ${CLASSIFIED_STATUSES}`,
      supplierId,
      taxonomyNodeId
    );
  }

  async queryBySupplier(supplierId: string, statusFilter?: string | string[]): Promise<Record<string, unknown>[]> {
    let sql = 'SELECT * FROM transactions WHERE project_supplier_id = ?';
    const params: unknown[] = [supplierId];

    if (statusFilter) {
      const statuses = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
      sql += ` AND classification_status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }

    return this.db.all<Record<string, unknown>>(sql, ...params);
  }

  async getIdsBySupplier(supplierId: string, options?: {
    statuses?: string[];
    excludeTaxonomyNodeId?: string;
    requireTaxonomyNode?: boolean;
  }): Promise<string[]> {
    let sql = 'SELECT CAST(id AS VARCHAR) as id FROM transactions t WHERE CAST(t.project_supplier_id AS VARCHAR) = ?';
    const params: unknown[] = [supplierId];

    if (options?.statuses && options.statuses.length > 0) {
      sql += ` AND t.classification_status IN (${options.statuses.map(() => '?').join(',')})`;
      params.push(...options.statuses);
    }

    if (options?.excludeTaxonomyNodeId) {
      sql += ' AND CAST(t.taxonomy_node_id AS VARCHAR) != ?';
      params.push(options.excludeTaxonomyNodeId);
    }

    if (options?.requireTaxonomyNode) {
      sql += ' AND t.taxonomy_node_id IS NOT NULL';
    }

    const rows = await this.db.all<{ id: string }>(sql, ...params);
    return rows.map((r) => r.id);
  }

  async markAllReviewed(): Promise<number> {
    const result = await this.db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM transactions WHERE human_reviewed = FALSE"
    );
    const count = Number(result?.cnt ?? 0);
    if (count > 0) {
      await this.db.run(
        "UPDATE transactions SET human_reviewed = TRUE, updated_at = CURRENT_TIMESTAMP WHERE human_reviewed = FALSE"
      );
    }
    return count;
  }

  async getSupplierAddress(supplierId: string): Promise<string | undefined> {
    // supplier_address is an optional dynamic column — only present if the CSV mapped it
    const cols = await this.getColumns();
    if (!cols.includes('supplier_address')) return undefined;

    const row = await this.db.get<{ supplier_address: string }>(
      `SELECT supplier_address FROM transactions
       WHERE project_supplier_id = ?
         AND supplier_address IS NOT NULL AND supplier_address != ''
       LIMIT 1`,
      supplierId
    );
    return row?.supplier_address;
  }
}
