import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { parse as parseStream } from 'csv-parse';
import { cleanSupplierName } from '../utils/supplier-name';
import type {
  Database,
  SupplierUniverse,
  SupplierService as ISupplierService,
} from '../../shared/types/services';
import type {
  ProjectSupplier,
  ProjectSupplierView,
  SupplierConfirmationStatus,
  SupplierUpdateInput,
  SupplierParent,
  CsvApplyRow,
  CsvApplyDiff,
  CsvApplyResult,
  SupplierPaginationParams,
  PaginatedSuppliers,
} from '../../shared/types/suppliers';
import type { FilterCondition, GroupedFilter, FieldDefinition } from '../../shared/types/transactions';

/** Safely parse a JSON string, returning null on failure */
function safeParseJSON<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

/** Parse a value that should be string[] — handles both JSON arrays and plain strings (legacy data) */
function safeParseStringArray(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    // Legacy data stored as plain string, not JSON
    return [value];
  }
}
import { buildWhereClause, buildGroupedWhereClause, type ColumnResolver } from '../utils/query-builder';

export class SupplierService implements ISupplierService {
  constructor(
    private db: Database,
    private supplierUniverse: SupplierUniverse
  ) {}

  /**
   * Core find-or-create: check existing by cleaned name → check universe variants → create.
   * Returns { id, created } so callers can track whether a new supplier was made.
   */
  private async findOrCreateSupplier(rawName: string): Promise<{ id: string; created: boolean }> {
    const cleanedName = cleanSupplierName(rawName);

    // Case-insensitive lookup against cleaned supplier names
    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
      cleanedName
    );
    if (existing) return { id: existing.id, created: false };

    // Check universe for variants/aliases
    const variants = await this.supplierUniverse.searchVariants(rawName);
    if (variants.length > 0) {
      for (const variant of variants) {
        const variantRow = await this.db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
          cleanSupplierName(variant)
        );
        if (variantRow) return { id: variantRow.id, created: false };
      }
    }

    // Create a new project supplier using the cleaned name as the canonical name
    const id = uuidv4();
    const universeInfo = await this.supplierUniverse.getSupplier(rawName);
    await this.db.run(
      `INSERT INTO project_suppliers (id, supplier_name, universe_match)
       VALUES (?, ?, ?)`,
      id,
      cleanedName,
      universeInfo ? true : false
    );

    return { id, created: true };
  }

  async normalizeSupplierName(rawName: string, aliasMap?: Map<string, string>): Promise<string> {
    const cleanedName = cleanSupplierName(rawName);

    // Fast path: exact match by cleaned name
    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
      cleanedName
    );
    if (existing) return existing.id;

    // Check existing project-local aliases — if this raw name (case-insensitive) was
    // already mapped to a supplier, link to that supplier without creating a new one.
    // In bulk mode (normalizeAllTransactions), aliasMap is pre-built for O(1) lookup.
    // In standalone mode, fall back to a DB query.
    if (aliasMap) {
      const supplierId = aliasMap.get(rawName.toLowerCase());
      if (supplierId) return supplierId;
    } else {
      const aliasMatch = await this.db.get<{ project_supplier_id: string }>(
        `SELECT DISTINCT t.project_supplier_id
         FROM transactions t
         WHERE lower(t.original_supplier_name) = lower(?)
         AND t.project_supplier_id IS NOT NULL
         LIMIT 1`,
        rawName
      );
      if (aliasMatch) return aliasMatch.project_supplier_id;
    }

    // TODO: ingest aliases from supplier universe — when universe read is implemented,
    // pull all known aliases for the matched canonical name and pre-populate them here
    // by remapping any existing transactions with those raw names to this supplier.

    // Delegate to shared find-or-create (universe check + create)
    const result = await this.findOrCreateSupplier(rawName);
    return result.id;
  }

  async normalizeAllTransactions(onProgress?: (done: number, total: number, step: string) => void): Promise<void> {
    const report = onProgress || (() => {});

    // Get all distinct original_supplier_name values from transactions
    const cols = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'original_supplier_name'"
    );
    if (cols.length === 0) return;

    report(0, 0, 'Finding unique suppliers...');

    const supplierRows = await this.db.all<{ original_supplier_name: string }>(
      `SELECT DISTINCT original_supplier_name FROM transactions
       WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
    );

    if (supplierRows.length === 0) return;

    const totalSuppliers = supplierRows.length;
    report(0, totalSuppliers, `Resolving 0 / ${totalSuppliers.toLocaleString()} suppliers...`);

    // Pre-fetch all existing alias mappings once for O(1) lookup per raw name
    const aliasRows = await this.db.all<{ key: string; project_supplier_id: string }>(
      `SELECT lower(original_supplier_name) AS key, project_supplier_id
       FROM transactions
       WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
    );
    const aliasMap = new Map(aliasRows.map(r => [r.key, r.project_supplier_id]));

    // Build a map of rawName → supplierId (this creates project_suppliers records as needed)
    const nameToSupplierId = new Map<string, string>();
    let resolved = 0;
    for (const row of supplierRows) {
      const supplierId = await this.normalizeSupplierName(row.original_supplier_name, aliasMap);
      nameToSupplierId.set(row.original_supplier_name, supplierId);
      resolved++;
      // Report every 100 suppliers to avoid flooding the event bus
      if (resolved % 100 === 0 || resolved === totalSuppliers) {
        report(resolved, totalSuppliers, `Resolving suppliers ${resolved.toLocaleString()} / ${totalSuppliers.toLocaleString()}...`);
      }
    }

    // Link transactions to suppliers in batches so we can report progress.
    // Each batch UPDATEs transactions for a chunk of supplier names via a temp table.
    const LINK_BATCH_SIZE = 500;
    const entries = [...nameToSupplierId.entries()];
    const totalEntries = entries.length;
    let linked = 0;

    report(0, totalEntries, `Linking transactions to suppliers 0 / ${totalEntries.toLocaleString()}...`);

    for (let i = 0; i < entries.length; i += LINK_BATCH_SIZE) {
      const chunk = entries.slice(i, i + LINK_BATCH_SIZE);
      const tmpTable = `_norm_map_${uuidv4().replace(/-/g, '')}`;
      await this.db.exec(`CREATE TEMP TABLE ${tmpTable} (original_name VARCHAR, supplier_id VARCHAR)`);

      try {
        // sid is always a UUID from normalizeSupplierName — safe to interpolate
        const valueRows = chunk.map(([name, sid]) =>
          `('${name.replace(/'/g, "''")}', '${sid.replace(/'/g, "''")}')`
        ).join(',\n');
        await this.db.exec(`INSERT INTO ${tmpTable} (original_name, supplier_id) VALUES ${valueRows}`);

        await this.db.exec(`
          UPDATE transactions
          SET project_supplier_id = m.supplier_id
          FROM ${tmpTable} m
          WHERE transactions.original_supplier_name = m.original_name
            AND transactions.project_supplier_id IS NULL
        `);
      } finally {
        try { await this.db.exec(`DROP TABLE IF EXISTS ${tmpTable}`); } catch { /* ignore cleanup error */ }
      }

      linked += chunk.length;
      report(linked, totalEntries, `Linking transactions to suppliers ${linked.toLocaleString()} / ${totalEntries.toLocaleString()}...`);
    }

    report(totalSuppliers, totalSuppliers, 'Supplier normalization complete');
  }

  async assignAlias(supplierId: string, rawName: string): Promise<void> {
    const supplier = await this.db.get<{ id: string }>(
      'SELECT id FROM project_suppliers WHERE id = ?',
      supplierId
    );
    if (!supplier) {
      throw new Error(`Supplier not found: ${supplierId}`);
    }

    // Re-map all transactions with this raw name to the given supplier
    // TODO: also update supplier universe when universe write support is added
    await this.db.run(
      'UPDATE transactions SET project_supplier_id = ? WHERE original_supplier_name = ?',
      supplierId,
      rawName
    );
  }

  async getProjectAliases(supplierId: string): Promise<string[]> {
    const rows = await this.db.all<{ original_supplier_name: string }>(
      `SELECT DISTINCT t.original_supplier_name
       FROM transactions t
       WHERE t.project_supplier_id = ?
       AND t.original_supplier_name IS NOT NULL
       ORDER BY t.original_supplier_name`,
      supplierId
    );
    return rows.map(r => r.original_supplier_name);
  }

  async getProjectAliasesWithSpend(supplierId: string): Promise<{ rawName: string; spend: number; txnCount: number }[]> {
    const hasSpend = await this.transactionColumnExists('spend_amount');
    const spendExpr = hasSpend ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)' : '0';

    const rows = await this.db.all<{ original_supplier_name: string; total_spend: number; txn_count: number }>(
      `SELECT t.original_supplier_name,
              ${spendExpr} as total_spend,
              COUNT(t.id) as txn_count
       FROM transactions t
       WHERE t.project_supplier_id = ?
       AND t.original_supplier_name IS NOT NULL
       GROUP BY t.original_supplier_name
       ORDER BY t.original_supplier_name`,
      supplierId
    );
    return rows.map(r => ({ rawName: r.original_supplier_name, spend: Number(r.total_spend), txnCount: Number(r.txn_count) }));
  }

  async renameSupplier(supplierId: string, newName: string): Promise<void> {
    await this.db.run(
      'UPDATE project_suppliers SET supplier_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      newName,
      supplierId
    );
  }

  async mergeSuppliers(survivorId: string, losingIds: string[]): Promise<void> {
    if (losingIds.length === 0) return;
    if (losingIds.includes(survivorId)) {
      throw new Error('Survivor cannot be one of the losing suppliers');
    }
    // Transactions from losing suppliers are reassigned to the survivor.
    // Losing project_suppliers rows are deleted — this is intentional: merge collapses
    // multiple normalized supplier records into one. Any parent assignments on the losers
    // are lost with the row; the parent records themselves are unaffected.
    const placeholders = losingIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE transactions SET project_supplier_id = ? WHERE project_supplier_id IN (${placeholders})`,
      survivorId,
      ...losingIds
    );
    await this.db.run(
      `DELETE FROM project_suppliers WHERE id IN (${placeholders})`,
      ...losingIds
    );
  }

  async mergeParents(survivorId: string, losingIds: string[]): Promise<void> {
    if (losingIds.length === 0) return;
    if (losingIds.includes(survivorId)) {
      throw new Error('Survivor cannot be one of the losing parents');
    }
    const survivor = await this.db.get<{ id: string }>(
      'SELECT id FROM supplier_parents WHERE id = ?',
      survivorId
    );
    if (!survivor) {
      throw new Error(`Survivor is not a valid parent: ${survivorId}`);
    }
    const placeholders = losingIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE project_suppliers SET parent_supplier_id = ? WHERE parent_supplier_id IN (${placeholders})`,
      survivorId,
      ...losingIds
    );
    await this.db.run(
      `DELETE FROM supplier_parents WHERE id IN (${placeholders})`,
      ...losingIds
    );
  }

  async deleteSupplier(supplierId: string): Promise<void> {
    const row = await this.db.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM transactions WHERE project_supplier_id = ?',
      supplierId
    );
    if (Number(row?.cnt ?? 0) > 0) {
      throw new Error('Cannot delete supplier with transactions — reassign all aliases first');
    }
    await this.db.run('DELETE FROM project_suppliers WHERE id = ?', supplierId);
  }

  async updateSupplier(supplierId: string, updates: SupplierUpdateInput): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.supplierInfo !== undefined) {
      setClauses.push('supplier_info = ?');
      params.push(JSON.stringify(updates.supplierInfo));
    }
    if (updates.mappedTaxonomyPaths !== undefined) {
      setClauses.push('mapped_taxonomy_paths = ?');
      params.push(JSON.stringify(updates.mappedTaxonomyPaths));
    }
    if (updates.l1L2Path !== undefined) {
      setClauses.push('l1_l2_path = ?');
      params.push(JSON.stringify(updates.l1L2Path));
    }

    if (updates.markResearched) {
      setClauses.push('is_researched = TRUE');
    }
    if (updates.categoryASupplier !== undefined) {
      setClauses.push('category_a_supplier = ?');
      params.push(updates.categoryASupplier);
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(supplierId);

    await this.db.run(
      `UPDATE project_suppliers SET ${setClauses.join(', ')} WHERE id = ?`,
      ...params
    );
  }

  private async transactionColumnExists(columnName: string): Promise<boolean> {
    const row = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = ?`,
      columnName
    );
    return Number(row?.cnt ?? 0) > 0;
  }

  /** Fields that are computed aggregates — must be filtered in outer WHERE, not inner WHERE. */
  private static readonly AGGREGATE_FIELDS = new Set(['total_spend', 'transaction_count']);

  /** Known supplier column mappings — snake_case only. */
  private static readonly SUPPLIER_COLUMNS: Record<string, string> = {
    supplier_name: 'ps.supplier_name',
    confirmation_status: 'ps.confirmation_status',
    is_researched: 'ps.is_researched',
    is_tail_spend: 'ps.is_tail_spend',
    universe_match: 'ps.universe_match',
    parent_name: 'sp.name',
    data_source: 'ps.data_source',
    source_file: "upl.file_name || ' (' || strftime(upl.created_at, '%Y-%m-%d %H:%M') || ')'",
    // Aggregate fields — resolved on the outer subquery alias
    total_spend: 'sub.total_spend',
    transaction_count: 'sub.transaction_count',
  };

  /** Typed field definitions for the FilterConditionBuilder UI. */
  private static readonly SUPPLIER_FIELD_DEFINITIONS: FieldDefinition[] = [
    { name: 'supplier_name', label: 'Supplier Name', type: 'string' },
    { name: 'confirmation_status', label: 'Status', type: 'enum', enumValues: ['pending', 'confirmed', 'rejected', 'merged'] },
    { name: 'is_researched', label: 'Researched', type: 'boolean' },
    { name: 'is_tail_spend', label: 'Tail Spend', type: 'boolean' },
    { name: 'universe_match', label: 'Universe Match', type: 'boolean' },
    { name: 'parent_name', label: 'Parent Supplier', type: 'string' },
    { name: 'data_source', label: 'Data Source', type: 'string' },
    { name: 'source_file', label: 'Source File', type: 'string', group: 'Upload' },
    { name: 'total_spend', label: 'Total Spend', type: 'number', group: 'Aggregates' },
    { name: 'transaction_count', label: 'Transaction Count', type: 'number', group: 'Aggregates' },
  ];

  getFilterFields(): FieldDefinition[] {
    return SupplierService.SUPPLIER_FIELD_DEFINITIONS;
  }

  /** Get distinct values for a supplier field (for dropdown suggestions). */
  async queryDistinctValues(field: string, limit = 200): Promise<string[]> {
    if (field === 'parent_name') {
      // Query the normalized table directly — it's the source of truth for parent names
      const rows = await this.db.all<{ val: string }>(
        'SELECT name AS val FROM supplier_parents ORDER BY name LIMIT ?',
        limit
      );
      return rows.map(r => String(r.val));
    }
    if (field === 'source_file') {
      const colExpr = SupplierService.SUPPLIER_COLUMNS[field];
      const sql = `SELECT DISTINCT ${colExpr} as val FROM uploads upl WHERE upl.file_name IS NOT NULL ORDER BY val LIMIT ?`;
      const rows = await this.db.all<{ val: string }>(sql, limit);
      return rows.map(r => String(r.val));
    }
    const colExpr = SupplierService.SUPPLIER_COLUMNS[field];
    if (!colExpr) return [];
    // For supplier-level fields, query project_suppliers directly
    const sql = `SELECT DISTINCT ${colExpr} as val FROM project_suppliers ps WHERE ${colExpr} IS NOT NULL ORDER BY val LIMIT ?`;
    const rows = await this.db.all<{ val: string }>(sql, limit);
    return rows.map(r => String(r.val));
  }

  /** Column resolver that validates against known fields and throws for unknown ones. */
  private static readonly SUPPLIER_COLUMN_RESOLVER: ColumnResolver = (field: string) => {
    const col = SupplierService.SUPPLIER_COLUMNS[field];
    if (!col) throw new Error(`Unknown supplier filter field: "${field}"`);
    return col;
  };

  async listProjectSuppliers(filter?: { conditions?: FilterCondition[]; groupedConditions?: GroupedFilter }): Promise<ProjectSupplierView[]> {
    const hasSpend = await this.transactionColumnExists('spend_amount');
    const spendExpr = hasSpend ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)' : '0';

    // Flatten grouped conditions for aggregate-field detection, or use flat conditions
    const conditions = filter?.conditions ?? [];

    // Build WHERE clause — prefer groupedConditions (proper parenthesization) over flat conditions
    let innerWhere: { sql: string; params: unknown[] } | null = null;
    let outerWhere: { sql: string; params: unknown[] } | null = null;

    if (filter?.groupedConditions && filter.groupedConditions.groups.length > 0) {
      // Split grouped conditions: separate aggregate from regular fields
      const regularGroups: GroupedFilter = {
        groupConnector: filter.groupedConditions.groupConnector,
        groups: filter.groupedConditions.groups.map(g => ({
          ...g,
          conditions: g.conditions.filter(c => c.field && !SupplierService.AGGREGATE_FIELDS.has(c.field)),
        })).filter(g => g.conditions.length > 0),
      };
      const aggregateGroups: GroupedFilter = {
        groupConnector: filter.groupedConditions.groupConnector,
        groups: filter.groupedConditions.groups.map(g => ({
          ...g,
          conditions: g.conditions.filter(c => c.field && SupplierService.AGGREGATE_FIELDS.has(c.field)),
        })).filter(g => g.conditions.length > 0),
      };

      if (regularGroups.groups.length > 0) {
        innerWhere = buildGroupedWhereClause(regularGroups, SupplierService.SUPPLIER_COLUMN_RESOLVER);
      }
      if (aggregateGroups.groups.length > 0) {
        outerWhere = buildGroupedWhereClause(aggregateGroups, SupplierService.SUPPLIER_COLUMN_RESOLVER);
      }
    } else {
      // Flat conditions path (backward compatible)
      const regularConditions = conditions.filter(c => !SupplierService.AGGREGATE_FIELDS.has(c.field));
      const aggregateConditions = conditions.filter(c => SupplierService.AGGREGATE_FIELDS.has(c.field));
      innerWhere = buildWhereClause(regularConditions, SupplierService.SUPPLIER_COLUMN_RESOLVER);
      outerWhere = buildWhereClause(aggregateConditions, SupplierService.SUPPLIER_COLUMN_RESOLVER);
    }

    const innerWhereSQL = innerWhere ? `WHERE ${innerWhere.sql}` : '';
    const innerParams = innerWhere?.params ?? [];

    // Build inner query
    const innerSQL = `SELECT ps.id, ps.supplier_name, ps.confirmation_status, ps.is_tail_spend,
        ps.parent_supplier_id, sp.name AS parent_name,
        ps.data_source, ps.universe_match, ps.is_researched, ps.category_a_supplier,
        ps.supplier_info, ps.mapped_taxonomy_paths, ps.l1_l2_path, ps.created_at, ps.updated_at,
        COUNT(t.id) as transaction_count,
        ${spendExpr} as total_spend
      FROM project_suppliers ps
      LEFT JOIN transactions t ON t.project_supplier_id = ps.id
      LEFT JOIN uploads upl ON t.upload_id = upl.id
      LEFT JOIN supplier_parents sp ON sp.id = ps.parent_supplier_id
      ${innerWhereSQL}
      GROUP BY ALL`;

    const outerWhereSQL = outerWhere ? `WHERE ${outerWhere.sql}` : '';
    const outerParams = outerWhere?.params ?? [];

    const sql = outerWhere
      ? `SELECT * FROM (${innerSQL}) sub ${outerWhereSQL} ORDER BY sub.supplier_name`
      : `${innerSQL} ORDER BY ps.supplier_name`;

    const allParams = [...innerParams, ...outerParams];

    const rows = await this.db.all<{
      id: string;
      supplier_name: string;
      confirmation_status: string;
      is_tail_spend: boolean;
      parent_supplier_id: string | null;
      parent_name: string | null;
      universe_match: boolean;
      is_researched: boolean;
      category_a_supplier: boolean;
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
      l1_l2_path: string | null;
      created_at: string;
      transaction_count: number | bigint;
      total_spend: number | bigint;
    }>(sql, ...allParams);

    // Bulk-fetch project-local aliases (all distinct raw names per supplier)
    const aliasRows = await this.db.all<{ project_supplier_id: string; original_supplier_name: string }>(
      `SELECT DISTINCT t.project_supplier_id, t.original_supplier_name
       FROM transactions t
       WHERE t.project_supplier_id IS NOT NULL
       AND t.original_supplier_name IS NOT NULL`
    );
    const aliasMap = new Map<string, string[]>();
    for (const r of aliasRows) {
      const arr = aliasMap.get(r.project_supplier_id) ?? [];
      arr.push(r.original_supplier_name);
      aliasMap.set(r.project_supplier_id, arr);
    }

    return rows.map((row) => ({
      id: row.id,
      supplierName: row.supplier_name,
      confirmationStatus: row.confirmation_status as SupplierConfirmationStatus,
      isTailSpend: Boolean(row.is_tail_spend),
      parentSupplierId: row.parent_supplier_id,
      parentName: row.parent_name,
      supplierInfo: safeParseJSON(row.supplier_info),
      mappedTaxonomyPaths: safeParseJSON<string[]>(row.mapped_taxonomy_paths),
      l1L2Path: safeParseStringArray(row.l1_l2_path),
      universeMatch: Boolean(row.universe_match),
      isResearched: Boolean(row.is_researched),
      categoryASupplier: Boolean(row.category_a_supplier),
      createdAt: String(row.created_at),
      transactionCount: Number(row.transaction_count),
      totalSpend: Number(row.total_spend),
      aliases: aliasMap.get(row.id) ?? [],
    }));
  }

  async listProjectSuppliersPaginated(params: SupplierPaginationParams): Promise<PaginatedSuppliers> {
    const { limit, offset, search, sortBy, sortDir = 'asc' } = params;
    const hasSpend = await this.transactionColumnExists('spend_amount');
    const spendExpr = hasSpend ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)' : '0';

    // Base inner query (same structure as listProjectSuppliers)
    const innerSQL = `SELECT ps.id, ps.supplier_name, ps.confirmation_status, ps.is_tail_spend,
        ps.parent_supplier_id, sp.name AS parent_name,
        ps.data_source, ps.universe_match, ps.is_researched, ps.category_a_supplier,
        ps.supplier_info, ps.mapped_taxonomy_paths, ps.l1_l2_path, ps.created_at, ps.updated_at,
        COUNT(t.id) as transaction_count,
        ${spendExpr} as total_spend
      FROM project_suppliers ps
      LEFT JOIN transactions t ON t.project_supplier_id = ps.id
      LEFT JOIN supplier_parents sp ON sp.id = ps.parent_supplier_id
      GROUP BY ALL`;

    // Wrap inner query so we can filter + sort + paginate on computed columns
    const queryParams: unknown[] = [];
    let searchClause = '';
    if (search && search.trim()) {
      const pattern = `%${search.trim().toLowerCase()}%`;
      searchClause = `WHERE LOWER(sub.supplier_name) LIKE ? OR LOWER(sub.parent_name) LIKE ?`;
      queryParams.push(pattern, pattern);
    }

    // Sort mapping
    const sortMap: Record<string, string> = {
      supplier_name: 'sub.supplier_name',
      parent_name: 'sub.parent_name',
      total_spend: 'sub.total_spend',
      transaction_count: 'sub.transaction_count',
      created_at: 'sub.created_at',
    };
    const orderCol = sortBy ? (sortMap[sortBy] ?? 'sub.supplier_name') : 'sub.supplier_name';
    const direction = sortDir === 'desc' ? 'DESC' : 'ASC';

    // For parent_name sort: put NULLs last
    const nullsLast = sortBy === 'parent_name' ? ' NULLS LAST' : '';
    const orderClause = `ORDER BY ${orderCol} ${direction}${nullsLast}`;

    // Count query
    const countSQL = `SELECT COUNT(*) as cnt FROM (${innerSQL}) sub ${searchClause}`;
    const countRow = await this.db.get<{ cnt: number | bigint }>(countSQL, ...queryParams);
    const total = Number(countRow?.cnt ?? 0);

    // Data query with LIMIT/OFFSET
    const dataSQL = `SELECT * FROM (${innerSQL}) sub ${searchClause} ${orderClause} LIMIT ? OFFSET ?`;
    const dataParams = [...queryParams, limit, offset];

    const rows = await this.db.all<{
      id: string;
      supplier_name: string;
      confirmation_status: string;
      is_tail_spend: boolean;
      parent_supplier_id: string | null;
      parent_name: string | null;
      universe_match: boolean;
      is_researched: boolean;
      category_a_supplier: boolean;
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
      l1_l2_path: string | null;
      created_at: string;
      transaction_count: number | bigint;
      total_spend: number | bigint;
    }>(dataSQL, ...dataParams);

    // Bulk-fetch aliases only for the returned page of suppliers
    const supplierIds = rows.map(r => r.id);
    const aliasMap = new Map<string, string[]>();
    if (supplierIds.length > 0) {
      const placeholders = supplierIds.map(() => '?').join(',');
      const aliasRows = await this.db.all<{ project_supplier_id: string; original_supplier_name: string }>(
        `SELECT DISTINCT t.project_supplier_id, t.original_supplier_name
         FROM transactions t
         WHERE t.project_supplier_id IN (${placeholders})
         AND t.original_supplier_name IS NOT NULL`,
        ...supplierIds
      );
      for (const r of aliasRows) {
        const arr = aliasMap.get(r.project_supplier_id) ?? [];
        arr.push(r.original_supplier_name);
        aliasMap.set(r.project_supplier_id, arr);
      }
    }

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        supplierName: row.supplier_name,
        confirmationStatus: row.confirmation_status as SupplierConfirmationStatus,
        isTailSpend: Boolean(row.is_tail_spend),
        parentSupplierId: row.parent_supplier_id,
        parentName: row.parent_name,
        supplierInfo: safeParseJSON(row.supplier_info),
        mappedTaxonomyPaths: safeParseJSON<string[]>(row.mapped_taxonomy_paths),
        l1L2Path: safeParseStringArray(row.l1_l2_path),
        universeMatch: Boolean(row.universe_match),
        isResearched: Boolean(row.is_researched),
        categoryASupplier: Boolean(row.category_a_supplier),
        createdAt: String(row.created_at),
        transactionCount: Number(row.transaction_count),
        totalSpend: Number(row.total_spend),
        aliases: aliasMap.get(row.id) ?? [],
      })),
    };
  }

  async getProjectSupplier(id: string): Promise<ProjectSupplier | null> {
    const row = await this.db.get<{
      id: string;
      supplier_name: string;
      confirmation_status: string;
      is_tail_spend: boolean;
      parent_supplier_id: string | null;
      parent_name: string | null;
      universe_match: boolean;
      is_researched: boolean;
      category_a_supplier: boolean;
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
      l1_l2_path: string | null;
      created_at: string;
    }>(
      `SELECT ps.id, ps.supplier_name, ps.confirmation_status, ps.is_tail_spend,
              ps.parent_supplier_id, sp.name AS parent_name,
              ps.universe_match, ps.is_researched, ps.category_a_supplier,
              ps.supplier_info, ps.mapped_taxonomy_paths, ps.l1_l2_path, ps.created_at
       FROM project_suppliers ps
       LEFT JOIN supplier_parents sp ON sp.id = ps.parent_supplier_id
       WHERE ps.id = ?`,
      id
    );

    if (!row) return null;

    return {
      id: row.id,
      supplierName: row.supplier_name,
      confirmationStatus: row.confirmation_status as SupplierConfirmationStatus,
      isTailSpend: Boolean(row.is_tail_spend),
      parentSupplierId: row.parent_supplier_id,
      parentName: row.parent_name,
      supplierInfo: safeParseJSON(row.supplier_info),
      mappedTaxonomyPaths: safeParseJSON<string[]>(row.mapped_taxonomy_paths),
      l1L2Path: safeParseStringArray(row.l1_l2_path),
      universeMatch: Boolean(row.universe_match),
      isResearched: Boolean(row.is_researched),
      categoryASupplier: Boolean(row.category_a_supplier),
      createdAt: String(row.created_at),
    };
  }

  async confirmSupplier(id: string, status: SupplierConfirmationStatus): Promise<void> {
    await this.db.run(
      'UPDATE project_suppliers SET confirmation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      status,
      id
    );
  }

  async listParents(): Promise<SupplierParent[]> {
    const rows = await this.db.all<{ id: string; name: string; created_at: string }>(
      'SELECT id, name, created_at FROM supplier_parents ORDER BY name'
    );
    return rows.map(r => ({ id: r.id, name: r.name, createdAt: String(r.created_at) }));
  }

  async addParent(name: string): Promise<SupplierParent> {
    const id = uuidv4();
    await this.db.run(
      'INSERT INTO supplier_parents (id, name) VALUES (?, ?)',
      id,
      name
    );
    const row = await this.db.get<{ id: string; name: string; created_at: string }>(
      'SELECT id, name, created_at FROM supplier_parents WHERE id = ?',
      id
    );
    return { id: row!.id, name: row!.name, createdAt: String(row!.created_at) };
  }

  async findParentByName(name: string): Promise<SupplierParent | null> {
    const row = await this.db.get<{ id: string; name: string; created_at: string }>(
      'SELECT id, name, created_at FROM supplier_parents WHERE lower(name) = lower(?)',
      name
    );
    if (!row) return null;
    return { id: row.id, name: row.name, createdAt: String(row.created_at) };
  }

  async assignParent(supplierIds: string[], parentId: string | null): Promise<void> {
    if (supplierIds.length === 0) return;
    const placeholders = supplierIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE project_suppliers SET parent_supplier_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      parentId,
      ...supplierIds
    );
  }

  async renameParent(parentId: string, newName: string): Promise<void> {
    await this.db.run(
      'UPDATE supplier_parents SET name = ? WHERE id = ?',
      newName,
      parentId
    );
  }

  async deleteParent(parentId: string): Promise<void> {
    const row = await this.db.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM project_suppliers WHERE parent_supplier_id = ?',
      parentId
    );
    const count = Number(row?.cnt ?? 0);
    if (count > 0) {
      throw new Error(`Cannot delete parent: ${count} supplier(s) still assigned to it`);
    }
    await this.db.run('DELETE FROM supplier_parents WHERE id = ?', parentId);
  }

  async filterTailSpend(threshold: number): Promise<string[]> {
    // Reset all flags first so threshold changes recalculate correctly
    await this.db.run(
      'UPDATE project_suppliers SET is_tail_spend = FALSE, updated_at = CURRENT_TIMESTAMP'
    );

    const hasSpend = await this.transactionColumnExists('spend_amount');
    if (!hasSpend) return [];

    const rows = await this.db.all<{ id: string }>(
      `SELECT ps.id FROM project_suppliers ps
       LEFT JOIN transactions t ON t.project_supplier_id = ps.id
       GROUP BY ps.id
       HAVING COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) < ?`,
      threshold
    );

    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      await this.db.run(
        `UPDATE project_suppliers SET is_tail_spend = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        ...ids
      );
    }

    return ids;
  }

  async isTailSpend(supplierId: string): Promise<boolean> {
    const row = await this.db.get<{ is_tail_spend: boolean }>(
      'SELECT is_tail_spend FROM project_suppliers WHERE id = ?',
      supplierId
    );
    return row ? Boolean(row.is_tail_spend) : false;
  }

  async markResearched(supplierId: string): Promise<void> {
    await this.db.run(
      'UPDATE project_suppliers SET is_researched = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      supplierId
    );
  }

  async importSupplierCSV(filePath: string, supplierNameColumn: string): Promise<{ created: number; skipped: number }> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Stream CSV and collect unique supplier names from the chosen column
    const rawNames = await new Promise<string[]>((resolve, reject) => {
      const names: string[] = [];
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const parser = stream.pipe(parseStream({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
      }));

      parser.on('data', (record: Record<string, string>) => {
        const value = record[supplierNameColumn];
        if (value && value.trim().length > 0) {
          names.push(value.trim());
        }
      });
      parser.on('end', () => resolve(names));
      parser.on('error', reject);
      stream.on('error', reject);
    });

    // Deduplicate (case-insensitive)
    const seen = new Set<string>();
    const uniqueNames: string[] = [];
    for (const name of rawNames) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueNames.push(name);
      }
    }

    let created = 0;
    let skipped = 0;

    for (const rawName of uniqueNames) {
      const result = await this.findOrCreateSupplier(rawName);
      if (result.created) {
        created++;
      } else {
        skipped++;
      }
    }

    return { created, skipped };
  }

  // ─── CSV Apply: Diff-based bulk update ──────────────────────────────────────

  async computeCsvDiff(rows: CsvApplyRow[]): Promise<CsvApplyDiff> {
    // Phase 1: Snapshot current DB state
    const aliasRows = await this.db.all<{
      original_supplier_name: string;
      project_supplier_id: string;
      supplier_name: string;
      parent_supplier_id: string | null;
      parent_name: string | null;
    }>(
      `SELECT DISTINCT t.original_supplier_name, t.project_supplier_id,
              ps.supplier_name, ps.parent_supplier_id, sp.name as parent_name
       FROM transactions t
       JOIN project_suppliers ps ON ps.id = t.project_supplier_id
       LEFT JOIN supplier_parents sp ON sp.id = ps.parent_supplier_id
       WHERE t.original_supplier_name IS NOT NULL
         AND t.project_supplier_id IS NOT NULL`
    );

    const dbParentRows = await this.db.all<{ id: string; name: string }>(
      'SELECT id, name FROM supplier_parents'
    );

    // Build lookup maps
    const dbAliasToSupplier = new Map<string, {
      supplierId: string; supplierName: string;
      parentId: string | null; parentName: string | null;
    }>();
    const dbSupplierAliases = new Map<string, Set<string>>();
    const dbSupplierNames = new Map<string, string>(); // id → name
    const dbSupplierSpend = new Map<string, number>(); // id → rough spend proxy (alias count)

    for (const r of aliasRows) {
      dbAliasToSupplier.set(r.original_supplier_name, {
        supplierId: r.project_supplier_id,
        supplierName: r.supplier_name,
        parentId: r.parent_supplier_id,
        parentName: r.parent_name,
      });
      if (!dbSupplierAliases.has(r.project_supplier_id)) {
        dbSupplierAliases.set(r.project_supplier_id, new Set());
      }
      dbSupplierAliases.get(r.project_supplier_id)!.add(r.original_supplier_name);
      dbSupplierNames.set(r.project_supplier_id, r.supplier_name);
      dbSupplierSpend.set(r.project_supplier_id, (dbSupplierSpend.get(r.project_supplier_id) ?? 0) + 1);
    }

    const dbParentsByName = new Map<string, { id: string; name: string }>();
    for (const p of dbParentRows) {
      dbParentsByName.set(p.name.toLowerCase(), { id: p.id, name: p.name });
    }

    // Phase 2 & 3: Validate CSV
    const csvAliasToRowIndex = new Map<string, number>();
    const warnings: CsvApplyDiff['warnings'] = { unknownAliases: [], unmatchableRows: [], missingAliases: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.supplierName || row.supplierName.trim().length === 0) {
        warnings.unmatchableRows.push({ supplierName: `(row ${i + 1})`, reason: 'Empty supplier name' });
        continue;
      }
      for (const alias of row.aliases) {
        if (csvAliasToRowIndex.has(alias)) {
          const otherIdx = csvAliasToRowIndex.get(alias)!;
          throw new Error(
            `Alias "${alias}" appears in both "${rows[otherIdx].supplierName}" and "${row.supplierName}". Each alias must belong to exactly one supplier.`
          );
        }
        if (!dbAliasToSupplier.has(alias)) {
          warnings.unknownAliases.push({ alias, csvSupplierName: row.supplierName });
        } else {
          csvAliasToRowIndex.set(alias, i);
        }
      }
    }

    // Phase 4: Compute diff
    // For each CSV row, find which DB suppliers it maps to via shared aliases
    const csvRowToDbSuppliers = new Map<number, Set<string>>(); // rowIndex → Set<supplierId>
    const dbSupplierToCsvRow = new Map<string, number>(); // supplierId → rowIndex

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const knownAliases = row.aliases.filter(a => dbAliasToSupplier.has(a));
      if (knownAliases.length === 0) {
        if (row.aliases.length > 0) {
          warnings.unmatchableRows.push({ supplierName: row.supplierName, reason: 'No aliases match existing transactions' });
        }
        continue;
      }

      const supplierIds = new Set<string>();
      for (const alias of knownAliases) {
        supplierIds.add(dbAliasToSupplier.get(alias)!.supplierId);
      }

      // Check no DB supplier is claimed by two CSV rows
      for (const sid of supplierIds) {
        if (dbSupplierToCsvRow.has(sid)) {
          const otherIdx = dbSupplierToCsvRow.get(sid)!;
          throw new Error(
            `Supplier "${dbSupplierNames.get(sid)}" is claimed by both "${rows[otherIdx].supplierName}" and "${row.supplierName}" via different aliases. Resolve the conflict.`
          );
        }
        dbSupplierToCsvRow.set(sid, i);
      }

      csvRowToDbSuppliers.set(i, supplierIds);
    }

    // Derive operations
    const diff: CsvApplyDiff = {
      renames: [],
      merges: [],
      aliasReassignments: [],
      parentCreations: [],
      parentRenames: [],
      parentMerges: [],
      parentChanges: [],
      warnings,
    };

    // Track which supplier ID is the "survivor" for each CSV row (after merges)
    const csvRowSurvivor = new Map<number, string>(); // rowIndex → survivorId

    for (const [rowIdx, supplierIds] of csvRowToDbSuppliers) {
      const row = rows[rowIdx];
      const ids = [...supplierIds];

      if (ids.length === 1) {
        csvRowSurvivor.set(rowIdx, ids[0]);
      } else {
        // MERGE: pick survivor — prefer the one whose name matches CSV, else highest alias count
        let survivorId = ids.find(id => dbSupplierNames.get(id) === row.supplierName)
          ?? ids.sort((a, b) => (dbSupplierSpend.get(b) ?? 0) - (dbSupplierSpend.get(a) ?? 0))[0];
        const loserIds = ids.filter(id => id !== survivorId);

        diff.merges.push({
          survivorId,
          survivorName: dbSupplierNames.get(survivorId) ?? row.supplierName,
          loserIds,
          loserNames: loserIds.map(id => dbSupplierNames.get(id) ?? '(unknown)'),
        });

        csvRowSurvivor.set(rowIdx, survivorId);
      }

      // Check for rename
      const survivorId = csvRowSurvivor.get(rowIdx)!;
      const currentName = dbSupplierNames.get(survivorId) ?? '';
      if (currentName !== row.supplierName) {
        diff.renames.push({ supplierId: survivorId, oldName: currentName, newName: row.supplierName });
      }
    }

    // Derive alias reassignments: compare each alias's current DB owner vs intended CSV owner
    for (const [alias, rowIdx] of csvAliasToRowIndex) {
      const intendedSurvivor = csvRowSurvivor.get(rowIdx);
      if (!intendedSurvivor) continue;

      const currentOwner = dbAliasToSupplier.get(alias)!;
      // After merges, the "effective owner" is the survivor if the current owner is a loser
      let effectiveOwner = currentOwner.supplierId;
      for (const merge of diff.merges) {
        if (merge.loserIds.includes(effectiveOwner)) {
          effectiveOwner = merge.survivorId;
          break;
        }
      }

      if (effectiveOwner !== intendedSurvivor) {
        diff.aliasReassignments.push({
          alias,
          fromSupplierId: effectiveOwner,
          fromName: dbSupplierNames.get(effectiveOwner) ?? '(unknown)',
          toSupplierId: intendedSurvivor,
          toName: rows[rowIdx].supplierName,
        });
      }
    }

    // Detect missing aliases: any DB alias not present anywhere in the CSV
    for (const [alias, info] of dbAliasToSupplier) {
      if (!csvAliasToRowIndex.has(alias)) {
        diff.warnings.missingAliases.push({ alias, supplierName: info.supplierName });
      }
    }

    // Derive parent operations
    // Collect all CSV parent names and which DB parents they map to
    const csvParentToDbParents = new Map<string, Set<string>>(); // csvParentName(lower) → Set<dbParentId>
    const csvParentOriginalCase = new Map<string, string>(); // lower → original case

    for (const [rowIdx, survivorId] of csvRowSurvivor) {
      const row = rows[rowIdx];
      const csvParent = row.parentName?.trim() || null;
      const currentInfo = dbAliasToSupplier.get(rows[rowIdx].aliases.find(a => dbAliasToSupplier.has(a))!);
      const currentParentName = currentInfo?.parentName ?? null;
      const currentParentId = currentInfo?.parentId ?? null;

      if (csvParent) {
        const key = csvParent.toLowerCase();
        csvParentOriginalCase.set(key, csvParent);
        if (!csvParentToDbParents.has(key)) {
          csvParentToDbParents.set(key, new Set());
        }
        if (currentParentId) {
          csvParentToDbParents.get(key)!.add(currentParentId);
        }
      }

      // Track parent change per supplier
      if ((csvParent ?? null) !== (currentParentName ?? null)) {
        diff.parentChanges.push({
          supplierId: survivorId,
          supplierName: row.supplierName,
          oldParentName: currentParentName,
          newParentName: csvParent,
        });
      }
    }

    // Determine parent creations, renames, and merges
    for (const [lowerName, dbParentIds] of csvParentToDbParents) {
      const csvName = csvParentOriginalCase.get(lowerName)!;
      const existingParent = dbParentsByName.get(lowerName);

      if (dbParentIds.size === 0 && !existingParent) {
        // New parent needed
        diff.parentCreations.push({ name: csvName });
      } else if (dbParentIds.size === 1 && !existingParent) {
        // The only DB parent under this CSV name doesn't match by name → rename
        const dbParentId = [...dbParentIds][0];
        const dbParent = dbParentRows.find(p => p.id === dbParentId);
        if (dbParent && dbParent.name.toLowerCase() !== lowerName) {
          // Only rename if all suppliers under this old parent are now under the new name
          diff.parentRenames.push({ parentId: dbParentId, oldName: dbParent.name, newName: csvName });
        }
      } else if (dbParentIds.size > 1) {
        // Multiple DB parents mapping to same CSV parent name → merge
        const survivorParent = existingParent
          ?? dbParentRows.find(p => [...dbParentIds].includes(p.id))!;
        const loserIds = [...dbParentIds].filter(id => id !== survivorParent.id);
        if (loserIds.length > 0) {
          diff.parentMerges.push({
            survivorId: survivorParent.id,
            survivorName: survivorParent.name,
            loserIds,
            loserNames: loserIds.map(id => dbParentRows.find(p => p.id === id)?.name ?? '(unknown)'),
          });
        }
        // If survivor name doesn't match CSV name, also rename
        if (survivorParent.name.toLowerCase() !== lowerName) {
          diff.parentRenames.push({ parentId: survivorParent.id, oldName: survivorParent.name, newName: csvName });
        }
      } else if (existingParent && existingParent.name !== csvName) {
        // Existing parent with different casing — rename
        diff.parentRenames.push({ parentId: existingParent.id, oldName: existingParent.name, newName: csvName });
      }
    }

    return diff;
  }

  async applyCsvDiff(diff: CsvApplyDiff): Promise<CsvApplyResult> {
    const hasChanges =
      diff.renames.length > 0 ||
      diff.merges.length > 0 ||
      diff.aliasReassignments.length > 0 ||
      diff.parentCreations.length > 0 ||
      diff.parentRenames.length > 0 ||
      diff.parentMerges.length > 0 ||
      diff.parentChanges.length > 0;

    if (!hasChanges) {
      return { applied: false, diff, noChanges: true };
    }

    // Apply in correct order to avoid cascading issues

    // 1. Create new parents
    const newParentIds = new Map<string, string>(); // lower(name) → id
    for (const pc of diff.parentCreations) {
      const parent = await this.addParent(pc.name);
      newParentIds.set(pc.name.toLowerCase(), parent.id);
    }

    // 2. Rename parents
    for (const pr of diff.parentRenames) {
      await this.renameParent(pr.parentId, pr.newName);
    }

    // 3. Merge parents
    for (const pm of diff.parentMerges) {
      await this.mergeParents(pm.survivorId, pm.loserIds);
    }

    // 4. Merge suppliers
    for (const m of diff.merges) {
      await this.mergeSuppliers(m.survivorId, m.loserIds);
    }

    // 5. Rename suppliers
    for (const r of diff.renames) {
      await this.renameSupplier(r.supplierId, r.newName);
    }

    // 6. Reassign aliases
    for (const a of diff.aliasReassignments) {
      await this.assignAlias(a.toSupplierId, a.alias);
    }

    // 7. Assign/change parents on suppliers
    // Build a map: parentName → parentId (including newly created ones)
    const allParents = await this.listParents();
    const parentNameToId = new Map<string, string>();
    for (const p of allParents) {
      parentNameToId.set(p.name.toLowerCase(), p.id);
    }

    for (const pc of diff.parentChanges) {
      let targetParentId: string | null = null;
      if (pc.newParentName) {
        targetParentId = parentNameToId.get(pc.newParentName.toLowerCase())
          ?? newParentIds.get(pc.newParentName.toLowerCase())
          ?? null;
        // If parent still doesn't exist (edge case), create it
        if (!targetParentId) {
          const created = await this.addParent(pc.newParentName);
          targetParentId = created.id;
          parentNameToId.set(pc.newParentName.toLowerCase(), created.id);
        }
      }
      await this.assignParent([pc.supplierId], targetParentId);
    }

    return { applied: true, diff, noChanges: false };
  }

  async syncToUniverse(supplierIds: string[]): Promise<{ synced: number; failed: number; errors: string[] }> {
    if (!this.supplierUniverse.isOpen()) {
      return { synced: 0, failed: 0, errors: ['Supplier universe not configured'] };
    }

    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of supplierIds) {
      try {
        const supplier = await this.getProjectSupplier(id);
        if (!supplier) {
          failed++;
          errors.push(`Supplier ${id} not found`);
          continue;
        }

        const aliases = await this.getProjectAliases(id);

        await this.supplierUniverse.upsertSupplierFull(supplier.supplierName, {
          supplierInfo: supplier.supplierInfo ?? undefined,
          aliases,
          parentName: supplier.parentName,
          mappedTaxonomyPaths: supplier.mappedTaxonomyPaths ?? undefined,
          categoryASupplier: supplier.categoryASupplier,
        });

        synced++;
      } catch (err) {
        failed++;
        errors.push(`Failed to sync supplier ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { synced, failed, errors };
  }
}
