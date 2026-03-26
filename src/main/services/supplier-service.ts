import { v4 as uuidv4 } from 'uuid';
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
} from '../../shared/types/suppliers';
import type { FilterCondition, GroupedFilter, FieldDefinition } from '../../shared/types/transactions';
import { buildWhereClause, buildGroupedWhereClause, type ColumnResolver } from '../utils/query-builder';

export class SupplierService implements ISupplierService {
  constructor(
    private db: Database,
    private supplierUniverse: SupplierUniverse
  ) {}

  async normalizeSupplierName(rawName: string, aliasMap?: Map<string, string>): Promise<string> {
    const cleanedName = cleanSupplierName(rawName);

    // Case-insensitive lookup against cleaned supplier names
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

    // Check universe for variants/aliases
    const variants = await this.supplierUniverse.searchVariants(rawName);
    if (variants.length > 0) {
      // Check if any variant is already a project supplier
      for (const variant of variants) {
        const variantRow = await this.db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE lower(supplier_name) = lower(?)',
          cleanSupplierName(variant)
        );
        if (variantRow) return variantRow.id;
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

    return id;
  }

  async normalizeAllTransactions(): Promise<void> {
    // Get all distinct original_supplier_name values from transactions
    const cols = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'original_supplier_name'"
    );
    if (cols.length === 0) return;

    const supplierRows = await this.db.all<{ original_supplier_name: string }>(
      `SELECT DISTINCT original_supplier_name FROM transactions
       WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NULL`
    );

    if (supplierRows.length === 0) return;

    // Pre-fetch all existing alias mappings once for O(1) lookup per raw name
    const aliasRows = await this.db.all<{ key: string; project_supplier_id: string }>(
      `SELECT lower(original_supplier_name) AS key, project_supplier_id
       FROM transactions
       WHERE original_supplier_name IS NOT NULL AND project_supplier_id IS NOT NULL`
    );
    const aliasMap = new Map(aliasRows.map(r => [r.key, r.project_supplier_id]));

    // Build a map of rawName → supplierId (this creates project_suppliers records as needed)
    const nameToSupplierId = new Map<string, string>();
    for (const row of supplierRows) {
      const supplierId = await this.normalizeSupplierName(row.original_supplier_name, aliasMap);
      nameToSupplierId.set(row.original_supplier_name, supplierId);
    }

    // Bulk UPDATE using a per-call temp table to avoid collisions if imports overlap
    const tmpTable = `_norm_map_${uuidv4().replace(/-/g, '')}`;
    await this.db.exec(`CREATE TEMP TABLE ${tmpTable} (original_name VARCHAR, supplier_id VARCHAR)`);

    try {
      // Insert mappings into temp table in chunks
      const CHUNK_SIZE = 1000;
      const entries = [...nameToSupplierId.entries()];
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        // sid is always a UUID from normalizeSupplierName — safe to interpolate
        const valueRows = chunk.map(([name, sid]) =>
          `('${name.replace(/'/g, "''")}', '${sid.replace(/'/g, "''")}')`
        ).join(',\n');
        await this.db.exec(`INSERT INTO ${tmpTable} (original_name, supplier_id) VALUES ${valueRows}`);
      }

      // Single bulk UPDATE from temp table
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

    if (updates.markResearched) {
      setClauses.push('is_researched = TRUE');
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
        ps.data_source, ps.universe_match, ps.is_researched,
        ps.supplier_info, ps.mapped_taxonomy_paths, ps.created_at, ps.updated_at,
        COUNT(t.id) as transaction_count,
        ${spendExpr} as total_spend
      FROM project_suppliers ps
      LEFT JOIN transactions t ON t.project_supplier_id = ps.id
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
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
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
      supplierInfo: row.supplier_info ? JSON.parse(row.supplier_info) : null,
      mappedTaxonomyPaths: row.mapped_taxonomy_paths ? JSON.parse(row.mapped_taxonomy_paths) : null,
      universeMatch: Boolean(row.universe_match),
      isResearched: Boolean(row.is_researched),
      createdAt: String(row.created_at),
      transactionCount: Number(row.transaction_count),
      totalSpend: Number(row.total_spend),
      aliases: aliasMap.get(row.id) ?? [],
    }));
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
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
      created_at: string;
    }>(
      `SELECT ps.id, ps.supplier_name, ps.confirmation_status, ps.is_tail_spend,
              ps.parent_supplier_id, sp.name AS parent_name,
              ps.universe_match, ps.is_researched,
              ps.supplier_info, ps.mapped_taxonomy_paths, ps.created_at
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
      supplierInfo: row.supplier_info ? JSON.parse(row.supplier_info) : null,
      mappedTaxonomyPaths: row.mapped_taxonomy_paths ? JSON.parse(row.mapped_taxonomy_paths) : null,
      universeMatch: Boolean(row.universe_match),
      isResearched: Boolean(row.is_researched),
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
}
