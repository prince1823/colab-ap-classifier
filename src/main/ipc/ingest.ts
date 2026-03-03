import { registerHandler } from './register';
import { selectFile, parseCSVPreview, suggestMappings, importCSV, getLatestUpload } from '../services/ingest';

export function registerIngestHandlers(): void {
  registerHandler('ingest:selectFile', async () => {
    return selectFile();
  });

  registerHandler('ingest:parseCSV', async (_event, filePath: unknown) => {
    return parseCSVPreview(filePath as string);
  });

  registerHandler('ingest:suggestMappings', async (_event, columns: unknown, sampleRows: unknown) => {
    return suggestMappings(columns as string[], sampleRows as Record<string, string>[]);
  });

  registerHandler('ingest:importCSV', async (_event, filePath: unknown, mapping: unknown) => {
    return importCSV(filePath as string, mapping as Record<string, string> | undefined);
  });

  registerHandler('ingest:getUpload', async () => {
    return getLatestUpload();
  });
}
