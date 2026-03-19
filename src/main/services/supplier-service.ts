import { v4 as uuidv4 } from 'uuid';
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
} from '../../shared/types/suppliers';
import type { FilterCondition, FieldDefinition } from '../../shared/types/transactions';
import { buildWhereClause, type ColumnResolver } from '../utils/query-builder';

export class SupplierService implements ISupplierService {
  constructor(
    private db: Database,
    private supplierUniverse: SupplierUniverse
  ) {}

  async normalizeSupplierName(rawName: string): Promise<string> {
    // Check if a project supplier already exists
    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM project_suppliers WHERE supplier_name = ?',
      rawName
    );
    if (existing) return existing.id;

    // Check universe for variants/aliases
    const variants = await this.supplierUniverse.searchVariants(rawName);
    if (variants.length > 0) {
      // Check if any variant is already a project supplier
      for (const variant of variants) {
        const variantRow = await this.db.get<{ id: string }>(
          'SELECT id FROM project_suppliers WHERE supplier_name = ?',
          variant
        );
        if (variantRow) return variantRow.id;
      }
    }

    // Create a new project supplier
    const id = uuidv4();
    const universeInfo = await this.supplierUniverse.getSupplier(rawName);
    await this.db.run(
      `INSERT INTO project_suppliers (id, supplier_name, universe_match)
       VALUES (?, ?, ?)`,
      id,
      rawName,
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

    for (const row of supplierRows) {
      const supplierId = await this.normalizeSupplierName(row.original_supplier_name);
      await this.db.run(
        'UPDATE transactions SET project_supplier_id = ? WHERE original_supplier_name = ? AND project_supplier_id IS NULL',
        supplierId,
        row.original_supplier_name
      );
    }

  }

  async addAlias(canonicalName: string, alias: string): Promise<void> {
    const supplier = await this.db.get<{ id: string }>(
      'SELECT id FROM project_suppliers WHERE supplier_name = ?',
      canonicalName
    );
    if (!supplier) throw new Error(`Project supplier not found: ${canonicalName}`);

    // Also track in supplier universe
    const variants = await this.supplierUniverse.searchVariants(canonicalName);
    if (!variants.includes(alias)) {
      // Update universe aliases if available
      const info = await this.supplierUniverse.getSupplier(canonicalName);
      if (info) {
        await this.supplierUniverse.upsertSupplier(canonicalName, info);
      }
    }

    // Re-map any transactions with this alias to the canonical supplier
    await this.db.run(
      'UPDATE transactions SET project_supplier_id = ? WHERE original_supplier_name = ?',
      supplier.id,
      alias
    );
  }

  async getAliases(canonicalName: string): Promise<string[]> {
    return this.supplierUniverse.searchVariants(canonicalName);
  }

  async renameSupplier(supplierId: string, newName: string): Promise<void> {
    await this.db.run(
      'UPDATE project_suppliers SET supplier_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      newName,
      supplierId
    );
  }

  async updateSupplier(supplierId: string, updates: SupplierUpdateInput): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.supplierInfo !== undefined) {
      setClauses.push('supplier_info = ?');
      params.push(JSON.stringify(updates.supplierInfo));
    }
    if (updates.parentName !== undefined) {
      setClauses.push('parent_supplier_name = ?');
      params.push(updates.parentName);
    }
    if (updates.mappedTaxonomyPaths !== undefined) {
      setClauses.push('mapped_taxonomy_paths = ?');
      params.push(JSON.stringify(updates.mappedTaxonomyPaths));
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
    parent_supplier_name: 'ps.parent_supplier_name',
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
    { name: 'parent_supplier_name', label: 'Parent Supplier', type: 'string' },
    { name: 'data_source', label: 'Data Source', type: 'string' },
    { name: 'total_spend', label: 'Total Spend', type: 'number', group: 'Aggregates' },
    { name: 'transaction_count', label: 'Transaction Count', type: 'number', group: 'Aggregates' },
  ];

  getFilterFields(): FieldDefinition[] {
    return SupplierService.SUPPLIER_FIELD_DEFINITIONS;
  }

  /** Column resolver that validates against known fields and throws for unknown ones. */
  private static readonly SUPPLIER_COLUMN_RESOLVER: ColumnResolver = (field: string) => {
    const col = SupplierService.SUPPLIER_COLUMNS[field];
    if (!col) throw new Error(`Unknown supplier filter field: "${field}"`);
    return col;
  };

  async listProjectSuppliers(filter?: { conditions: FilterCondition[] }): Promise<ProjectSupplierView[]> {
    const hasSpend = await this.transactionColumnExists('spend_amount');
    const spendExpr = hasSpend ? 'COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0)' : '0';

    // Split conditions into regular (inner WHERE) vs aggregate (outer WHERE)
    const conditions = filter?.conditions ?? [];
    const regularConditions = conditions.filter(c => !SupplierService.AGGREGATE_FIELDS.has(c.field));
    const aggregateConditions = conditions.filter(c => SupplierService.AGGREGATE_FIELDS.has(c.field));

    // Build inner WHERE clause for non-aggregate fields
    const innerWhere = buildWhereClause(regularConditions, SupplierService.SUPPLIER_COLUMN_RESOLVER);
    const innerWhereSQL = innerWhere ? `WHERE ${innerWhere.sql}` : '';
    const innerParams = innerWhere?.params ?? [];

    // Build inner query
    const innerSQL = `SELECT ps.*,
        COUNT(t.id) as transaction_count,
        ${spendExpr} as total_spend
      FROM project_suppliers ps
      LEFT JOIN transactions t ON t.project_supplier_id = ps.id
      ${innerWhereSQL}
      GROUP BY ALL`;

    // Build outer WHERE clause for aggregate fields
    const outerWhere = buildWhereClause(aggregateConditions, SupplierService.SUPPLIER_COLUMN_RESOLVER);
    const outerWhereSQL = outerWhere ? `WHERE ${outerWhere.sql}` : '';
    const outerParams = outerWhere?.params ?? [];

    const sql = aggregateConditions.length > 0
      ? `SELECT * FROM (${innerSQL}) sub ${outerWhereSQL} ORDER BY sub.supplier_name`
      : `${innerSQL} ORDER BY ps.supplier_name`;

    const allParams = [...innerParams, ...outerParams];

    const rows = await this.db.all<{
      id: string;
      supplier_name: string;
      confirmation_status: string;
      is_tail_spend: boolean;
      parent_supplier_name: string | null;
      universe_match: boolean;
      is_researched: boolean;
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
      created_at: string;
      transaction_count: number | bigint;
      total_spend: number | bigint;
    }>(sql, ...allParams);

    return rows.map((row) => ({
      id: row.id,
      supplierName: row.supplier_name,
      confirmationStatus: row.confirmation_status as SupplierConfirmationStatus,
      isTailSpend: Boolean(row.is_tail_spend),
      parentSupplierName: row.parent_supplier_name,
      parentName: row.parent_supplier_name,
      supplierInfo: row.supplier_info ? JSON.parse(row.supplier_info) : null,
      mappedTaxonomyPaths: row.mapped_taxonomy_paths ? JSON.parse(row.mapped_taxonomy_paths) : null,
      universeMatch: Boolean(row.universe_match),
      isResearched: Boolean(row.is_researched),
      createdAt: String(row.created_at),
      transactionCount: Number(row.transaction_count),
      totalSpend: Number(row.total_spend),
      aliases: [],
    }));
  }

  async getProjectSupplier(id: string): Promise<ProjectSupplier | null> {
    const row = await this.db.get<{
      id: string;
      supplier_name: string;
      confirmation_status: string;
      is_tail_spend: boolean;
      parent_supplier_name: string | null;
      universe_match: boolean;
      is_researched: boolean;
      supplier_info: string | null;
      mapped_taxonomy_paths: string | null;
      created_at: string;
    }>(
      'SELECT * FROM project_suppliers WHERE id = ?',
      id
    );

    if (!row) return null;

    return {
      id: row.id,
      supplierName: row.supplier_name,
      confirmationStatus: row.confirmation_status as SupplierConfirmationStatus,
      isTailSpend: Boolean(row.is_tail_spend),
      parentSupplierName: row.parent_supplier_name,
      parentName: row.parent_supplier_name,
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

  async assignParent(id: string, parentId: string): Promise<void> {
    const parent = await this.db.get<{ supplier_name: string }>(
      'SELECT supplier_name FROM project_suppliers WHERE id = ?',
      parentId
    );
    if (!parent) throw new Error(`Parent supplier not found: ${parentId}`);

    await this.db.run(
      'UPDATE project_suppliers SET parent_supplier_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      parent.supplier_name,
      id
    );
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
