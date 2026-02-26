// Load .env before any service imports
import { loadEnv } from './load-env';
loadEnv();

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { registerAllHandlers } from './ipc';
import { setMainWindow as setClassificationMainWindow } from './services/classification';
import { setMainWindow as setResearchMainWindow } from './services/supplier-research';
import { setColabipBasePath } from './services/colabip';

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

  // In development, load from Vite dev server; in production, load built files
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

function getColabipDir(): string {
  const isDev = !app.isPackaged;
  if (isDev) {
    return path.join(process.cwd(), 'colabip');
  }
  return path.join(process.resourcesPath, 'colabip');
}

app.whenReady().then(() => {
  setColabipBasePath(getColabipDir());
  registerAllHandlers();
  createWindow();
  if (mainWindow) {
    setClassificationMainWindow(mainWindow);
    setResearchMainWindow(mainWindow);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    if (mainWindow) {
      setClassificationMainWindow(mainWindow);
      setResearchMainWindow(mainWindow);
    }
  }
});
