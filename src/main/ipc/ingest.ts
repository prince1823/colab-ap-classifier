import { registerHandler } from './register';
import type { IngestService, EventBus } from '../../shared/types/services';
import type { ColumnMapping, DeriveMappingsSource } from '../../shared/types/column-mapping';

export function registerIngestHandlers(ingest: IngestService, eventBus: EventBus): void {
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
    try {
      return await ingest.importCSV(filePath as string, mapping as ColumnMapping);
    } catch (err) {
      console.error('[IPC] Import failed:', err);
      eventBus.emit('ingest:progress', {
        status: 'failed',
        totalRows: 0,
        processedRows: 0,
        percentage: 0,
        currentStep: 'Import failed',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  registerHandler('ingest:getUpload', async () => {
    const uploads = await ingest.getUploadHistory();
    return uploads.length > 0 ? uploads[0] : null;
  });

  registerHandler('ingest:getUploadHistory', async () => {
    return ingest.getUploadHistory();
  });

  registerHandler('ingest:deriveMappings', async (_event, columns: unknown, sampleRows: unknown, source: unknown) => {
    return ingest.deriveMappings(
      columns as string[],
      sampleRows as Record<string, string>[],
      source as DeriveMappingsSource
    );
  });

  registerHandler('ingest:getExistingCanonicals', async () => {
    return ingest.getExistingCanonicals();
  });

  registerHandler('ingest:getUploadStatsBatch', async () => {
    return ingest.getUploadStatsBatch();
  });

  registerHandler('ingest:deleteUpload', async (_event, uploadId: unknown) => {
    return ingest.deleteUpload(uploadId as string);
  });
}
