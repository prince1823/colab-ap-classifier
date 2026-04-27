import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, unlinkSync } from 'fs';
import type { Database } from '../../shared/types/services';
import { debugLog } from '../utils/debug-log';

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

const EXPECTED_TABLES = ['project_settings', 'taxonomy', 'transactions', 'override_rules', 'change_log', 'uploads', 'project_suppliers', 'supplier_parents', 'rule_groups', 'rule_conditions'];

export { convertPlaceholders };

export class DuckDBDatabase implements Database {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private currentFilePath: string | null = null;
  // Serialize all queries — DuckDB single connection does not support concurrency
  private queue: Promise<unknown> = Promise.resolve();
  private transactionContext = new AsyncLocalStorage<{ queue: Promise<unknown> }>();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const tx = this.transactionContext.getStore();
    if (tx) {
      const next = tx.queue.then(fn, fn) as Promise<T>;
      tx.queue = next.catch(() => {});
      return next;
    }

    const next = this.queue.then(fn, fn) as Promise<T>;
    this.queue = next.catch(() => {});
    return next;
  }

  // Run `fn` inside a DuckDB transaction. Queries issued from within `fn` —
  // including those scheduled via Promise chains, microtasks, and stream
  // event listeners registered while the context is active — share a private
  // queue tracked by AsyncLocalStorage, so they all participate in the same
  // BEGIN/COMMIT (or BEGIN/ROLLBACK) without blocking on the outer queue.
  // Nested tx() calls reuse the outer transaction (DuckDB has no savepoints
  // here); an inner throw rolls back the whole outer tx.
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.transactionContext.getStore();
    if (existing) {
      return fn();
    }

    return this.serialize(async () => {
      const conn = this.getConnection();
      const context = { queue: Promise.resolve() };
      await conn.run('BEGIN TRANSACTION');
      try {
        const result = await this.transactionContext.run(context, fn);
        await context.queue;
        await conn.run('COMMIT');
        return result;
      } catch (err) {
        try {
          await conn.run('ROLLBACK');
        } catch (rollbackErr) {
          debugLog('ERROR', '[DB] transaction rollback failed', rollbackErr);
        }
        throw err;
      }
    });
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
        try { unlinkSync(walPath); } catch (e) { debugLog('WARN', 'Failed to remove WAL file', e); }
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

    // Migrate: ensure l1_l2_path column exists on project_suppliers
    const l1l2Col = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'l1_l2_path'"
    );
    if (l1l2Col.length === 0) {
      await this.exec('ALTER TABLE project_suppliers ADD COLUMN l1_l2_path VARCHAR');
    }

    // Migrate: ensure category_a_supplier column exists on project_suppliers
    const catASupCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' AND column_name = 'category_a_supplier'"
    );
    if (catASupCol.length === 0) {
      await this.exec('ALTER TABLE project_suppliers ADD COLUMN category_a_supplier BOOLEAN DEFAULT FALSE');
    }

    // Migrate: ensure category_a_supplier column exists on override_rules
    const catARuleCol = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'category_a_supplier'"
    );
    if (catARuleCol.length === 0) {
      await this.exec('ALTER TABLE override_rules ADD COLUMN category_a_supplier BOOLEAN DEFAULT FALSE');
    }

    // Migrate: drop classification_reasoning column from transactions if it exists
    try {
      await this.exec('ALTER TABLE transactions DROP COLUMN classification_reasoning');
    } catch (e) { debugLog('INFO', 'Migration: classification_reasoning column not present (expected)', e); }

    // Migrate: add is_reverted column to change_log
    try {
      await this.exec('ALTER TABLE change_log ADD COLUMN is_reverted BOOLEAN DEFAULT FALSE');
    } catch (e) { debugLog('INFO', 'Migration: is_reverted column already exists (expected)', e); }

    // Migrate: add filter_context column to change_log
    try {
      await this.exec('ALTER TABLE change_log ADD COLUMN filter_context JSON');
    } catch (e) { debugLog('INFO', 'Migration: filter_context column already exists (expected)', e); }

    // Migrate: add rule_id column to change_log
    try {
      await this.exec('ALTER TABLE change_log ADD COLUMN rule_id VARCHAR');
    } catch (e) { debugLog('INFO', 'Migration: rule_id column already exists (expected)', e); }

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
    } catch (e) { debugLog('INFO', 'Migration: reverted_change_id cleanup skipped (expected if column absent)', e); }

    // Drop old reverted_change_id column if it exists
    try {
      await this.exec('ALTER TABLE change_log DROP COLUMN reverted_change_id');
    } catch (e) { debugLog('INFO', 'Migration: reverted_change_id column not present (expected)', e); }

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
    } catch (e) { debugLog('INFO', 'Migration: parent_supplier_name column already removed (expected)', e); }

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

    // Migrate: create rule_groups table (replaces rule_buckets)
    const ruleGroupsExists = await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'rule_groups'"
    );
    if (ruleGroupsExists.length === 0) {
      await this.exec(`
        CREATE TABLE rule_groups (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          priority INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX idx_rule_groups_priority ON rule_groups(priority);
      `);

      // Migrate non-default buckets from rule_buckets if that table exists
      const ruleBucketsExists = await this.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'rule_buckets'"
      );
      if (ruleBucketsExists.length > 0) {
        // seed priority from sort_order + 1 to ensure >= 1
        await this.exec(`
          INSERT INTO rule_groups (id, name, priority, created_at)
          SELECT id, name, sort_order + 1, created_at
          FROM rule_buckets
          WHERE is_default = FALSE
        `);
      }
    }

    // Migrate: replace bucket_id + priority columns on override_rules with group_id
    const overrideRuleCols = await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules'"
    );
    const colNames = overrideRuleCols.map((r) => r.column_name);
    const hasBucketId = colNames.includes('bucket_id');
    const hasPriority = colNames.includes('priority');

    if (hasBucketId || hasPriority) {
      // Recreate table with new schema; all rules migrate to group_id = NULL (ungrouped)
      const hasGroupedCond = colNames.includes('grouped_conditions');
      const gcSelect = hasGroupedCond ? 'grouped_conditions' : "'{}'";
      await this.exec(`
        CREATE TABLE override_rules_groups_migration (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          grouped_conditions JSON NOT NULL,
          target_taxonomy_node_id VARCHAR NOT NULL,
          group_id VARCHAR,
          is_active BOOLEAN DEFAULT TRUE,
          source VARCHAR DEFAULT 'manual',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO override_rules_groups_migration
          SELECT id, name, ${gcSelect}, target_taxonomy_node_id, NULL AS group_id,
                 is_active, COALESCE(source, 'manual'), created_at
          FROM override_rules;
        DROP TABLE override_rules;
        ALTER TABLE override_rules_groups_migration RENAME TO override_rules;
      `);
    }

    // Ensure group_id column exists (handles projects created after bucket removal but before this migration)
    const hasGroupId = (await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'group_id'"
    )).length > 0;
    if (!hasGroupId) {
      await this.exec('ALTER TABLE override_rules ADD COLUMN group_id VARCHAR');
    }

    // Migrate: ensure project_supplier_id column exists on override_rules
    const hasProjectSupplierId = (await this.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' AND column_name = 'project_supplier_id'"
    )).length > 0;
    if (!hasProjectSupplierId) {
      await this.exec('ALTER TABLE override_rules ADD COLUMN project_supplier_id VARCHAR');
    }

    // Migrate: create rule_conditions table and backfill from grouped_conditions JSON
    const ruleConditionsExists = (await this.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'rule_conditions'"
    )).length > 0;
    if (!ruleConditionsExists) {
      await this.exec(`
        CREATE TABLE rule_conditions (
          rule_id VARCHAR NOT NULL,
          group_idx INTEGER NOT NULL,
          condition_idx INTEGER NOT NULL,
          field VARCHAR NOT NULL,
          operator VARCHAR NOT NULL,
          value VARCHAR,
          group_connector VARCHAR DEFAULT 'AND',
          condition_connector VARCHAR DEFAULT 'AND',
          PRIMARY KEY (rule_id, group_idx, condition_idx)
        );
        CREATE INDEX idx_rc_field_value ON rule_conditions(field, value);
        CREATE INDEX idx_rc_rule_id ON rule_conditions(rule_id);
      `);

      // Backfill from existing rules' grouped_conditions JSON
      const existingRules = await this.all<{ id: string; grouped_conditions: string }>(
        'SELECT id, grouped_conditions FROM override_rules'
      );
      for (const rule of existingRules) {
        try {
          const grouped = typeof rule.grouped_conditions === 'string'
            ? JSON.parse(rule.grouped_conditions)
            : rule.grouped_conditions;
          if (!grouped?.groups) continue;
          for (let gi = 0; gi < grouped.groups.length; gi++) {
            const group = grouped.groups[gi];
            const conditions = group.conditions ?? [];
            for (let ci = 0; ci < conditions.length; ci++) {
              const c = conditions[ci];
              await this.run(
                'INSERT INTO rule_conditions (rule_id, group_idx, condition_idx, field, operator, value, group_connector, condition_connector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                rule.id, gi, ci, c.field, c.operator, c.value ?? null,
                grouped.groupConnector ?? 'AND', group.connector ?? 'AND'
              );
            }
          }
        } catch { /* skip malformed rules */ }
      }
    }

    // Migrate: backfill project_supplier_id on override_rules from supplier_name conditions
    const needsSupplierBackfill = hasProjectSupplierId ? false : true;
    if (needsSupplierBackfill) {
      try {
        await this.exec(`
          UPDATE override_rules SET project_supplier_id = (
            SELECT ps.id FROM project_suppliers ps
            WHERE LOWER(ps.supplier_name) = LOWER(
              json_extract_string(
                json_extract(grouped_conditions, '$.groups[0].conditions[0]'),
                '$.value'
              )
            )
            AND json_extract_string(
              json_extract(grouped_conditions, '$.groups[0].conditions[0]'),
              '$.field'
            ) = 'supplier_name'
            LIMIT 1
          )
          WHERE project_supplier_id IS NULL
        `);
      } catch { /* ignore — best-effort backfill */ }
    }

    // Create missing indexes for existing projects
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_rules_group ON override_rules(group_id)'); } catch { /* already exists */ }
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_rules_active ON override_rules(is_active)'); } catch { /* already exists */ }
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_rules_cat_a ON override_rules(category_a_supplier)'); } catch { /* already exists */ }
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_rules_supplier ON override_rules(project_supplier_id)'); } catch { /* already exists */ }
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_txn_rule ON transactions(applied_rule_id)'); } catch { /* already exists */ }
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(classification_status)'); } catch { /* already exists */ }
    try { await this.exec('CREATE INDEX IF NOT EXISTS idx_txn_supplier ON transactions(project_supplier_id)'); } catch { /* already exists */ }
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

      CREATE TABLE IF NOT EXISTS rule_groups (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        priority INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_groups_priority ON rule_groups(priority);

      CREATE TABLE IF NOT EXISTS override_rules (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        grouped_conditions JSON NOT NULL,
        target_taxonomy_node_id VARCHAR NOT NULL,
        group_id VARCHAR,
        is_active BOOLEAN DEFAULT TRUE,
        source VARCHAR DEFAULT 'manual',
        category_a_supplier BOOLEAN DEFAULT FALSE,
        project_supplier_id VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rule_conditions (
        rule_id VARCHAR NOT NULL,
        group_idx INTEGER NOT NULL,
        condition_idx INTEGER NOT NULL,
        field VARCHAR NOT NULL,
        operator VARCHAR NOT NULL,
        value VARCHAR,
        group_connector VARCHAR DEFAULT 'AND',
        condition_connector VARCHAR DEFAULT 'AND',
        PRIMARY KEY (rule_id, group_idx, condition_idx)
      );

      CREATE INDEX IF NOT EXISTS idx_rc_field_value ON rule_conditions(field, value);
      CREATE INDEX IF NOT EXISTS idx_rc_rule_id ON rule_conditions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_rules_group ON override_rules(group_id);
      CREATE INDEX IF NOT EXISTS idx_rules_active ON override_rules(is_active);
      CREATE INDEX IF NOT EXISTS idx_rules_cat_a ON override_rules(category_a_supplier);
      CREATE INDEX IF NOT EXISTS idx_rules_supplier ON override_rules(project_supplier_id);
      CREATE INDEX IF NOT EXISTS idx_txn_rule ON transactions(applied_rule_id);
      CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(classification_status);
      CREATE INDEX IF NOT EXISTS idx_txn_supplier ON transactions(project_supplier_id);

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
        filter_context JSON,
        rule_id VARCHAR,
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
        l1_l2_path VARCHAR,
        category_a_supplier BOOLEAN DEFAULT FALSE,
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
