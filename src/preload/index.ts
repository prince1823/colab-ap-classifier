import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Preload script — exposes IPC methods to the renderer via contextBridge.
// Uses contextIsolation to keep renderer sandboxed from Node.js APIs.

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    // Return unsubscribe function for cleanup
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel);
  },
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke('shell:openExternal', url);
  },
});
