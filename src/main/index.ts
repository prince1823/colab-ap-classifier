// Load .env before any service imports
import { loadEnv } from './load-env';
loadEnv();

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { createContainer } from './container';
import { registerAllHandlers } from './ipc';

// Prevent unhandled errors from crashing the entire Electron app
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Colab91 Classifier',
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const services = createContainer();
  registerAllHandlers(services);
  createWindow();

  // Forward EventBus events to renderer
  services.eventBus.on('classification:progress', (...args: unknown[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('classification:progress', ...args);
    }
  });
  services.eventBus.on('suppliers:research:progress', (...args: unknown[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('suppliers:research:progress', ...args);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
