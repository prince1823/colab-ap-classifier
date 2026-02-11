import { registerHandler } from './register';
import * as exportService from '../services/export';

export function registerExportHandlers(): void {
  registerHandler('export:selectPath', async () => {
    return exportService.selectExportPath();
  });

  registerHandler('export:export', async (_event, filePath: unknown) => {
    return exportService.exportCSV(filePath as string);
  });
}
