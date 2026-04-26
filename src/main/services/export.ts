import { dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import type { Database, ExportService as IExportService } from '../../shared/types/services';
import type { TransactionFilter } from '../../shared/types/transactions';
import { buildGroupedWhereClause } from '../utils/query-builder';
// Virtual columns (supplier_name, parent_name, classification_*) are resolved via JOINs —
// see VIRTUAL_COLUMN_REGISTRY in src/shared/virtual-columns.ts. The export header list below
// is intentionally explicit: not every virtual column appears in the export output.

const EXPORT_BATCH_SIZE = 10000;

/** Computed columns that are derived from JOINs, not directly on the transactions table */
const COMPUTED_COLUMNS = [
  'supplier_name',
  'parent_name',
  'classification_path',
  'classification_l1',
  'classification_l2',
  'classification_l3',
  'classification_status',
];

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const FILTER_VIRTUAL_DIMS: Record<string, string> = {
  classification_l1: 'tax.l1',
  classification_l2: 'tax.l2',
  classification_l3: 'tax.l3',
  supplier_name: 'ps.supplier_name',
  is_researched: 'ps.is_researched',
};

function buildExportFilterSQL(filters?: TransactionFilter): { whereSQL: string; params: unknown[] } {
  if (!filters) return { whereSQL: '', params: [] };

  const whereClauses: string[] = [];
  const params: unknown[] = [];
  const resolver = (field: string) => FILTER_VIRTUAL_DIMS[field] ?? `t."${field}"`;

  if (filters.supplierName) {
    whereClauses.push('ps.supplier_name = ?');
    params.push(filters.supplierName);
  }
  if (filters.taxonomyNodeId) {
    whereClauses.push('t.taxonomy_node_id = ?');
    params.push(filters.taxonomyNodeId);
  }
  if (filters.classificationStatus) {
    whereClauses.push('t.classification_status = ?');
    params.push(filters.classificationStatus);
  }
  if (filters.spendMin !== undefined) {
    whereClauses.push('CAST(t.spend_amount AS DOUBLE) >= ?');
    params.push(filters.spendMin);
  }
  if (filters.spendMax !== undefined) {
    whereClauses.push('CAST(t.spend_amount AS DOUBLE) <= ?');
    params.push(filters.spendMax);
  }

  if (filters.groupedConditions && filters.groupedConditions.groups.length > 0) {
    const built = buildGroupedWhereClause(filters.groupedConditions, resolver);
    if (built) {
      whereClauses.push(`(${built.sql})`);
      params.push(...built.params);
    }
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  return { whereSQL, params };
}

export class ExportService implements IExportService {
  constructor(private db: Database) {}

  /**
   * Returns the list of all available export column names in default order.
   * Source columns from the transactions table + computed columns from JOINs.
   */
  async getExportColumns(): Promise<string[]> {
    const colRows = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
    );
    const allColumns = colRows.map((r) => r.column_name);

    const metaColumns = ['id', 'row_index', 'upload_id', 'taxonomy_node_id',
      'classification_status', 'human_reviewed',
      'original_supplier_name', 'project_supplier_id', 'created_at', 'updated_at'];

    const canonicalColumns = allColumns.filter((c) => !metaColumns.includes(c));

    return [...canonicalColumns, ...COMPUTED_COLUMNS];
  }

  /**
   * Export transactions as CSV.
   * @param filters Optional filter to narrow the exported rows.
   * @param selectedColumns Optional ordered list of column names to include.
   *   If omitted, all available columns are exported in default order.
   */
  async exportCSV(
    filters?: TransactionFilter,
    selectedColumns?: string[],
  ): Promise<{ rowsExported: number } | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Classified Transactions',
      defaultPath: 'classified-transactions.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });

    if (result.canceled || !result.filePath) return null;

    const filePath = result.filePath;

    const colRows = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
    );
    const allColumns = colRows.map((r) => r.column_name);

    const metaColumns = ['id', 'row_index', 'upload_id', 'taxonomy_node_id',
      'classification_status', 'human_reviewed',
      'original_supplier_name', 'project_supplier_id', 'created_at', 'updated_at'];

    const canonicalColumns = allColumns.filter((c) => !metaColumns.includes(c));

    const allHeaders = [...canonicalColumns, ...COMPUTED_COLUMNS];

    // Use selectedColumns if provided; otherwise export all in default order
    const headers = selectedColumns && selectedColumns.length > 0
      ? selectedColumns.filter(c => allHeaders.includes(c))
      : allHeaders;

    if (headers.length === 0) return null;

    const { whereSQL, params } = buildExportFilterSQL(filters);

    // Stream export in batches to avoid loading all rows into memory
    const ws = fs.createWriteStream(filePath, { encoding: 'utf-8' });

    // Capture write errors early (e.g. disk full) so the loop can abort
    let writeError: Error | null = null;
    ws.on('error', (err) => { writeError = err; });

    ws.write(headers.map(escapeCSV).join(',') + '\r\n');

    let totalExported = 0;
    let offset = 0;

    while (!writeError) {
      const rows = await this.db.all<Record<string, unknown>>(
        `SELECT t.*, ps.supplier_name, sp.name as parent_name, tax.full_path as classification_path
         FROM transactions t
         LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
         LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id
         LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
         ${whereSQL}
         ORDER BY t.row_index
         LIMIT ${EXPORT_BATCH_SIZE} OFFSET ${offset}`,
        ...params
      );

      if (rows.length === 0) break;

      for (const row of rows) {
        const classificationPath = (row.classification_path as string) || '';
        const parts = classificationPath.split('|');

        // Build a lookup for all possible column values
        const rowValues: Record<string, string> = {};
        for (const col of canonicalColumns) {
          rowValues[col] = String(row[col] ?? '');
        }
        rowValues['supplier_name'] = String(row.supplier_name ?? '');
        rowValues['parent_name'] = String(row.parent_name ?? '');
        rowValues['classification_path'] = classificationPath;
        rowValues['classification_l1'] = parts[0] || '';
        rowValues['classification_l2'] = parts[1] || '';
        rowValues['classification_l3'] = parts[2] || '';
        rowValues['classification_status'] = String(row.classification_status ?? 'unclassified');

        const values = headers.map(h => rowValues[h] ?? '');

        const line = values.map((v) => escapeCSV(v)).join(',') + '\r\n';

        // Handle backpressure — if internal buffer is full, wait for drain
        if (!ws.write(line)) {
          await new Promise<void>((resolve) => ws.once('drain', resolve));
        }
      }

      totalExported += rows.length;
      offset += EXPORT_BATCH_SIZE;
    }

    // If a write error occurred during the loop, throw it
    if (writeError) {
      ws.destroy();
      throw writeError;
    }

    // Close the stream and wait for it to finish
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve());
      ws.on('error', reject);
    });

    return { rowsExported: totalExported };
  }
}
