import path from 'path';
import fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { databaseService, supplierUniverseService } from './database';
import { invalidateColumnCache } from './transactions';

const C91_EXTENSION = '.c91';

/** In-memory state tracking the currently-open project name. */
let currentProjectName: string | null = null;

// ---------------------------------------------------------------------------
// Core Operations
// ---------------------------------------------------------------------------

/**
 * Create a new .c91 project file.
 *
 * 1. Creates the DuckDB-backed .c91 file at the given path.
 * 2. Schema + seed data are initialised by `databaseService.openDatabase`.
 * 3. Seeds the `project_settings` KV table with defaults.
 */
export async function createProject(
  name: string,
  filePath: string
): Promise<{ filePath: string; name: string }> {
  if (!name || name.trim().length === 0) {
    throw new Error('Project name must not be empty');
  }

  if (!filePath || filePath.trim().length === 0) {
    throw new Error('File path must not be empty');
  }

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    throw new Error(`Project file already exists: ${filePath}`);
  }

  await databaseService.openDatabase(filePath);
  invalidateColumnCache();

  // Seed default settings
  await setSetting('project_name', name);
  await setSetting('tail_spend_threshold', 10000);

  // Open supplier universe alongside
  await supplierUniverseService.open();

  currentProjectName = name;

  return { filePath, name };
}

/**
 * Open an existing .c91 project file.
 *
 * Validates that the file exists and contains the expected v2 schema tables.
 */
export async function openProject(
  filePath: string
): Promise<{ filePath: string; name: string }> {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error('File path must not be empty');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Project file not found: ${filePath}`);
  }

  await databaseService.openDatabase(filePath);
  invalidateColumnCache();

  // Validate schema — all expected tables must be present
  const tables = await databaseService.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
  );
  const tableNames = tables.map((t) => t.table_name);

  for (const expected of databaseService.getExpectedTables()) {
    if (!tableNames.includes(expected)) {
      await databaseService.closeDatabase();
      throw new Error(
        `Invalid project file: missing table "${expected}". This file may not be a valid v2 .c91 project.`
      );
    }
  }

  // Get project name from settings
  const name = (await getSetting('project_name') as string)
    ?? path.basename(filePath, C91_EXTENSION);

  currentProjectName = name;

  // Open supplier universe alongside
  await supplierUniverseService.open();

  // Ensure performance indexes exist (non-blocking)
  ensureIndexes().catch((err) =>
    console.warn('[Project] Failed to ensure indexes:', err)
  );

  return { filePath, name };
}

/**
 * Close the currently-open project (database connection + in-memory state).
 */
export async function closeProject(): Promise<void> {
  invalidateColumnCache();
  await databaseService.closeDatabase();
  await supplierUniverseService.close();
  currentProjectName = null;
}

/**
 * Returns whether a project is currently open.
 */
export function isProjectOpen(): boolean {
  return databaseService.isOpen() && currentProjectName !== null;
}

// ---------------------------------------------------------------------------
// Settings (Key-Value CRUD)
// ---------------------------------------------------------------------------

/**
 * Get a single setting value by key. Returns undefined if not found.
 */
export async function getSetting(key: string): Promise<unknown> {
  if (!databaseService.isOpen()) {
    throw new Error('No project is currently open');
  }

  const row = await databaseService.get<{ value: string }>(
    'SELECT value FROM project_settings WHERE key = ?',
    key
  );

  if (!row) return undefined;

  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Set (upsert) a setting value by key.
 */
export async function setSetting(key: string, value: unknown): Promise<void> {
  if (!databaseService.isOpen()) {
    throw new Error('No project is currently open');
  }

  const jsonValue = JSON.stringify(value);
  await databaseService.run(
    `INSERT INTO project_settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    jsonValue
  );
}

/**
 * Delete a setting by key.
 */
export async function deleteSetting(key: string): Promise<void> {
  if (!databaseService.isOpen()) {
    throw new Error('No project is currently open');
  }

  await databaseService.run(
    'DELETE FROM project_settings WHERE key = ?',
    key
  );
}

/**
 * Get all settings as a key-value record.
 */
export async function getAllSettings(): Promise<Record<string, unknown>> {
  if (!databaseService.isOpen()) {
    throw new Error('No project is currently open');
  }

  const rows = await databaseService.all<{ key: string; value: string }>(
    'SELECT key, value FROM project_settings'
  );

  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// File Dialogs
// ---------------------------------------------------------------------------

/**
 * Show a "Save As" dialog for creating a new .c91 project file.
 * Returns the chosen path, or null if the user cancelled.
 */
export async function selectSavePath(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(win!, {
    title: 'Create New Project',
    defaultPath: 'Untitled.c91',
    filters: [{ name: 'C91 Project', extensions: ['c91'] }],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
}

/**
 * Show an "Open" dialog for selecting an existing .c91 project file.
 * Returns the chosen path, or null if the user cancelled.
 */
export async function selectOpenPath(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win!, {
    title: 'Open Project',
    filters: [{ name: 'C91 Project', extensions: ['c91'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure performance indexes exist on the transactions table.
 * Called once when a project is opened.
 */
async function ensureIndexes(): Promise<void> {
  const { getColumns } = await import('./transactions');
  const cols = await getColumns();

  const indexDefs = [
    'CREATE INDEX IF NOT EXISTS idx_transactions_row_index ON transactions(row_index)',
    'CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(classification_status)',
  ];

  const optionalIndexCols = ['supplier_name', 'gl_description', 'spend_amount', 'line_description'];
  for (const col of optionalIndexCols) {
    if (cols.includes(col)) {
      indexDefs.push(
        `CREATE INDEX IF NOT EXISTS idx_transactions_${col} ON transactions(${col})`
      );
    }
  }

  for (const sql of indexDefs) {
    try {
      await databaseService.run(sql);
    } catch {
      // Index may already exist — safe to ignore
    }
  }
}
