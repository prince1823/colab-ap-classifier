import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { existsSync, unlinkSync } from 'fs';

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

    const tables = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'settings'"
    );

    if (tables.length === 0) {
      await this.initializeSchema();
    }

    await this.runMigrations();
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
   * Run schema migrations for existing databases.
   * Adds columns that may be missing from older .c91 files.
   */
  private async runMigrations(): Promise<void> {
    // Add aliases column to project_suppliers if missing
    const cols = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'aliases'"
    );
    if (cols.length === 0) {
      await this.run('ALTER TABLE project_suppliers ADD COLUMN aliases JSON');
    }

    // Add parent_name column to project_suppliers if missing
    const parentNameCols = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'parent_name'"
    );
    if (parentNameCols.length === 0) {
      await this.run('ALTER TABLE project_suppliers ADD COLUMN parent_name VARCHAR');
    }

    // Add supplier_name index if the column exists but index is missing
    const supplierCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'supplier_name'"
    );
    if (supplierCol.length > 0) {
      await this.run('CREATE INDEX IF NOT EXISTS idx_transactions_supplier ON transactions(supplier_name)');
    }
  }

  private async initializeSchema(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR PRIMARY KEY,
        value VARCHAR,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS company_context (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        company_name VARCHAR,
        industry VARCHAR,
        sector VARCHAR,
        description TEXT,
        business_focus TEXT,
        procurement_nuances TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS column_mappings (
        canonical_name VARCHAR PRIMARY KEY,
        csv_column_name VARCHAR
      );

      CREATE TABLE IF NOT EXISTS invoice_grouping_columns (
        canonical_name VARCHAR PRIMARY KEY,
        position INTEGER NOT NULL
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
        row_index INTEGER,
        invoice_group_key VARCHAR,
        taxonomy_node_id VARCHAR,
        review_score INTEGER,
        classification_reasoning TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS project_suppliers (
        id VARCHAR PRIMARY KEY,
        supplier_name VARCHAR NOT NULL UNIQUE,
        aliases JSON,
        parent_supplier_id VARCHAR,
        parent_name VARCHAR,
        supplier_info JSON,
        category_a BOOLEAN DEFAULT FALSE,
        category_a_taxonomy_node_id VARCHAR,
        transaction_count INTEGER DEFAULT 0,
        total_spend DECIMAL(15,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS override_rules (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        source VARCHAR NOT NULL,
        conditions JSON NOT NULL,
        target_taxonomy_node_id VARCHAR NOT NULL,
        priority_score INTEGER DEFAULT 100,
        is_active BOOLEAN DEFAULT TRUE,
        imported_at TIMESTAMP,
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

      CREATE TABLE IF NOT EXISTS system_feedback (
        id VARCHAR PRIMARY KEY,
        feedback_type VARCHAR NOT NULL,
        affected_transaction_ids JSON,
        suggestion JSON NOT NULL,
        status VARCHAR NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_taxonomy ON transactions(taxonomy_node_id);
    `);

    // Seed default settings
    await this.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'tail_spend_threshold',
      '10000'
    );

    await this.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, CURRENT_TIMESTAMP::VARCHAR, CURRENT_TIMESTAMP)",
      'created_at'
    );

    // Seed empty company context row
    await this.run("INSERT INTO company_context (id) VALUES (1)");
  }
}

export const databaseService = new DatabaseService();
