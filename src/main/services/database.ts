import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';

/**
 * Convert `?` placeholders to DuckDB positional `$1, $2, ...` format.
 * Skips `?` inside single-quoted string literals.
 */
function convertPlaceholders(sql: string): string {
  let idx = 0;
  let result = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (ch === "'" && !inString) {
      inString = true;
      result += ch;
    } else if (ch === "'" && inString) {
      // Handle escaped quotes ('')
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        result += "''";
        i++;
      } else {
        inString = false;
        result += ch;
      }
    } else if (ch === '?' && !inString) {
      idx++;
      result += `$${idx}`;
    } else {
      result += ch;
    }
  }

  return result;
}

// ─── Expected tables for v2 schema ───────────────────────────────────────────
const EXPECTED_TABLES = ['project_settings', 'taxonomy', 'transactions', 'override_rules', 'change_log', 'uploads', 'project_suppliers'];

// ─── Project database service ────────────────────────────────────────────────

class DatabaseService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private currentFilePath: string | null = null;

  async openDatabase(filePath: string): Promise<void> {
    if (this.instance) {
      await this.closeDatabase();
    }

    try {
      this.instance = await DuckDBInstance.create(filePath);
      this.connection = await this.instance.connect();
    } catch (err) {
      // Handle corrupted WAL file — delete it and retry
      const walPath = filePath + '.wal';
      if (existsSync(walPath)) {
        console.warn(`[Database] Failed to open database, removing corrupted WAL file: ${walPath}`);
        try {
          unlinkSync(walPath);
        } catch {
          // Ignore WAL deletion errors
        }
        this.instance = await DuckDBInstance.create(filePath);
        this.connection = await this.instance.connect();
      } else {
        throw err;
      }
    }

    this.currentFilePath = filePath;

    // Check for v2 schema by looking for the `project_settings` table
    const tables = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'project_settings'"
    );

    if (tables.length === 0) {
      await this.initializeSchema();
    }

    // Ensure uploads table exists (added in ingest refactor — migrate existing .c91 files)
    const uploadsTable = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'uploads'"
    );
    if (uploadsTable.length === 0) {
      await this.exec(`
        CREATE TABLE IF NOT EXISTS uploads (
          id VARCHAR PRIMARY KEY,
          file_name VARCHAR NOT NULL,
          column_mappings JSON,
          row_count INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
  }

  async closeDatabase(): Promise<void> {
    if (this.connection) {
      // Flush WAL to main database file before closing to prevent corruption
      try {
        await this.run('CHECKPOINT');
      } catch {
        // Ignore checkpoint errors — close anyway
      }
      this.connection.closeSync();
      this.connection = null;
    }
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
    this.currentFilePath = null;
  }

  private getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error('No database is currently open');
    }
    return this.connection;
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  getFilePath(): string | null {
    return this.currentFilePath;
  }

  /** Get the expected tables for validation */
  getExpectedTables(): string[] {
    return [...EXPECTED_TABLES];
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    const conn = this.getConnection();
    if (params.length > 0) {
      const converted = convertPlaceholders(sql);
      await conn.run(converted, params as (string | number | boolean | null)[]);
    } else {
      await conn.run(sql);
    }
  }

  /**
   * Execute one or more SQL statements (semicolon-separated), without returning results.
   * Useful for multi-statement batches like multiple INSERTs.
   */
  async exec(sql: string): Promise<void> {
    const conn = this.getConnection();
    await conn.run(sql);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const conn = this.getConnection();
    let reader;
    if (params.length > 0) {
      const converted = convertPlaceholders(sql);
      reader = await conn.runAndReadAll(converted, params as (string | number | boolean | null)[]);
    } else {
      reader = await conn.runAndReadAll(sql);
    }
    return reader.getRowObjectsJson() as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const results = await this.all<T>(sql, ...params);
    return results[0];
  }

  /**
   * v2 schema: 6 tables.
   * - project_settings (key-value store)
   * - taxonomy
   * - transactions (base columns; canonical columns added at import via ALTER TABLE)
   * - override_rules
   * - change_log
   * - uploads (file metadata + column mappings)
   */
  private async initializeSchema(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS project_settings (
        key VARCHAR PRIMARY KEY,
        value JSON
      );

      CREATE TABLE IF NOT EXISTS taxonomy (
        id VARCHAR PRIMARY KEY,
        full_path VARCHAR NOT NULL UNIQUE,
        l1 VARCHAR NOT NULL,
        l2 VARCHAR,
        l3 VARCHAR,
        depth INTEGER NOT NULL,
        description TEXT,
        parent_path VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR PRIMARY KEY,
        upload_id VARCHAR,
        row_index INTEGER,
        taxonomy_node_id VARCHAR,
        classification_status VARCHAR DEFAULT 'unclassified',
        human_reviewed BOOLEAN DEFAULT FALSE,
        classification_reasoning TEXT,
        original_supplier_name VARCHAR,
        project_supplier_id VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS override_rules (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        conditions JSON NOT NULL,
        target_taxonomy_node_id VARCHAR NOT NULL,
        priority INTEGER NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS change_log (
        id VARCHAR PRIMARY KEY,
        source VARCHAR NOT NULL,
        affected_table VARCHAR NOT NULL,
        affected_ids JSON NOT NULL,
        affected_count INTEGER NOT NULL,
        old_values JSON,
        new_values JSON,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS uploads (
        id VARCHAR PRIMARY KEY,
        file_name VARCHAR NOT NULL,
        file_path VARCHAR,
        column_mappings JSON NOT NULL,
        row_count INTEGER,
        status VARCHAR DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS project_suppliers (
        id VARCHAR PRIMARY KEY,
        supplier_name VARCHAR NOT NULL UNIQUE,
        confirmation_status VARCHAR DEFAULT 'pending',
        is_tail_spend BOOLEAN DEFAULT FALSE,
        parent_supplier_name VARCHAR,
        data_source VARCHAR DEFAULT 'manual',
        universe_match BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_project_suppliers_name ON project_suppliers(supplier_name);
      CREATE INDEX IF NOT EXISTS idx_transactions_taxonomy ON transactions(taxonomy_node_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(classification_status);
      CREATE INDEX IF NOT EXISTS idx_transactions_upload ON transactions(upload_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_supplier ON transactions(project_supplier_id);
    `);
  }
}

// ─── Supplier Universe database service ──────────────────────────────────────

class SupplierUniverseService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private filePath: string | null = null;
  private defaultPath: string | null = null;

  /**
   * Override the default supplier_universe.db location.
   * Useful for tests to avoid DuckDB file lock conflicts.
   */
  setDefaultPath(p: string): void {
    this.defaultPath = p;
  }

  /**
   * Open (or create) the shared supplier_universe.db.
   * Default location: colabip/supplier_universe.db (or overridden via setDefaultPath)
   */
  async open(filePath?: string): Promise<void> {
    if (this.instance) {
      await this.close();
    }

    const dbPath = filePath || this.defaultPath || path.join(process.cwd(), 'colabip', 'supplier_universe.db');

    try {
      this.instance = await DuckDBInstance.create(dbPath);
      this.connection = await this.instance.connect();
    } catch (err) {
      const walPath = dbPath + '.wal';
      if (existsSync(walPath)) {
        console.warn(`[SupplierUniverse] Removing corrupted WAL file: ${walPath}`);
        try { unlinkSync(walPath); } catch { /* ignore */ }
        this.instance = await DuckDBInstance.create(dbPath);
        this.connection = await this.instance.connect();
      } else {
        throw err;
      }
    }

    this.filePath = dbPath;

    // Initialize schema if needed
    const tables = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'suppliers'"
    );

    if (tables.length === 0) {
      await this.initializeSchema();
    }
  }

  async close(): Promise<void> {
    if (this.connection) {
      try { await this.run('CHECKPOINT'); } catch { /* ignore */ }
      this.connection.closeSync();
      this.connection = null;
    }
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
    this.filePath = null;
  }

  private getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error('Supplier universe database is not open');
    }
    return this.connection;
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  getFilePath(): string | null {
    return this.filePath;
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    const conn = this.getConnection();
    if (params.length > 0) {
      const converted = convertPlaceholders(sql);
      await conn.run(converted, params as (string | number | boolean | null)[]);
    } else {
      await conn.run(sql);
    }
  }

  async exec(sql: string): Promise<void> {
    const conn = this.getConnection();
    await conn.run(sql);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const conn = this.getConnection();
    let reader;
    if (params.length > 0) {
      const converted = convertPlaceholders(sql);
      reader = await conn.runAndReadAll(converted, params as (string | number | boolean | null)[]);
    } else {
      reader = await conn.runAndReadAll(sql);
    }
    return reader.getRowObjectsJson() as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const results = await this.all<T>(sql, ...params);
    return results[0];
  }

  private async initializeSchema(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id VARCHAR PRIMARY KEY,
        supplier_name VARCHAR NOT NULL UNIQUE,
        aliases JSON,
        parent_supplier_id VARCHAR,
        parent_name VARCHAR,
        supplier_info JSON,
        mapped_taxonomy_paths JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(supplier_name);
    `);
  }
}

export const databaseService = new DatabaseService();
export const supplierUniverseService = new SupplierUniverseService();
