import path from 'path';
import fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import type {
  Database,
  SupplierUniverse,
  ProjectStore as IProjectStore,
  TransactionStore as ITransactionStore,
} from '../../shared/types/services';

const C91_EXTENSION = '.c91';

export class ProjectStore implements IProjectStore {
  private currentProjectName: string | null = null;

  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private supplierUniverse: SupplierUniverse
  ) {}

  async createProject(
    name: string,
    filePath: string
  ): Promise<{ filePath: string; name: string }> {
    if (!name || name.trim().length === 0) {
      throw new Error('Project name must not be empty');
    }
    if (!filePath || filePath.trim().length === 0) {
      throw new Error('File path must not be empty');
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(filePath)) {
      throw new Error(`Project file already exists: ${filePath}`);
    }

    await this.db.openDatabase(filePath);
    this.transactions.invalidateColumnCache();

    await this.setSetting('project_name', name);
    await this.setSetting('tail_spend_threshold', 10000);

    await this.supplierUniverse.open();

    this.currentProjectName = name;

    return { filePath, name };
  }

  async openProject(
    filePath: string
  ): Promise<{ filePath: string; name: string }> {
    if (!filePath || filePath.trim().length === 0) {
      throw new Error('File path must not be empty');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Project file not found: ${filePath}`);
    }

    await this.db.openDatabase(filePath);
    this.transactions.invalidateColumnCache();

    // Validate schema
    const tables = await this.db.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
    );
    const tableNames = tables.map((t) => t.table_name);

    for (const expected of this.db.getExpectedTables()) {
      if (!tableNames.includes(expected)) {
        await this.db.closeDatabase();
        throw new Error(
          `Invalid project file: missing table "${expected}". This file may not be a valid v2 .c91 project.`
        );
      }
    }

    const name = (await this.getSetting('project_name') as string)
      ?? path.basename(filePath, C91_EXTENSION);

    this.currentProjectName = name;

    await this.supplierUniverse.open();

    // Ensure performance indexes (non-blocking)
    this.ensureIndexes().catch((err) =>
      console.warn('[Project] Failed to ensure indexes:', err)
    );

    return { filePath, name };
  }

  async closeProject(): Promise<void> {
    this.transactions.invalidateColumnCache();
    await this.db.closeDatabase();
    await this.supplierUniverse.close();
    this.currentProjectName = null;
  }

  isProjectOpen(): boolean {
    return this.db.isOpen() && this.currentProjectName !== null;
  }

  async getSetting(key: string): Promise<unknown> {
    if (!this.db.isOpen()) {
      throw new Error('No project is currently open');
    }

    const row = await this.db.get<{ value: string }>(
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

  async setSetting(key: string, value: unknown): Promise<void> {
    if (!this.db.isOpen()) {
      throw new Error('No project is currently open');
    }

    const jsonValue = JSON.stringify(value);
    await this.db.run(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      jsonValue
    );
  }

  async deleteSetting(key: string): Promise<void> {
    if (!this.db.isOpen()) {
      throw new Error('No project is currently open');
    }

    await this.db.run(
      'DELETE FROM project_settings WHERE key = ?',
      key
    );
  }

  async getAllSettings(): Promise<Record<string, unknown>> {
    if (!this.db.isOpen()) {
      throw new Error('No project is currently open');
    }

    const rows = await this.db.all<{ key: string; value: string }>(
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

  async selectSavePath(): Promise<string | null> {
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

  async selectOpenPath(): Promise<string | null> {
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

  private async ensureIndexes(): Promise<void> {
    const cols = await this.transactions.getColumns();

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
        await this.db.run(sql);
      } catch {
        // Index may already exist
      }
    }
  }
}
