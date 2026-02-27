import { registerHandler } from './register';
import { selectFile, parsePreview, importCSVForReview } from '../services/upload';

export function registerUploadHandlers(): void {
  registerHandler('upload:selectFile', async () => {
    return selectFile();
  });

  registerHandler('upload:parsePreview', async (_event, filePath: unknown) => {
    return parsePreview(filePath as string);
  });

  registerHandler('upload:loadFullCSV', async (_event, filePath: unknown) => {
    return importCSVForReview(filePath as string);
  });
}
