import { dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import type { Database, ExportService as IExportService } from '../../shared/types/services';

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export class ExportService implements IExportService {
  constructor(private db: Database) {}

  async exportCSV(): Promise<{ rowsExported: number } | null> {
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

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT t.*, ps.supplier_name, tax.full_path as classification_path
       FROM transactions t
       LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
       LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
       ORDER BY t.row_index`
    );

    const headers = [
      ...canonicalColumns,
      'supplier_name',
      'classification_path',
      'classification_l1',
      'classification_l2',
      'classification_l3',
      'classification_status',
    ];

    const csvLines: string[] = [headers.map(escapeCSV).join(',')];

    for (const row of rows) {
      const classificationPath = (row.classification_path as string) || '';
      const parts = classificationPath.split('|');

      const values = [
        ...canonicalColumns.map((col) => row[col] ?? ''),
        row.supplier_name ?? '',
        classificationPath,
        parts[0] || '',
        parts[1] || '',
        parts[2] || '',
        row.classification_status ?? 'unclassified',
      ];

      csvLines.push(values.map((v) => escapeCSV(String(v))).join(','));
    }

    fs.writeFileSync(filePath, csvLines.join('\r\n') + '\r\n', 'utf-8');
    return { rowsExported: rows.length };
  }
}
