import { registerHandler } from './register';
import type { IngestService } from '../../shared/types/services';
import type { ColumnMapping } from '../../shared/types/column-mapping';

export function registerIngestHandlers(ingest: IngestService): void {
  registerHandler('ingest:selectFile', async () => {
    return ingest.selectFile();
  });

  registerHandler('ingest:parseCSV', async (_event, filePath: unknown) => {
    return ingest.parseCSVPreview(filePath as string);
  });

  registerHandler('ingest:suggestMappings', async (_event, columns: unknown, sampleRows: unknown) => {
    return ingest.suggestMappings(columns as string[], sampleRows as Record<string, string>[]);
  });

  registerHandler('ingest:importCSV', async (_event, filePath: unknown, mapping: unknown) => {
    return ingest.importCSV(filePath as string, mapping as ColumnMapping);
  });

  registerHandler('ingest:getUpload', async () => {
    const uploads = await ingest.getUploadHistory();
    return uploads.length > 0 ? uploads[0] : null;
  });
}
