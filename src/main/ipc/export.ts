import { dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import { registerHandler } from './register';
import type { ExportService } from '../../shared/types/services';

export function registerExportHandlers(exportService: ExportService): void {
  registerHandler('export:columns', async () => {
    return exportService.getExportColumns();
  });

  registerHandler('export:csv', async (_event, filters: unknown, selectedColumns: unknown) => {
    return exportService.exportCSV(
      filters as import('../../shared/types/transactions').TransactionFilter | undefined,
      selectedColumns as string[] | undefined,
    );
  });

  registerHandler('export:saveContent', async (_event, content: unknown, defaultFilename: unknown) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Pivot View',
      defaultPath: String(defaultFilename || 'pivot-export.csv'),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, String(content), 'utf-8');
    return true;
  });
}
