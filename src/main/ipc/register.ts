import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { IPCResponse } from '../../shared/types';

/**
 * Register an IPC handler that auto-wraps the return value in IPCResponse<T>.
 * Errors are caught and returned as { success: false, error: message }.
 */
export function registerHandler<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T
): void {
  try { console.log(`[IPC] Registering handler: ${channel}`); } catch { /* EPIPE safe */ }
  ipcMain.handle(channel, async (event, ...args): Promise<IPCResponse<T>> => {
    try {
      const data = await handler(event, ...args);
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { console.error(`[IPC] Error in ${channel}:`, message); } catch { /* EPIPE safe */ }
      return { success: false, error: message };
    }
  });
}

/**
 * Send an event from the main process to a renderer window.
 * Events do NOT use the IPCResponse envelope — payload is sent directly.
 */
export function sendEvent(
  window: BrowserWindow,
  channel: string,
  ...args: unknown[]
): void {
  if (!window.isDestroyed()) {
    window.webContents.send(channel, ...args);
  }
}

/**
 * Remove a previously registered IPC handler. Useful for test cleanup.
 */
export function removeHandler(channel: string): void {
  ipcMain.removeHandler(channel);
}
