import path from 'path';
import fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { databaseService, supplierUniverseService } from './database';
import { invalidateColumnCache } from './transactions';
import type {
  ProjectMetadata,
  ProjectMetadataUpdate,
  CompanyContext,
} from '../../shared/types';

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
 * 3. Inserts the single `project` row.
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

  // Insert the single project row
  const id = uuidv4();
  await databaseService.run(
    `INSERT INTO project (id, project_name, created_at, tail_spend_threshold)
     VALUES (?, ?, CURRENT_TIMESTAMP, 10000)`,
    id,
    name
  );

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

  // Get project name from the single project row
  const projectRow = await databaseService.get<{ project_name: string }>(
    'SELECT project_name FROM project LIMIT 1'
  );
  const name = projectRow?.project_name ?? path.basename(filePath, C91_EXTENSION);

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
// Metadata
// ---------------------------------------------------------------------------

/**
 * Read full project metadata from the single `project` row.
 */
export async function getMetadata(): Promise<ProjectMetadata> {
  if (!isProjectOpen()) {
    throw new Error('No project is currently open');
  }

  const row = await databaseService.get<{
    id: string;
    project_name: string;
    created_at: string;
    company_context: string | null;
    taxonomy_name: string | null;
    tail_spend_threshold: number;
    column_mapping: string | null;
  }>('SELECT id, project_name, created_at, company_context, taxonomy_name, tail_spend_threshold, column_mapping FROM project LIMIT 1');

  if (!row) {
    throw new Error('Project row not found — database may be corrupted');
  }

  let companyContext: CompanyContext | null = null;
  if (row.company_context) {
    try {
      companyContext = typeof row.company_context === 'string'
        ? JSON.parse(row.company_context)
        : row.company_context;
    } catch {
      companyContext = null;
    }
  }

  let columnMapping: Record<string, unknown> | null = null;
  if (row.column_mapping) {
    try {
      columnMapping = typeof row.column_mapping === 'string'
        ? JSON.parse(row.column_mapping)
        : row.column_mapping;
    } catch {
      columnMapping = null;
    }
  }

  return {
    id: row.id,
    projectName: row.project_name,
    createdAt: String(row.created_at),
    companyContext,
    taxonomyName: row.taxonomy_name ?? null,
    tailSpendThreshold: Number(row.tail_spend_threshold ?? 10000),
    columnMapping,
  };
}

/**
 * Update mutable project metadata fields.
 * Builds a dynamic UPDATE targeting only provided fields.
 */
export async function updateMetadata(
  updates: ProjectMetadataUpdate
): Promise<void> {
  if (!isProjectOpen()) {
    throw new Error('No project is currently open');
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.companyContext !== undefined) {
    setClauses.push('company_context = ?');
    params.push(JSON.stringify(updates.companyContext));
  }

  if (updates.tailSpendThreshold !== undefined) {
    setClauses.push('tail_spend_threshold = ?');
    params.push(updates.tailSpendThreshold);
  }

  if (updates.taxonomyName !== undefined) {
    setClauses.push('taxonomy_name = ?');
    params.push(updates.taxonomyName);
  }

  if (updates.columnMapping !== undefined) {
    setClauses.push('column_mapping = ?');
    params.push(JSON.stringify(updates.columnMapping));
  }

  if (setClauses.length === 0) return;

  await databaseService.run(
    `UPDATE project SET ${setClauses.join(', ')}`,
    ...params
  );
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
