import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { databaseService } from '../../../src/main/services/database';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tempDbPath(): string {
  return path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('DatabaseService', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('Connection Management', () => {
    it('should open a new database and report isOpen=true', async () => {
      await databaseService.openDatabase(dbPath);
      expect(databaseService.isOpen()).toBe(true);
    });

    it('should close a database and report isOpen=false', async () => {
      await databaseService.openDatabase(dbPath);
      await databaseService.closeDatabase();
      expect(databaseService.isOpen()).toBe(false);
    });

    it('should throw when accessing a closed database', () => {
      expect(() => databaseService.getDatabase()).toThrow('No database is currently open');
    });

    it('should auto-close previous database when opening a new one', async () => {
      const dbPath2 = tempDbPath();
      try {
        await databaseService.openDatabase(dbPath);
        expect(databaseService.isOpen()).toBe(true);

        await databaseService.openDatabase(dbPath2);
        expect(databaseService.isOpen()).toBe(true);
        expect(databaseService.getFilePath()).toBe(dbPath2);
      } finally {
        if (databaseService.isOpen()) {
          await databaseService.closeDatabase();
        }
        if (fs.existsSync(dbPath2)) {
          fs.unlinkSync(dbPath2);
        }
      }
    });

    it('should return the database instance from getDatabase()', async () => {
      await databaseService.openDatabase(dbPath);
      const db = databaseService.getDatabase();
      expect(db).toBeDefined();
    });
  });

  describe('Schema Initialization', () => {
    it('should create all 10 tables', async () => {
      await databaseService.openDatabase(dbPath);

      const tables = await databaseService.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      );

      const tableNames = tables.map((t) => t.table_name);

      expect(tableNames).toContain('settings');
      expect(tableNames).toContain('company_context');
      expect(tableNames).toContain('column_mappings');
      expect(tableNames).toContain('invoice_grouping_columns');
      expect(tableNames).toContain('taxonomy');
      expect(tableNames).toContain('transactions');
      expect(tableNames).toContain('project_suppliers');
      expect(tableNames).toContain('override_rules');
      expect(tableNames).toContain('change_log');
      expect(tableNames).toContain('system_feedback');
    });

    it('should create the taxonomy_node_id index on transactions', async () => {
      await databaseService.openDatabase(dbPath);

      const indexes = await databaseService.all<{ index_name: string }>(
        "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'transactions'"
      );

      const indexNames = indexes.map((i) => i.index_name);
      expect(indexNames).toContain('idx_transactions_taxonomy');
    });

    it('should seed default settings', async () => {
      await databaseService.openDatabase(dbPath);

      const threshold = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
      );
      expect(threshold?.value).toBe('10000');

      const createdAt = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'created_at'"
      );
      expect(createdAt?.value).toBeTruthy();
    });

    it('should seed empty company_context row with id=1', async () => {
      await databaseService.openDatabase(dbPath);

      const row = await databaseService.get<{ id: number }>(
        'SELECT id FROM company_context'
      );
      expect(row?.id).toBe(1);
    });

    it('should not reinitialize schema on reopen', async () => {
      await databaseService.openDatabase(dbPath);
      await databaseService.run(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
        'test_key',
        'test_value'
      );
      await databaseService.closeDatabase();

      // Reopen
      await databaseService.openDatabase(dbPath);

      const result = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'test_key'"
      );
      expect(result?.value).toBe('test_value');

      // Seed data should still be there too
      const threshold = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
      );
      expect(threshold?.value).toBe('10000');
    });
  });

  describe('Query Helpers', () => {
    beforeEach(async () => {
      await databaseService.openDatabase(dbPath);
    });

    it('should execute run() for INSERT', async () => {
      await databaseService.run(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
        'test_key',
        'test_value'
      );

      const result = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'test_key'"
      );
      expect(result?.value).toBe('test_value');
    });

    it('should execute all() and return multiple rows', async () => {
      await databaseService.run(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
        'key1',
        'val1'
      );
      await databaseService.run(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
        'key2',
        'val2'
      );

      const results = await databaseService.all<{ key: string; value: string }>(
        "SELECT key, value FROM settings WHERE key IN ('key1', 'key2') ORDER BY key"
      );

      expect(results).toHaveLength(2);
      expect(results[0].key).toBe('key1');
      expect(results[0].value).toBe('val1');
      expect(results[1].key).toBe('key2');
      expect(results[1].value).toBe('val2');
    });

    it('should execute get() and return a single row', async () => {
      const result = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
      );

      expect(result?.value).toBe('10000');
    });

    it('should return undefined from get() when no match', async () => {
      const result = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'nonexistent'"
      );

      expect(result).toBeUndefined();
    });

    it('should throw from query helpers when database is closed', async () => {
      await databaseService.closeDatabase();

      await expect(() => databaseService.all("SELECT 1")).rejects.toThrow(
        'No database is currently open'
      );
    });
  });

  describe('Table Schema Validation', () => {
    beforeEach(async () => {
      await databaseService.openDatabase(dbPath);
    });

    it('should have correct columns in settings table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'settings' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual(['key', 'value', 'updated_at']);
    });

    it('should have correct columns in company_context table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'company_context' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toContain('id');
      expect(names).toContain('industry');
      expect(names).toContain('sector');
      expect(names).toContain('description');
      expect(names).toContain('business_focus');
      expect(names).toContain('procurement_nuances');
      expect(names).toContain('updated_at');
    });

    it('should have correct columns in taxonomy table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'taxonomy' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual([
        'id', 'full_path', 'l1', 'l2', 'l3', 'depth', 'description', 'parent_path', 'created_at'
      ]);
    });

    it('should have correct columns in transactions table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual([
        'id', 'row_index', 'invoice_group_key', 'taxonomy_node_id',
        'review_score', 'classification_reasoning', 'created_at', 'updated_at'
      ]);
    });

    it('should have correct columns in override_rules table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual([
        'id', 'name', 'source', 'conditions', 'target_taxonomy_node_id',
        'priority_score', 'is_active', 'imported_at', 'created_at'
      ]);
    });

    it('should have correct columns in project_suppliers table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'project_suppliers' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toContain('id');
      expect(names).toContain('supplier_name');
      expect(names).toContain('parent_supplier_id');
      expect(names).toContain('supplier_type');
      expect(names).toContain('supplier_info');
      expect(names).toContain('category_a');
      expect(names).toContain('category_a_taxonomy_node_id');
      expect(names).toContain('transaction_count');
      expect(names).toContain('total_spend');
    });
  });
});
