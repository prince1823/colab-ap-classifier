import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import type {
  ProjectSupplier,
  SupplierUpdateInput,
  SupplierInfo,
} from '../../shared/types/suppliers';

/**
 * Raw DB row shape for project_suppliers (snake_case columns).
 */
interface SupplierRow {
  id: string;
  supplier_name: string;
  aliases: string | null;
  parent_supplier_id: string | null;
  supplier_info: string | null;
  category_a: boolean;
  category_a_taxonomy_node_id: string | null;
  transaction_count: number;
  total_spend: number;
  created_at: string;
  updated_at: string;
}

/**
 * Convert a snake_case DB row to a camelCase ProjectSupplier object.
 * Parses the supplier_info JSON field.
 */
function rowToSupplier(row: SupplierRow): ProjectSupplier {
  let supplierInfo: SupplierInfo | null = null;
  if (row.supplier_info) {
    try {
      supplierInfo = JSON.parse(row.supplier_info);
    } catch {
      supplierInfo = null;
    }
  }

  let aliases: string[] | null = null;
  if (row.aliases) {
    try {
      aliases = JSON.parse(row.aliases);
    } catch {
      aliases = null;
    }
  }

  return {
    id: row.id,
    supplierName: row.supplier_name,
    aliases,
    parentSupplierId: row.parent_supplier_id,
    supplierInfo,
    categoryA: Boolean(row.category_a),
    categoryATaxonomyNodeId: row.category_a_taxonomy_node_id,
    transactionCount: Number(row.transaction_count),
    totalSpend: Number(row.total_spend),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * List all suppliers from the project_suppliers table.
 */
export async function listSuppliers(): Promise<ProjectSupplier[]> {
  const rows = await databaseService.all<SupplierRow>(
    'SELECT id, supplier_name, aliases, parent_supplier_id, supplier_info, category_a, category_a_taxonomy_node_id, transaction_count, total_spend, created_at, updated_at FROM project_suppliers ORDER BY supplier_name'
  );
  return rows.map(rowToSupplier);
}

/**
 * Get a single supplier by name.
 */
export async function getSupplierByName(name: string): Promise<ProjectSupplier | null> {
  const row = await databaseService.get<SupplierRow>(
    'SELECT id, supplier_name, aliases, parent_supplier_id, supplier_info, category_a, category_a_taxonomy_node_id, transaction_count, total_spend, created_at, updated_at FROM project_suppliers WHERE supplier_name = ?',
    name
  );
  return row ? rowToSupplier(row) : null;
}

/**
 * Find a project supplier whose aliases array contains the given name.
 * Uses json_contains on the JSON-encoded aliases column.
 */
export async function getSupplierByAlias(alias: string): Promise<ProjectSupplier | null> {
  const row = await databaseService.get<SupplierRow>(
    "SELECT id, supplier_name, aliases, parent_supplier_id, supplier_info, category_a, category_a_taxonomy_node_id, transaction_count, total_spend, created_at, updated_at FROM project_suppliers WHERE aliases IS NOT NULL AND json_contains(aliases, ?)",
    JSON.stringify(alias)
  );
  return row ? rowToSupplier(row) : null;
}

/**
 * Update specific fields of a supplier identified by name.
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

  if (setClauses.length === 0) {
    return;
  }

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  params.push(supplierName);

  await databaseService.run(
    `UPDATE project_suppliers SET ${setClauses.join(', ')} WHERE supplier_name = ?`,
    ...params
  );
}

/**
 * Insert a new supplier or update an existing one by supplier_name.
 */
export async function upsertSupplier(
  supplier: Partial<ProjectSupplier> & { supplierName: string }
): Promise<void> {
  const existing = await getSupplierByName(supplier.supplierName);

  if (existing) {
    // Build update input from the partial supplier fields
    const updates: SupplierUpdateInput = {};

    if (supplier.parentSupplierId !== undefined) {
      updates.parentSupplierId = supplier.parentSupplierId;
    }
    if (supplier.categoryA !== undefined) {
      updates.categoryA = supplier.categoryA;
    }
    if (supplier.categoryATaxonomyNodeId !== undefined) {
      updates.categoryATaxonomyNodeId = supplier.categoryATaxonomyNodeId;
    }
    if (supplier.supplierInfo !== undefined) {
      updates.supplierInfo = supplier.supplierInfo ?? undefined;
    }
    if (supplier.aliases !== undefined) {
      updates.aliases = supplier.aliases;
    }

    // Also handle transactionCount and totalSpend if provided
    const extraClauses: string[] = [];
    const extraParams: unknown[] = [];

    if (supplier.transactionCount !== undefined) {
      extraClauses.push('transaction_count = ?');
      extraParams.push(supplier.transactionCount);
    }
    if (supplier.totalSpend !== undefined) {
      extraClauses.push('total_spend = ?');
      extraParams.push(supplier.totalSpend);
    }

    // Use updateSupplier for the standard fields
    await updateSupplier(supplier.supplierName, updates);

    // Handle extra fields (transactionCount, totalSpend) separately
    if (extraClauses.length > 0) {
      extraClauses.push('updated_at = CURRENT_TIMESTAMP');
      extraParams.push(supplier.supplierName);

      await databaseService.run(
        `UPDATE project_suppliers SET ${extraClauses.join(', ')} WHERE supplier_name = ?`,
        ...extraParams
      );
    }
  } else {
    const id = supplier.id ?? uuidv4();
    const supplierInfoJson = supplier.supplierInfo
      ? JSON.stringify(supplier.supplierInfo)
      : null;
    const aliasesJson = supplier.aliases
      ? JSON.stringify(supplier.aliases)
      : null;

    await databaseService.run(
      `INSERT INTO project_suppliers (id, supplier_name, aliases, parent_supplier_id, supplier_info, category_a, category_a_taxonomy_node_id, transaction_count, total_spend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      supplier.supplierName,
      aliasesJson,
      supplier.parentSupplierId ?? null,
      supplierInfoJson,
      supplier.categoryA ?? false,
      supplier.categoryATaxonomyNodeId ?? null,
      supplier.transactionCount ?? 0,
      supplier.totalSpend ?? 0
    );
  }
}
