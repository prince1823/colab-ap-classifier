import { registerHandler } from './register';
import * as exportService from '../services/export';

export function registerExportHandlers(): void {
  registerHandler('export:csv', async () => {
    return exportService.exportCSV();
  });
}
