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

  async queryTransactions(filters?: TransactionFilter): Promise<Transaction[]> {
    const whereClauses: string[] = [];
    const params: unknown[] = [];

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
      const built = buildWhereClause(filters.conditions);
      if (built) {
        whereClauses.push(`(${built.sql})`);
        params.push(...built.params);
      }
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

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
      SELECT t.*, tax.full_path as classification_path, ps.supplier_name as supplier_name
      FROM transactions t
      LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
      LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
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
      // Add supplier_name from JOIN
      if (row.supplier_name) {
        canonicalFields.supplier_name = row.supplier_name;
      }

      return {
        id: String(row.id),
        rowIndex: Number(row.row_index ?? 0),
        taxonomyNodeId: row.taxonomy_node_id ? String(row.taxonomy_node_id) : null,
        classificationPath: row.classification_path ? String(row.classification_path) : null,
        classificationStatus: (row.classification_status as ClassificationStatus) || 'unclassified',
        classificationReasoning: row.classification_reasoning ? String(row.classification_reasoning) : null,
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
        COUNT(CASE WHEN classification_status != 'unclassified' THEN 1 END) as classified_rows,
        COUNT(CASE WHEN classification_status = 'unclassified' THEN 1 END) as unclassified_rows
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
    const whereClauses: string[] = [];
    const params: unknown[] = [];

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
      const built = buildWhereClause(filters.conditions);
      if (built) {
        whereClauses.push(`(${built.sql})`);
        params.push(...built.params);
      }
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as cnt FROM transactions t LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id ${whereSQL}`;
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
}
