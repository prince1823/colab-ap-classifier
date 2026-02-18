import { Database } from 'duckdb-async';

class DatabaseService {
  private db: Database | null = null;
  private currentFilePath: string | null = null;

  async openDatabase(filePath: string): Promise<Database> {
    if (this.db) {
      await this.closeDatabase();
    }

    this.db = await Database.create(filePath);
    this.currentFilePath = filePath;

    const tables = await this.db.all(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'settings'"
    );

    if (tables.length === 0) {
      await this.initializeSchema();
    }

    await this.runMigrations();

    return this.db;
  }

  async closeDatabase(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.currentFilePath = null;
    }
  }

  getDatabase(): Database {
    if (!this.db) {
      throw new Error('No database is currently open');
    }
    return this.db;
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  getFilePath(): string | null {
    return this.currentFilePath;
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    const db = this.getDatabase();
    await db.run(sql, ...params);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const db = this.getDatabase();
    return db.all(sql, ...params) as Promise<T[]>;
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const db = this.getDatabase();
    const results = await db.all(sql, ...params) as T[];
    return results[0];
  }

  /**
   * Run schema migrations for existing databases.
   * Adds columns that may be missing from older .c91 files.
   */
  private async runMigrations(): Promise<void> {
    const db = this.getDatabase();

    // Add aliases column to project_suppliers if missing
    const cols = await db.all(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'aliases'"
    );
    if (cols.length === 0) {
      await db.run('ALTER TABLE project_suppliers ADD COLUMN aliases JSON');
    }
  }

  private async initializeSchema(): Promise<void> {
    const db = this.getDatabase();

    await db.exec(`
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
    await db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'tail_spend_threshold',
      '10000'
    );

    await db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, CURRENT_TIMESTAMP::VARCHAR, CURRENT_TIMESTAMP)",
      'created_at'
    );

    // Seed empty company context row
    await db.run("INSERT INTO company_context (id) VALUES (1)");
  }
}

export const databaseService = new DatabaseService();
