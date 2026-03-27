import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { IPCResponse } from '../../shared/types';
import { debugLog } from '../utils/debug-log';

/**
 * Register an IPC handler that auto-wraps the return value in IPCResponse<T>.
 * Errors are caught and returned as { success: false, error: message }.
 */
export function registerHandler<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T
): void {
  console.log(`[IPC] Registering handler: ${channel}`);
  ipcMain.handle(channel, async (event, ...args): Promise<IPCResponse<T>> => {
    const t0 = Date.now();
    debugLog('INFO', `→ ${channel}`, args.length ? args : undefined);
    try {
      const data = await handler(event, ...args);
      debugLog('INFO', `✓ ${channel} (${Date.now() - t0}ms)`);
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code: string }).code : undefined;
      debugLog('ERROR', `✗ ${channel} (${Date.now() - t0}ms)`, message);
      console.error(`[IPC] Error in ${channel}:`, message);
      return { success: false, error: message, ...(code ? { code } : {}) };
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
