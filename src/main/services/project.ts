import path from 'path';
import fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { databaseService } from './database';
import { ensureIndexes, invalidateColumnCache } from './transactions';
import { getProjectsDir } from './app-paths';
import type {
  ProjectMetadata,
  ProjectMetadataUpdate,
  CompanyContext,
} from '../../shared/types';

const C91_EXTENSION = '.c91';

const EXPECTED_TABLES = [
  'settings',
  'company_context',
  'column_mappings',
  'invoice_grouping_columns',
  'taxonomy',
  'transactions',
  'project_suppliers',
  'override_rules',
  'change_log',
  'system_feedback',
];

/** In-memory state tracking the currently-open project name. */
let currentProjectName: string | null = null;

// ---------------------------------------------------------------------------
// Core Operations
// ---------------------------------------------------------------------------

/**
 * Create a new .c91 project file.
 *
 * 1. Ensures the `./projects/` directory exists.
 * 2. Creates the DuckDB-backed .c91 file at `./projects/{name}.c91`.
 * 3. Schema + seed data are initialised by `databaseService.openDatabase`.
 */
export async function createProject(
  name: string
): Promise<{ filePath: string; name: string }> {
  if (!name || name.trim().length === 0) {
    throw new Error('Project name must not be empty');
  }

  const projectsDir = getProjectsDir();

  // Ensure the projects directory exists
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  const filePath = path.join(projectsDir, `${name}${C91_EXTENSION}`);

  if (fs.existsSync(filePath)) {
    throw new Error(`Project file already exists: ${filePath}`);
  }

  await databaseService.openDatabase(filePath);
  invalidateColumnCache();

  // Store the project name in settings
  await databaseService.run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    'project_name',
    name
  );

  currentProjectName = name;

  return { filePath, name };
}

/**
 * Open an existing .c91 project file.
 *
 * Validates that the file exists and contains the expected schema tables.
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

  for (const expected of EXPECTED_TABLES) {
    if (!tableNames.includes(expected)) {
      await databaseService.closeDatabase();
      throw new Error(
        `Invalid project file: missing table "${expected}". This file may not be a valid .c91 project.`
      );
    }
  }

  // Derive the project name — prefer stored setting, fall back to filename
  const nameSetting = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'project_name'"
  );
  const name =
    nameSetting?.value ?? path.basename(filePath, C91_EXTENSION);

  currentProjectName = name;

  // Ensure performance indexes exist (non-blocking — errors are silently ignored)
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
 * Read full project metadata from the open database.
 */
export async function getMetadata(): Promise<ProjectMetadata> {
  if (!isProjectOpen()) {
    throw new Error('No project is currently open');
  }

  const filePath = databaseService.getFilePath()!;

  // ---- company_context -------------------------------------------------
  const ccRow = await databaseService.get<{
    company_name: string | null;
    industry: string | null;
    sector: string | null;
    description: string | null;
    business_focus: string | null;
    procurement_nuances: string | null;
  }>('SELECT company_name, industry, sector, description, business_focus, procurement_nuances FROM company_context WHERE id = 1');

  let companyContext: CompanyContext | null = null;
  if (ccRow && ccRow.industry) {
    companyContext = {
      companyName: ccRow.company_name ?? undefined,
      industry: ccRow.industry,
      sector: ccRow.sector ?? undefined,
      description: ccRow.description ?? undefined,
      businessFocus: ccRow.business_focus ?? undefined,
      procurementNuances: ccRow.procurement_nuances ?? undefined,
    };
  }

  // ---- column_mappings -------------------------------------------------
  const mappingRows = await databaseService.all<{
    canonical_name: string;
    csv_column_name: string;
  }>('SELECT canonical_name, csv_column_name FROM column_mappings');

  const columnMappings =
    mappingRows.length > 0
      ? Object.fromEntries(mappingRows.map((r) => [r.canonical_name, r.csv_column_name]))
      : null;

  // ---- invoice_grouping_columns ----------------------------------------
  const groupingRows = await databaseService.all<{
    canonical_name: string;
    position: number;
  }>('SELECT canonical_name, position FROM invoice_grouping_columns ORDER BY position');

  const invoiceGroupingColumns =
    groupingRows.length > 0 ? groupingRows.map((r) => r.canonical_name) : null;

  // ---- settings --------------------------------------------------------
  const thresholdRow = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
  );
  const tailSpendThreshold = thresholdRow ? Number(thresholdRow.value) : 10000;

  const taxonomyRow = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'taxonomy_name'"
  );
  const taxonomyName = taxonomyRow?.value ?? null;

  const createdAtRow = await databaseService.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'created_at'"
  );
  const createdAt = createdAtRow?.value ?? null;

  return {
    name: currentProjectName!,
    filePath,
    companyContext,
    columnMappings,
    invoiceGroupingColumns,
    tailSpendThreshold,
    taxonomyName,
    createdAt,
  };
}

/**
 * Update mutable project metadata fields.
 *
 * Currently supports updating `companyContext` and `tailSpendThreshold`.
 */
export async function updateMetadata(
  updates: ProjectMetadataUpdate
): Promise<void> {
  if (!isProjectOpen()) {
    throw new Error('No project is currently open');
  }

  if (updates.companyContext) {
    const cc = updates.companyContext;
    await databaseService.run(
      `UPDATE company_context
       SET company_name = ?,
           industry = ?,
           sector = ?,
           description = ?,
           business_focus = ?,
           procurement_nuances = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      cc.companyName ?? null,
      cc.industry,
      cc.sector ?? null,
      cc.description ?? null,
      cc.businessFocus ?? null,
      cc.procurementNuances ?? null
    );
  }

  if (updates.tailSpendThreshold !== undefined) {
    await databaseService.run(
      `UPDATE settings
       SET value = ?, updated_at = CURRENT_TIMESTAMP
       WHERE key = 'tail_spend_threshold'`,
      String(updates.tailSpendThreshold)
    );
  }
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
    defaultPath: path.join(getProjectsDir(), 'Untitled.c91'),
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
