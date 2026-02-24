import { dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import { databaseService } from './database';

/**
 * Show a save dialog for CSV export.
 */
export async function selectExportPath(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(win!, {
    title: 'Export Classified Transactions',
    defaultPath: 'classified-transactions.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
}

/**
 * Export all transactions to a CSV file.
 */
export async function exportCSV(
  filePath: string
): Promise<{ rowsExported: number }> {
  // Get all dynamic columns
  const colRows = await databaseService.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
  );
  const allColumns = colRows.map((r) => r.column_name);

  // Base columns to exclude from canonical columns output
  const metaColumns = ['id', 'row_index', 'invoice_group_key', 'taxonomy_node_id',
    'review_score', 'classification_reasoning', 'created_at', 'updated_at'];

  const canonicalColumns = allColumns.filter((c) => !metaColumns.includes(c));

  // Query all transactions with taxonomy join
  const rows = await databaseService.all<Record<string, unknown>>(
    `SELECT t.*, tax.full_path as classification_path
     FROM transactions t
     LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
     ORDER BY t.row_index`
  );

  // Build CSV headers
  const headers = [
    ...canonicalColumns,
    'classification_path',
    'classification_l1',
    'classification_l2',
    'classification_l3',
    'review_score',
    'classification_reasoning',
  ];

  // Build CSV rows
  const csvLines: string[] = [headers.map(escapeCSV).join(',')];

  for (const row of rows) {
    const classificationPath = (row.classification_path as string) || '';
    const parts = classificationPath.split('|');
    const l1 = parts[0] || '';
    const l2 = parts[1] || '';
    const l3 = parts[2] || '';

    const values = [
      ...canonicalColumns.map((col) => row[col] ?? ''),
      classificationPath,
      l1,
      l2,
      l3,
      row.review_score ?? '',
      row.classification_reasoning ?? '',
    ];

    csvLines.push(values.map((v) => escapeCSV(String(v))).join(','));
  }

  fs.writeFileSync(filePath, csvLines.join('\r\n') + '\r\n', 'utf-8');

  return { rowsExported: rows.length };
}

/**
 * Escape a value for CSV output.
 */
function escapeCSV(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
