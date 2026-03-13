import { registerHandler } from './register';
import type { ExportService } from '../../shared/types/services';

export function registerExportHandlers(exportService: ExportService): void {
  registerHandler('export:csv', async (_event, filters: unknown) => {
    return exportService.exportCSV(filters as import('../../shared/types/transactions').TransactionFilter | undefined);
  });
}
