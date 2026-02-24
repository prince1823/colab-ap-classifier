import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export function isDev(): boolean {
  return !app.isPackaged;
}

export function getProjectsDir(): string {
  if (isDev()) {
    return path.join(process.cwd(), 'projects');
  }
  return path.join(app.getPath('userData'), 'projects');
}

export function getColabipDir(): string {
  if (isDev()) {
    return path.join(process.cwd(), 'colabip');
  }
  return path.join(process.resourcesPath, 'colabip');
}

export function getEnvDir(): string {
  if (isDev()) {
    return process.cwd();
  }
  return app.getPath('userData');
}

/**
 * Ensures critical directories exist at startup.
 */
export function ensureAppDirectories(): void {
  const dirs = [getProjectsDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
