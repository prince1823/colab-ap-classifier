import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { databaseService } from '../../../src/main/services/database';
import { listChanges, logChange, revertChange } from '../../../src/main/services/changelog';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tempDbPath(): string {
  return path.join(os.tmpdir(), `test-changelog-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);
}

describe('ChangelogService', () => {
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    await databaseService.openDatabase(dbPath);
  });

  afterEach(async () => {
    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('logChange', () => {
    it('should log a change and it appears in list', async () => {
      const id = await logChange({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['txn-1', 'txn-2'],
        affectedCount: 2,
        oldValues: { taxonomy_node_id: 'old-node' },
        newValues: { taxonomy_node_id: 'new-node' },
        description: 'Reclassified two transactions',
      });

      expect(id).toBeTruthy();

      const changes = await listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe(id);
      expect(changes[0].source).toBe('manual');
      expect(changes[0].affectedTable).toBe('transactions');
      expect(changes[0].affectedIds).toEqual(['txn-1', 'txn-2']);
      expect(changes[0].affectedCount).toBe(2);
      expect(changes[0].oldValues).toEqual({ taxonomy_node_id: 'old-node' });
      expect(changes[0].newValues).toEqual({ taxonomy_node_id: 'new-node' });
      expect(changes[0].description).toBe('Reclassified two transactions');
      expect(changes[0].createdAt).toBeTruthy();
    });

    it('should handle null oldValues and newValues', async () => {
      const id = await logChange({
        source: 'pipeline',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: null,
        newValues: null,
        description: null,
      });

      const changes = await listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe(id);
      expect(changes[0].oldValues).toBeNull();
      expect(changes[0].newValues).toBeNull();
      expect(changes[0].description).toBeNull();
    });
  });

  describe('listChanges', () => {
    it('should return multiple changes in reverse chronological order', async () => {
      const id1 = await logChange({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: { taxonomy_node_id: 'a' },
        newValues: { taxonomy_node_id: 'b' },
        description: 'First change',
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 50));

      const id2 = await logChange({
        source: 'pipeline',
        affectedTable: 'transactions',
        affectedIds: ['txn-2'],
        affectedCount: 1,
        oldValues: { taxonomy_node_id: 'c' },
        newValues: { taxonomy_node_id: 'd' },
        description: 'Second change',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const id3 = await logChange({
        source: 'manual',
        affectedTable: 'taxonomy',
        affectedIds: ['tax-1'],
        affectedCount: 1,
        oldValues: { l1: 'old' },
        newValues: { l1: 'new' },
        description: 'Third change',
      });

      const changes = await listChanges();
      expect(changes).toHaveLength(3);
      // Most recent first
      expect(changes[0].id).toBe(id3);
      expect(changes[1].id).toBe(id2);
      expect(changes[2].id).toBe(id1);
    });

    it('should return empty array when no changes exist', async () => {
      const changes = await listChanges();
      expect(changes).toHaveLength(0);
    });
  });

  describe('revertChange', () => {
    it('should revert a change and restore affected rows', async () => {
      // Insert a transaction to work with
      await databaseService.run(
        `INSERT INTO transactions (id, row_index, taxonomy_node_id) VALUES (?, ?, ?)`,
        'txn-1',
        0,
        'original-node'
      );

      // Log a change that modified the transaction
      const changeId = await logChange({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: { taxonomy_node_id: 'original-node' },
        newValues: { taxonomy_node_id: 'changed-node' },
        description: 'Changed classification',
      });

      // Simulate the change having been applied
      await databaseService.run(
        `UPDATE transactions SET taxonomy_node_id = ? WHERE id = ?`,
        'changed-node',
        'txn-1'
      );

      // Verify change was applied
      const beforeRevert = await databaseService.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
        'txn-1'
      );
      expect(beforeRevert?.taxonomy_node_id).toBe('changed-node');

      // Revert
      await revertChange(changeId);

      // Verify the row was restored
      const afterRevert = await databaseService.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
        'txn-1'
      );
      expect(afterRevert?.taxonomy_node_id).toBe('original-node');

      // Verify a new changelog entry was created for the revert
      const changes = await listChanges();
      expect(changes).toHaveLength(2);

      const revertEntry = changes[0]; // Most recent
      expect(revertEntry.source).toBe('manual');
      expect(revertEntry.affectedTable).toBe('transactions');
      expect(revertEntry.affectedIds).toEqual(['txn-1']);
      expect(revertEntry.oldValues).toEqual({ taxonomy_node_id: 'changed-node' });
      expect(revertEntry.newValues).toEqual({ taxonomy_node_id: 'original-node' });
      expect(revertEntry.description).toBe('Reverted: Changed classification');
    });

    it('should create a new entry when reverting a revert', async () => {
      // Insert a transaction
      await databaseService.run(
        `INSERT INTO transactions (id, row_index, taxonomy_node_id) VALUES (?, ?, ?)`,
        'txn-1',
        0,
        'node-a'
      );

      // Log the original change (node-a -> node-b)
      const change1Id = await logChange({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: { taxonomy_node_id: 'node-a' },
        newValues: { taxonomy_node_id: 'node-b' },
        description: 'Original change',
      });

      // Apply the change
      await databaseService.run(
        `UPDATE transactions SET taxonomy_node_id = ? WHERE id = ?`,
        'node-b',
        'txn-1'
      );

      // Revert the original change (node-b -> node-a)
      await revertChange(change1Id);

      // Verify row is back to node-a
      const afterFirstRevert = await databaseService.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
        'txn-1'
      );
      expect(afterFirstRevert?.taxonomy_node_id).toBe('node-a');

      // Now revert the revert (node-a -> node-b)
      const changes = await listChanges();
      const revertEntryId = changes[0].id; // The revert entry is the most recent

      await revertChange(revertEntryId);

      // Verify row is back to node-b
      const afterSecondRevert = await databaseService.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
        'txn-1'
      );
      expect(afterSecondRevert?.taxonomy_node_id).toBe('node-b');

      // Should now have 3 changelog entries (original + revert + revert-of-revert)
      const allChanges = await listChanges();
      expect(allChanges).toHaveLength(3);

      // The latest should be the revert of revert
      expect(allChanges[0].description).toBe('Reverted: Reverted: Original change');
      expect(allChanges[0].newValues).toEqual({ taxonomy_node_id: 'node-b' });
    });

    it('should throw when changelog entry not found', async () => {
      await expect(revertChange('nonexistent-id')).rejects.toThrow(
        'Changelog entry not found: nonexistent-id'
      );
    });

    it('should throw when no old_values to revert', async () => {
      const id = await logChange({
        source: 'pipeline',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: null,
        newValues: { taxonomy_node_id: 'new-node' },
        description: 'Import without old values',
      });

      await expect(revertChange(id)).rejects.toThrow(
        `Cannot revert change ${id}: no old_values recorded`
      );
    });

    it('should revert changes affecting multiple rows', async () => {
      // Insert multiple transactions
      await databaseService.run(
        `INSERT INTO transactions (id, row_index, taxonomy_node_id) VALUES (?, ?, ?)`,
        'txn-1',
        0,
        'node-x'
      );
      await databaseService.run(
        `INSERT INTO transactions (id, row_index, taxonomy_node_id) VALUES (?, ?, ?)`,
        'txn-2',
        1,
        'node-x'
      );

      // Log a bulk change
      const changeId = await logChange({
        source: 'pipeline',
        affectedTable: 'transactions',
        affectedIds: ['txn-1', 'txn-2'],
        affectedCount: 2,
        oldValues: { taxonomy_node_id: 'node-x' },
        newValues: { taxonomy_node_id: 'node-y' },
        description: 'Bulk reclassification',
      });

      // Apply the change
      await databaseService.run(
        `UPDATE transactions SET taxonomy_node_id = ? WHERE id IN ('txn-1', 'txn-2')`,
        'node-y'
      );

      // Revert
      await revertChange(changeId);

      // Both rows should be restored
      const txn1 = await databaseService.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
        'txn-1'
      );
      const txn2 = await databaseService.get<{ taxonomy_node_id: string }>(
        'SELECT taxonomy_node_id FROM transactions WHERE id = ?',
        'txn-2'
      );

      expect(txn1?.taxonomy_node_id).toBe('node-x');
      expect(txn2?.taxonomy_node_id).toBe('node-x');
    });

    it('should never delete existing changelog entries during revert', async () => {
      await databaseService.run(
        `INSERT INTO transactions (id, row_index, taxonomy_node_id) VALUES (?, ?, ?)`,
        'txn-1',
        0,
        'node-a'
      );

      const changeId = await logChange({
        source: 'manual',
        affectedTable: 'transactions',
        affectedIds: ['txn-1'],
        affectedCount: 1,
        oldValues: { taxonomy_node_id: 'node-a' },
        newValues: { taxonomy_node_id: 'node-b' },
        description: 'Change to revert',
      });

      await databaseService.run(
        `UPDATE transactions SET taxonomy_node_id = ? WHERE id = ?`,
        'node-b',
        'txn-1'
      );

      await revertChange(changeId);

      // The original entry should still exist
      const changes = await listChanges();
      expect(changes).toHaveLength(2);
      const originalEntry = changes.find((c) => c.id === changeId);
      expect(originalEntry).toBeDefined();
      expect(originalEntry?.description).toBe('Change to revert');
    });
  });
});
