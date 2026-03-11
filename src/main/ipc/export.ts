import { registerHandler } from './register';
import type { ExportService } from '../../shared/types/services';

export function registerExportHandlers(exportService: ExportService): void {
  registerHandler('export:csv', async () => {
    return exportService.exportCSV();
  });
}
