import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DuckDBDatabase } from '../../../src/main/services/database';
import { ChangelogStore } from '../../../src/main/services/changelog';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tempDbPath(): string {
  return path.join(os.tmpdir(), `test-changelog-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('ChangelogStore', () => {
  let dbPath: string;
  let db: DuckDBDatabase;
  let store: ChangelogStore;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = new DuckDBDatabase();
    await db.openDatabase(dbPath);
    store = new ChangelogStore(db);
  });

  afterEach(async () => {
    if (db.isOpen()) {
      await db.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('logChange', () => {
    it('should log a change and it appears in list', async () => {
      const id = await store.logChange({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['txn-1', 'txn-2'],
        affectedCount: 2,
        oldValues: { taxonomy_node_id: 'old-node' },
        newValues: { taxonomy_node_id: 'new-node' },
        description: 'Reclassified two transactions',
      });

      expect(id).toBeTruthy();

      const changes = await store.listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe(id);
      expect(changes[0].source).toBe('manual');
      expect(changes[0].affectedTable).toBe('transactions');
      expect(changes[0].affectedIds).toEqual(['txn-1', 'txn-2']);
      expect(changes[0].affectedCount).toBe(2);
      expect(changes[0].oldValues).toEqual({ taxonomy_node_id: 'old-node' });
      expect(changes[0].newValues).toEqual({ taxonomy_node_id: 'new-node' });
      expect(changes[0].description).toBe('Reclassified two transactions');
    });

    it('should handle null oldValues and newValues', async () => {
      const id = await store.logChange({
        source: 'pipeline',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: null,
        newValues: null,
        description: null,
      });

      const changes = await store.listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe(id);
      expect(changes[0].oldValues).toBeNull();
      expect(changes[0].newValues).toBeNull();
    });
  });

  describe('listChanges', () => {
    it('should return multiple changes in reverse chronological order', async () => {
      const id1 = await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'a' }, newValues: { taxonomy_node_id: 'b' },
        description: 'First change',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const id2 = await store.logChange({
        source: 'pipeline', affectedTable: 'transactions', affectedIds: ['txn-2'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'c' }, newValues: { taxonomy_node_id: 'd' },
        description: 'Second change',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const id3 = await store.logChange({
        source: 'manual', affectedTable: 'taxonomy', affectedIds: ['tax-1'],
        affectedCount: 1, oldValues: { l1: 'old' }, newValues: { l1: 'new' },
        description: 'Third change',
      });

      const changes = await store.listChanges();
      expect(changes).toHaveLength(3);
      expect(changes[0].id).toBe(id3);
      expect(changes[1].id).toBe(id2);
      expect(changes[2].id).toBe(id1);
    });

    it('should return empty array when no changes exist', async () => {
      const changes = await store.listChanges();
      expect(changes).toHaveLength(0);
    });
  });

  describe('revertChange', () => {
    it('should revert a change and restore affected rows', async () => {
      await db.run(
        `INSERT INTO transactions (id, row_index, taxonomy_node_id) VALUES (?, ?, ?)`,
        'txn-1', 0, 'original-node'
      );

      const changeId = await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'original-node' },
        newValues: { taxonomy_node_id: 'changed-node' }, description: 'Changed classification',
      });

      await db.run(`UPDATE transactions SET taxonomy_node_id = ? WHERE id = ?`, 'changed-node', 'txn-1');

      await store.revertChange(changeId);

      const afterRevert = await db.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?', 'txn-1'
      );
      expect(afterRevert?.taxonomy_node_id).toBe('original-node');

      const changes = await store.listChanges();
      expect(changes).toHaveLength(2);
    });

    it('should throw when changelog entry not found', async () => {
      await expect(store.revertChange('nonexistent-id')).rejects.toThrow(
        'Changelog entry not found: nonexistent-id'
      );
    });

    it('should throw when no old_values to revert', async () => {
      const id = await store.logChange({
        source: 'pipeline', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: null, newValues: { taxonomy_node_id: 'new-node' },
        description: 'Import without old values',
      });

      await expect(store.revertChange(id)).rejects.toThrow(
        `Cannot revert change ${id}: no old_values recorded`
      );
    });
  });
});
