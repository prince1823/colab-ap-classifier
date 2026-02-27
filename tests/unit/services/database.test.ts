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

    it('should throw when querying a closed database', async () => {
      await expect(() => databaseService.all("SELECT 1")).rejects.toThrow('No database is currently open');
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

    it('should be queryable after opening', async () => {
      await databaseService.openDatabase(dbPath);
      const result = await databaseService.get<{ val: number }>("SELECT 1 as val");
      expect(result?.val).toBe(1);
    });
  });

  describe('Schema Initialization', () => {
    it('should create all 5 tables', async () => {
      await databaseService.openDatabase(dbPath);

      const tables = await databaseService.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      );

      const tableNames = tables.map((t) => t.table_name);

      expect(tableNames).toContain('project');
      expect(tableNames).toContain('taxonomy');
      expect(tableNames).toContain('transactions');
      expect(tableNames).toContain('override_rules');
      expect(tableNames).toContain('change_log');
      expect(tableNames).toHaveLength(5);
    });

    it('should match EXPECTED_TABLES constant', async () => {
      await databaseService.openDatabase(dbPath);

      const tables = await databaseService.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      );

      const tableNames = tables.map((t) => t.table_name).sort();
      expect(tableNames).toEqual([...databaseService.getExpectedTables()].sort());
    });

    it('should create the taxonomy_node_id index on transactions', async () => {
      await databaseService.openDatabase(dbPath);

      const indexes = await databaseService.all<{ index_name: string }>(
        "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'transactions'"
      );

      const indexNames = indexes.map((i) => i.index_name);
      expect(indexNames).toContain('idx_transactions_taxonomy');
    });

    it('should not reinitialize schema on reopen', async () => {
      await databaseService.openDatabase(dbPath);
      await databaseService.run(
        "INSERT INTO project (id, project_name) VALUES (?, ?)",
        'test-id',
        'Test Project'
      );
      await databaseService.closeDatabase();

      // Reopen
      await databaseService.openDatabase(dbPath);

      const result = await databaseService.get<{ project_name: string }>(
        "SELECT project_name FROM project WHERE id = 'test-id'"
      );
      expect(result?.project_name).toBe('Test Project');

      // Tables should still be intact
      const tables = await databaseService.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      );
      expect(tables).toHaveLength(5);
    });
  });

  describe('Query Helpers', () => {
    beforeEach(async () => {
      await databaseService.openDatabase(dbPath);
    });

    it('should execute run() for INSERT', async () => {
      await databaseService.run(
        "INSERT INTO project (id, project_name) VALUES (?, ?)",
        'test-id',
        'Test Project'
      );

      const result = await databaseService.get<{ project_name: string }>(
        "SELECT project_name FROM project WHERE id = 'test-id'"
      );
      expect(result?.project_name).toBe('Test Project');
    });

    it('should execute all() and return multiple rows', async () => {
      await databaseService.run(
        "INSERT INTO taxonomy (id, full_path, l1, depth) VALUES (?, ?, ?, ?)",
        'node-1',
        'Corporate Services',
        'Corporate Services',
        1
      );
      await databaseService.run(
        "INSERT INTO taxonomy (id, full_path, l1, depth) VALUES (?, ?, ?, ?)",
        'node-2',
        'Facilities',
        'Facilities',
        1
      );

      const results = await databaseService.all<{ id: string; full_path: string }>(
        "SELECT id, full_path FROM taxonomy WHERE id IN ('node-1', 'node-2') ORDER BY id"
      );

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('node-1');
      expect(results[0].full_path).toBe('Corporate Services');
      expect(results[1].id).toBe('node-2');
      expect(results[1].full_path).toBe('Facilities');
    });

    it('should execute get() and return a single row', async () => {
      await databaseService.run(
        "INSERT INTO project (id, project_name) VALUES (?, ?)",
        'proj-1',
        'My Project'
      );

      const result = await databaseService.get<{ project_name: string }>(
        "SELECT project_name FROM project WHERE id = 'proj-1'"
      );

      expect(result?.project_name).toBe('My Project');
    });

    it('should return undefined from get() when no match', async () => {
      const result = await databaseService.get<{ id: string }>(
        "SELECT id FROM project WHERE id = 'nonexistent'"
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

    it('should have correct columns in project table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'project' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual([
        'id', 'project_name', 'created_at', 'company_context',
        'taxonomy_name', 'tail_spend_threshold', 'column_mapping'
      ]);
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
        'id', 'row_index', 'taxonomy_node_id', 'classification_status',
        'classification_reasoning', 'created_at', 'updated_at'
      ]);
    });

    it('should have correct columns in override_rules table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'override_rules' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual([
        'id', 'name', 'conditions', 'target_taxonomy_node_id',
        'priority_score', 'is_active', 'created_at'
      ]);
    });

    it('should have correct columns in change_log table', async () => {
      const columns = await databaseService.all<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'change_log' ORDER BY ordinal_position"
      );

      const names = columns.map((c) => c.column_name);
      expect(names).toEqual([
        'id', 'source', 'affected_table', 'affected_ids', 'affected_count',
        'old_values', 'new_values', 'description', 'created_at'
      ]);
    });
  });
});
