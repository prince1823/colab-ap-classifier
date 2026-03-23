import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { existsSync, unlinkSync } from 'fs';
import type { Database } from '../../shared/types/services';

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

const EXPECTED_TABLES = ['project_settings', 'taxonomy', 'transactions', 'override_rules', 'change_log', 'uploads', 'project_suppliers', 'supplier_parents'];

export { convertPlaceholders };

export class DuckDBDatabase implements Database {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private currentFilePath: string | null = null;
  // Serialize all queries — DuckDB single connection does not support concurrency
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn) as Promise<T>;
    this.queue = next.catch(() => {});
    return next;
  }

  async openDatabase(filePath: string): Promise<void> {
    if (this.instance) {
      await this.closeDatabase();
    }

    try {
      this.instance = await DuckDBInstance.create(filePath);
      this.connection = await this.instance.connect();
    } catch (err) {
      const walPath = filePath + '.wal';
      if (existsSync(walPath)) {
        console.warn(`[Database] Failed to open database, removing corrupted WAL file: ${walPath}`);
        try { unlinkSync(walPath); } catch { /* ignore */ }
        this.instance = await DuckDBInstance.create(filePath);
        this.connection = await this.instance.connect();
      } else {
        throw err;
      }
    }

    this.currentFilePath = filePath;

    const tables = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'project_settings'"
    );

    if (tables.length === 0) {
      await this.initializeSchema();
    }

    // Migrate existing .c91 files: ensure uploads table exists
    const uploadsTable = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'uploads'"
    );
    if (uploadsTable.length === 0) {
      await this.exec(`
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
      `);
    }

    // Migrate: ensure project_suppliers table exists
    const psTable = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'project_suppliers'"
    );
    if (psTable.length === 0) {
      await this.exec(`
        CREATE TABLE IF NOT EXISTS project_suppliers (
          id VARCHAR PRIMARY KEY,
          supplier_name VARCHAR NOT NULL UNIQUE,
          confirmation_status VARCHAR DEFAULT 'pending',
          is_tail_spend BOOLEAN DEFAULT FALSE,
          parent_supplier_id VARCHAR,
          data_source VARCHAR DEFAULT 'manual',
          universe_match BOOLEAN DEFAULT FALSE,
          is_researched BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_project_suppliers_name ON project_suppliers(supplier_name);
      `);
    }

    // Migrate: ensure supplier_info and mapped_taxonomy_paths columns exist on project_suppliers
    const siCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'supplier_info'"
    );
    if (siCol.length === 0) {
      await this.exec(`
        ALTER TABLE project_suppliers ADD COLUMN supplier_info JSON;
        ALTER TABLE project_suppliers ADD COLUMN mapped_taxonomy_paths JSON;
      `);
    }

    // Migrate: ensure is_researched column exists on project_suppliers
    const irCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'is_researched'"
    );
    if (irCol.length === 0) {
      await this.exec(`
        ALTER TABLE project_suppliers ADD COLUMN is_researched BOOLEAN DEFAULT FALSE;
        UPDATE project_suppliers SET is_researched = TRUE WHERE supplier_info IS NOT NULL;
      `);
    }

    // Migrate: drop classification_reasoning column from transactions if it exists
    try {
      await this.exec('ALTER TABLE transactions DROP COLUMN classification_reasoning');
    } catch { /* column doesn't exist, ignore */ }

    // Migrate: add is_reverted column to change_log
    try {
      await this.exec('ALTER TABLE change_log ADD COLUMN is_reverted BOOLEAN DEFAULT FALSE');
    } catch { /* column already exists, ignore */ }

    // Migrate: clean up old "Reverted:" entries — mark originals as reverted and delete the revert rows
    try {
      // Mark original entries as reverted if a "Reverted:" entry exists for them
      await this.exec(`
        UPDATE change_log SET is_reverted = TRUE
        WHERE is_reverted = FALSE
          AND description IS NOT NULL
          AND id IN (
            SELECT cl2.reverted_change_id FROM change_log cl2
            WHERE cl2.reverted_change_id IS NOT NULL
          )
      `);
      // Delete old "Reverted:" rows (those with description starting with 'Reverted:')
      await this.exec("DELETE FROM change_log WHERE description LIKE 'Reverted:%'");
    } catch { /* ignore — reverted_change_id column may not exist */ }

    // Drop old reverted_change_id column if it exists
    try {
      await this.exec('ALTER TABLE change_log DROP COLUMN reverted_change_id');
    } catch { /* column doesn't exist, ignore */ }

    // Migrate: ensure flagged_for_review column exists on transactions
    const frCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'flagged_for_review'"
    );
    if (frCol.length === 0) {
      await this.exec('ALTER TABLE transactions ADD COLUMN flagged_for_review BOOLEAN DEFAULT FALSE');
    }

    // Migrate: ensure applied_rule_id column exists on transactions
    const appliedRuleCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'applied_rule_id'"
    );
    if (appliedRuleCol.length === 0) {
      await this.exec('ALTER TABLE transactions ADD COLUMN applied_rule_id VARCHAR');
    }

    // Migrate: drop name unique index and convert priority DOUBLE→INTEGER for existing projects
    try {
      await this.exec('DROP INDEX IF EXISTS idx_override_rules_name');
    } catch { /* ignore */ }
    const priorityColType = await this.all<{ data_type: string }>(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'priority'"
    );
    if (priorityColType.length > 0 && priorityColType[0].data_type.toUpperCase() === 'DOUBLE') {
      await this.exec(`
        CREATE TABLE override_rules_int_migration (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          grouped_conditions JSON NOT NULL,
          target_taxonomy_node_id VARCHAR NOT NULL,
          priority INTEGER NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          source VARCHAR DEFAULT 'manual',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO override_rules_int_migration
          SELECT id, name, grouped_conditions, target_taxonomy_node_id, CAST(ROUND(priority) AS INTEGER), is_active, source, created_at
          FROM override_rules;
        DROP TABLE override_rules;
        ALTER TABLE override_rules_int_migration RENAME TO override_rules;
      `);
    }

    // Migrate: ensure supplier_parents table exists
    const spTable = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'supplier_parents'"
    );
    if (spTable.length === 0) {
      await this.exec(`
        CREATE TABLE IF NOT EXISTS supplier_parents (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }

    // Migrate: replace parent_supplier_name with parent_supplier_id FK on project_suppliers
    const parentIdCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'parent_supplier_id'"
    );
    if (parentIdCol.length === 0) {
      await this.exec(`ALTER TABLE project_suppliers ADD COLUMN parent_supplier_id VARCHAR;`);
    }
    try {
      await this.exec('ALTER TABLE project_suppliers DROP COLUMN parent_supplier_name');
    } catch { /* column already removed, ignore */ }

    // Migrate: drop flat conditions column and make grouped_conditions the sole conditions store.
    // Recreates the table if conditions column still exists (handles INTEGER priority and old schema in one pass).
    const conditionsCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'conditions'"
    );
    if (conditionsCol.length > 0) {
      const hasGroupedCond = await this.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'grouped_conditions'"
      );
      // Carry over grouped_conditions if it exists; otherwise seed from flat conditions as a single-group fallback
      const groupedSelect = hasGroupedCond.length > 0
        ? 'COALESCE(grouped_conditions, conditions)'
        : 'conditions';
      await this.exec(`
        CREATE TABLE override_rules_new (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          grouped_conditions JSON NOT NULL,
          target_taxonomy_node_id VARCHAR NOT NULL,
          priority INTEGER NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO override_rules_new
          SELECT id, name, ${groupedSelect}, target_taxonomy_node_id, CAST(ROUND(CAST(priority AS DOUBLE)) AS INTEGER), is_active, created_at
          FROM override_rules;
        DROP TABLE override_rules;
        ALTER TABLE override_rules_new RENAME TO override_rules;
      `);
    }

    // Migrate: ensure source column exists on override_rules
    const sourceCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'source'"
    );
    if (sourceCol.length === 0) {
      await this.exec("ALTER TABLE override_rules ADD COLUMN source VARCHAR DEFAULT 'manual'");
    }
  }

  async closeDatabase(): Promise<void> {
    if (this.connection) {
      try { await this.run('CHECKPOINT'); } catch { /* ignore */ }
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

  getExpectedTables(): string[] {
    return [...EXPECTED_TABLES];
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    return this.serialize(async () => {
      const conn = this.getConnection();
      if (params.length > 0) {
        const converted = convertPlaceholders(sql);
        await conn.run(converted, params as (string | number | boolean | null)[]);
      } else {
        await conn.run(sql);
      }
    });
  }

  async exec(sql: string): Promise<void> {
    return this.serialize(async () => {
      const conn = this.getConnection();
      await conn.run(sql);
    });
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.serialize(async () => {
      const conn = this.getConnection();
      let reader;
      if (params.length > 0) {
        const converted = convertPlaceholders(sql);
        reader = await conn.runAndReadAll(converted, params as (string | number | boolean | null)[]);
      } else {
        reader = await conn.runAndReadAll(sql);
      }
      return reader.getRowObjectsJson() as T[];
    });
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const results = await this.all<T>(sql, ...params);
    return results[0];
  }

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
        original_supplier_name VARCHAR,
        project_supplier_id VARCHAR,
        applied_rule_id VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS override_rules (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        grouped_conditions JSON NOT NULL,
        target_taxonomy_node_id VARCHAR NOT NULL,
        priority INTEGER NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        source VARCHAR DEFAULT 'manual',
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
        is_reverted BOOLEAN DEFAULT FALSE,
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

      CREATE TABLE IF NOT EXISTS supplier_parents (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS project_suppliers (
        id VARCHAR PRIMARY KEY,
        supplier_name VARCHAR NOT NULL UNIQUE,
        confirmation_status VARCHAR DEFAULT 'pending',
        is_tail_spend BOOLEAN DEFAULT FALSE,
        parent_supplier_id VARCHAR,
        data_source VARCHAR DEFAULT 'manual',
        universe_match BOOLEAN DEFAULT FALSE,
        is_researched BOOLEAN DEFAULT FALSE,
        supplier_info JSON,
        mapped_taxonomy_paths JSON,
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
