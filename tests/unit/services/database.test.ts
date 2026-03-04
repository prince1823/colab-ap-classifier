import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBDatabase } from '../../../src/main/services/database';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tempDbPath(): string {
  return path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('DuckDBDatabase', () => {
  let db: DuckDBDatabase;
  let dbPath: string;

  beforeEach(() => {
    db = new DuckDBDatabase();
    dbPath = tempDbPath();
  });

  afterEach(async () => {
    if (db.isOpen()) {
      await db.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('Connection Management', () => {
    it('should open a new database and report isOpen=true', async () => {
      await db.openDatabase(dbPath);
      expect(db.isOpen()).toBe(true);
    });

    it('should close a database and report isOpen=false', async () => {
      await db.openDatabase(dbPath);
      await db.closeDatabase();
      expect(db.isOpen()).toBe(false);
    });

    it('should throw when querying a closed database', async () => {
      await expect(() => db.all("SELECT 1")).rejects.toThrow('No database is currently open');
    });

    it('should auto-close previous database when opening a new one', async () => {
      const dbPath2 = tempDbPath();
      try {
        await db.openDatabase(dbPath);
        expect(db.isOpen()).toBe(true);

        await db.openDatabase(dbPath2);
        expect(db.isOpen()).toBe(true);
        expect(db.getFilePath()).toBe(dbPath2);
      } finally {
        if (db.isOpen()) {
          await db.closeDatabase();
        }
        if (fs.existsSync(dbPath2)) {
          fs.unlinkSync(dbPath2);
        }
      }
    });

    it('should be queryable after opening', async () => {
      await db.openDatabase(dbPath);
      const result = await db.get<{ val: number }>("SELECT 1 as val");
      expect(result?.val).toBe(1);
    });
  });

  describe('Schema Initialization', () => {
    it('should create expected tables', async () => {
      await db.openDatabase(dbPath);

      const tables = await db.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      );

      const tableNames = tables.map((t) => t.table_name);

      expect(tableNames).toContain('project_settings');
      expect(tableNames).toContain('taxonomy');
      expect(tableNames).toContain('transactions');
      expect(tableNames).toContain('override_rules');
      expect(tableNames).toContain('change_log');
    });

    it('should not reinitialize schema on reopen', async () => {
      await db.openDatabase(dbPath);
      await db.run(
        "INSERT INTO project_settings (key, value) VALUES (?, ?)",
        'test_key',
        '"test_value"'
      );
      await db.closeDatabase();

      // Reopen
      await db.openDatabase(dbPath);

      const result = await db.get<{ value: string }>(
        "SELECT value FROM project_settings WHERE key = 'test_key'"
      );
      expect(result?.value).toBe('"test_value"');
    });
  });

  describe('Query Helpers', () => {
    beforeEach(async () => {
      await db.openDatabase(dbPath);
    });

    it('should execute run() for INSERT', async () => {
      await db.run(
        "INSERT INTO project_settings (key, value) VALUES (?, ?)",
        'project_name',
        '"Test Project"'
      );

      const result = await db.get<{ value: string }>(
        "SELECT value FROM project_settings WHERE key = 'project_name'"
      );
      expect(result?.value).toBe('"Test Project"');
    });

    it('should execute all() and return multiple rows', async () => {
      await db.run(
        "INSERT INTO taxonomy (id, full_path, l1, depth) VALUES (?, ?, ?, ?)",
        'node-1',
        'Corporate Services',
        'Corporate Services',
        1
      );
      await db.run(
        "INSERT INTO taxonomy (id, full_path, l1, depth) VALUES (?, ?, ?, ?)",
        'node-2',
        'Facilities',
        'Facilities',
        1
      );

      const results = await db.all<{ id: string; full_path: string }>(
        "SELECT id, full_path FROM taxonomy WHERE id IN ('node-1', 'node-2') ORDER BY id"
      );

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('node-1');
      expect(results[0].full_path).toBe('Corporate Services');
      expect(results[1].id).toBe('node-2');
      expect(results[1].full_path).toBe('Facilities');
    });

    it('should execute get() and return a single row', async () => {
      await db.run(
        "INSERT INTO project_settings (key, value) VALUES (?, ?)",
        'project_name',
        '"My Project"'
      );

      const result = await db.get<{ value: string }>(
        "SELECT value FROM project_settings WHERE key = 'project_name'"
      );

      expect(result?.value).toBe('"My Project"');
    });

    it('should return undefined from get() when no match', async () => {
      const result = await db.get<{ key: string }>(
        "SELECT key FROM project_settings WHERE key = 'nonexistent'"
      );

      expect(result).toBeUndefined();
    });

    it('should throw from query helpers when database is closed', async () => {
      await db.closeDatabase();

      await expect(() => db.all("SELECT 1")).rejects.toThrow(
        'No database is currently open'
      );
    });
  });
});
