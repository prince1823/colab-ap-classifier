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
} from '../../shared/types/suppliers';

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
      `INSERT INTO project_suppliers (id, supplier_name, data_source, universe_match)
       VALUES (?, ?, ?, ?)`,
      id,
      rawName,
      universeInfo ? 'universe' : 'manual',
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

  async listProjectSuppliers(): Promise<ProjectSupplierView[]> {
    const rows = await this.db.all<{
      id: string;
      supplier_name: string;
      confirmation_status: string;
      is_tail_spend: boolean;
      parent_supplier_name: string | null;
      data_source: string;
      universe_match: boolean;
      created_at: string;
      transaction_count: number | bigint;
      total_spend: number | bigint;
    }>(
      `SELECT ps.*,
        COUNT(t.id) as transaction_count,
        COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) as total_spend
      FROM project_suppliers ps
      LEFT JOIN transactions t ON t.project_supplier_id = ps.id
      GROUP BY ps.id, ps.supplier_name, ps.confirmation_status, ps.is_tail_spend,
               ps.parent_supplier_name, ps.data_source, ps.universe_match, ps.created_at, ps.updated_at
      ORDER BY ps.supplier_name`
    );

    return rows.map((row) => ({
      id: row.id,
      supplierName: row.supplier_name,
      confirmationStatus: row.confirmation_status as SupplierConfirmationStatus,
      isTailSpend: Boolean(row.is_tail_spend),
      parentSupplierName: row.parent_supplier_name,
      dataSource: row.data_source as ProjectSupplier['dataSource'],
      universeMatch: Boolean(row.universe_match),
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
      data_source: string;
      universe_match: boolean;
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
      dataSource: row.data_source as ProjectSupplier['dataSource'],
      universeMatch: Boolean(row.universe_match),
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

  async enrichProjectSupplier(id: string): Promise<ProjectSupplierView> {
    const supplier = await this.getProjectSupplier(id);
    if (!supplier) throw new Error(`Project supplier not found: ${id}`);

    // Get universe data
    const universeInfo = await this.supplierUniverse.getSupplier(supplier.supplierName);
    if (universeInfo) {
      await this.db.run(
        'UPDATE project_suppliers SET universe_match = TRUE, data_source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        'universe',
        id
      );
    }

    // Get transaction aggregates
    const agg = await this.db.get<{ cnt: number | bigint; spend: number | bigint }>(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(TRY_CAST(spend_amount AS DOUBLE)), 0) as spend
       FROM transactions WHERE project_supplier_id = ?`,
      id
    );

    const aliases = await this.supplierUniverse.searchVariants(supplier.supplierName);

    return {
      ...supplier,
      universeMatch: universeInfo !== null,
      dataSource: universeInfo ? 'universe' : supplier.dataSource,
      transactionCount: Number(agg?.cnt ?? 0),
      totalSpend: Number(agg?.spend ?? 0),
      aliases,
    };
  }
}
