// Load .env before any service imports
import { loadEnv } from './load-env';
loadEnv();

import { app, BrowserWindow, nativeImage } from 'electron';
import path from 'path';
import { createContainer } from './container';
import { registerAllHandlers } from './ipc';

// Increase V8 heap limit for large datasets (5M+ rows)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

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
      backgroundThrottling: false,
    },
    title: 'Colab91 Classifier',
    icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
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

  // Set dock icon on macOS
  const iconPath = path.join(__dirname, '..', '..', '..', 'build', 'icon.png');
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

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
  services.eventBus.on('ingest:progress', (...args: unknown[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ingest:progress', ...args);
    }
  });
  services.eventBus.on('license:statusChanged', (...args: unknown[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license:statusChanged', ...args);
    }
  });

  // Start silent license checks
  services.license.startPeriodicChecks();
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
