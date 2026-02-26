import { registerHandler } from './register';
import { selectFile, parsePreview, importCSV } from '../services/upload';

export function registerUploadHandlers(): void {
  registerHandler('upload:selectFile', async () => {
    return selectFile();
  });

  registerHandler('upload:parsePreview', async (_event, filePath: unknown) => {
    return parsePreview(filePath as string);
  });

  registerHandler('upload:csv', async (_event, filePath: unknown) => {
    return importCSV(filePath as string);
  });
}
