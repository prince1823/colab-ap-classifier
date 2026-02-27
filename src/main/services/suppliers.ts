import { v4 as uuidv4 } from 'uuid';
import { databaseService, supplierUniverseService } from './database';
import type {
  Supplier,
  ProjectSupplierView,
  SupplierUpdateInput,
  SupplierInfo,
} from '../../shared/types';

/**
 * Raw DB row shape from supplier_universe.db (snake_case columns).
 */
interface SupplierRow {
  id: string;
  supplier_name: string;
  aliases: string | null;
  parent_supplier_id: string | null;
  parent_name: string | null;
  supplier_info: string | null;
  category_a: boolean;
  category_a_taxonomy_node_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseJSON<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
}

function rowToSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    supplierName: row.supplier_name,
    aliases: parseJSON<string[]>(row.aliases),
    parentSupplierId: row.parent_supplier_id,
    parentName: row.parent_name,
    supplierInfo: parseJSON<SupplierInfo>(row.supplier_info),
    categoryA: Boolean(row.category_a),
    categoryATaxonomyNodeId: row.category_a_taxonomy_node_id,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Project Suppliers (derived from transactions + supplier_universe.db)
// ---------------------------------------------------------------------------

/**
 * List all project suppliers.
 * Derived from `SELECT DISTINCT supplier_name FROM transactions`,
 * joined with supplier_universe.db for enriched data.
 */
export async function listProjectSuppliers(): Promise<ProjectSupplierView[]> {
  // supplier_name is a dynamic column added at CSV import — may not exist yet
  const cols = await databaseService.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'supplier_name'"
  );
  if (cols.length === 0) return [];

  // Get distinct suppliers with transaction counts/spend from the project DB
  const projectSuppliers = await databaseService.all<{
    supplier_name: string;
    transaction_count: number | bigint;
    total_spend: number | bigint;
  }>(
    `SELECT
      supplier_name,
      COUNT(*) as transaction_count,
      COALESCE(SUM(TRY_CAST(spend_amount AS DOUBLE)), 0) as total_spend
    FROM transactions
    WHERE supplier_name IS NOT NULL
    GROUP BY supplier_name
    ORDER BY supplier_name`
  );

  if (projectSuppliers.length === 0) return [];

  // Fetch matching supplier universe data
  const names = projectSuppliers.map((s) => s.supplier_name);
  const universeMap = await getSuppliersByNames(names);

  return projectSuppliers.map((ps) => {
    const universe = universeMap.get(ps.supplier_name);
    return {
      supplierName: ps.supplier_name,
      transactionCount: Number(ps.transaction_count),
      totalSpend: Number(ps.total_spend),
      supplierInfo: universe?.supplierInfo ?? null,
      parentName: universe?.parentName ?? null,
      categoryA: universe?.categoryA ?? false,
      categoryATaxonomyNodeId: universe?.categoryATaxonomyNodeId ?? null,
      isResearched: universe !== undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Supplier Universe CRUD
// ---------------------------------------------------------------------------

/**
 * Get a supplier from the universe by exact name.
 */
export async function getSupplierByName(name: string): Promise<Supplier | null> {
  const row = await supplierUniverseService.get<SupplierRow>(
    'SELECT * FROM suppliers WHERE supplier_name = ?',
    name
  );
  return row ? rowToSupplier(row) : null;
}

/**
 * Get multiple suppliers by name in a single query.
 */
export async function getSuppliersByNames(names: string[]): Promise<Map<string, Supplier>> {
  if (names.length === 0) return new Map();

  const placeholders = names.map(() => '?').join(',');
  const rows = await supplierUniverseService.all<SupplierRow>(
    `SELECT * FROM suppliers WHERE supplier_name IN (${placeholders})`,
    ...names
  );

  const result = new Map<string, Supplier>();
  for (const row of rows) {
    result.set(row.supplier_name, rowToSupplier(row));
  }
  return result;
}

/**
 * Update specific fields of a supplier in supplier_universe.db.
 */
export async function updateSupplier(
  supplierName: string,
  updates: SupplierUpdateInput
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.parentSupplierId !== undefined) {
    setClauses.push('parent_supplier_id = ?');
    params.push(updates.parentSupplierId);
  }
  if (updates.parentName !== undefined) {
    setClauses.push('parent_name = ?');
    params.push(updates.parentName);
  }
  if (updates.categoryA !== undefined) {
    setClauses.push('category_a = ?');
    params.push(updates.categoryA);
  }
  if (updates.categoryATaxonomyNodeId !== undefined) {
    setClauses.push('category_a_taxonomy_node_id = ?');
    params.push(updates.categoryATaxonomyNodeId);
  }
  if (updates.supplierInfo !== undefined) {
    setClauses.push('supplier_info = ?');
    params.push(JSON.stringify(updates.supplierInfo));
  }
  if (updates.aliases !== undefined) {
    setClauses.push('aliases = ?');
    params.push(updates.aliases ? JSON.stringify(updates.aliases) : null);
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  params.push(supplierName);

  await supplierUniverseService.run(
    `UPDATE suppliers SET ${setClauses.join(', ')} WHERE supplier_name = ?`,
    ...params
  );
}

/**
 * Insert or update a supplier in supplier_universe.db.
 * Upserts by supplier_name.
 */
export async function upsertSupplier(
  supplierName: string,
  data: Partial<Omit<Supplier, 'id' | 'supplierName' | 'createdAt' | 'updatedAt'>>
): Promise<void> {
  const existing = await getSupplierByName(supplierName);

  if (existing) {
    const updates: SupplierUpdateInput = {};
    if (data.parentSupplierId !== undefined) updates.parentSupplierId = data.parentSupplierId;
    if (data.parentName !== undefined) updates.parentName = data.parentName;
    if (data.categoryA !== undefined) updates.categoryA = data.categoryA;
    if (data.categoryATaxonomyNodeId !== undefined) updates.categoryATaxonomyNodeId = data.categoryATaxonomyNodeId;
    if (data.supplierInfo !== undefined) updates.supplierInfo = data.supplierInfo ?? undefined;
    if (data.aliases !== undefined) updates.aliases = data.aliases;
    await updateSupplier(supplierName, updates);
  } else {
    const id = uuidv4();
    await supplierUniverseService.run(
      `INSERT INTO suppliers (id, supplier_name, aliases, parent_supplier_id, parent_name, supplier_info, category_a, category_a_taxonomy_node_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      supplierName,
      data.aliases ? JSON.stringify(data.aliases) : null,
      data.parentSupplierId ?? null,
      data.parentName ?? null,
      data.supplierInfo ? JSON.stringify(data.supplierInfo) : null,
      data.categoryA ?? false,
      data.categoryATaxonomyNodeId ?? null
    );
  }
}
