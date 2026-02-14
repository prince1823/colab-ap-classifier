import { BrowserWindow } from 'electron';
import { registerHandler } from './register';
import { selectFile, parsePreview } from '../services/upload';

export function registerUploadHandlers(): void {
  registerHandler('upload:selectFile', async (event) => {
    try { console.log('[IPC] upload:selectFile — calling dialog...'); } catch { /* EPIPE */ }
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await selectFile(win);
    try { console.log('[IPC] upload:selectFile — dialog returned:', result); } catch { /* EPIPE */ }
    return result;
  });

  registerHandler('upload:parsePreview', async (_event, filePath: unknown) => {
    return parsePreview(filePath as string);
  });
}
