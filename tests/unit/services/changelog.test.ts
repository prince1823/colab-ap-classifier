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

      // revertChange toggles is_reverted on the existing entry (no new row)
      const changes = await store.listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].isReverted).toBe(true);
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

  describe('filterContext', () => {
    it('should store and retrieve filter context as FilterCondition[]', async () => {
      const filterContext = [
        { field: 'supplier_name', operator: 'equals' as const, value: 'Acme Corp' },
        { field: 'classification_l1', operator: 'equals' as const, value: 'Services' },
        { field: 'gl_description', operator: 'in_list' as const, value: ['Office', 'Supplies'] },
      ];
      const id = await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'With filters',
        filterContext,
      });

      const changes = await store.listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].filterContext).toEqual(filterContext);
    });

    it('should handle null filter context', async () => {
      await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: null, newValues: null, description: 'No filters',
      });

      const changes = await store.listChanges();
      expect(changes[0].filterContext).toBeNull();
    });
  });

  describe('ruleId', () => {
    it('should store and retrieve rule ID', async () => {
      const id = await store.logChange({
        source: 'rule', affectedTable: 'transactions', affectedIds: ['txn-1', 'txn-2'],
        affectedCount: 2, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'Rule applied',
        ruleId: 'rule-123',
      });

      const changes = await store.listChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].ruleId).toBe('rule-123');
    });

    it('should handle null rule ID', async () => {
      await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: null, newValues: null, description: 'Manual change',
      });

      const changes = await store.listChanges();
      expect(changes[0].ruleId).toBeNull();
    });
  });

  describe('listByRuleId', () => {
    it('should return only entries for the specified rule', async () => {
      await store.logChange({
        source: 'rule', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'Rule 1',
        ruleId: 'rule-1',
      });
      await store.logChange({
        source: 'rule', affectedTable: 'transactions', affectedIds: ['txn-2'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'Rule 2',
        ruleId: 'rule-2',
      });

      // Create transactions so listByRuleId can check ownership
      await db.run(`INSERT INTO transactions (id, row_index, applied_rule_id) VALUES (?, ?, ?)`, 'txn-1', 0, 'rule-1');
      await db.run(`INSERT INTO transactions (id, row_index, applied_rule_id) VALUES (?, ?, ?)`, 'txn-2', 1, 'rule-2');

      const result = await store.listByRuleId('rule-1');
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe('Rule 1');
      expect(result[0].ruleId).toBe('rule-1');
    });

    it('should filter out transactions no longer owned by the rule', async () => {
      // Rule 1 originally classified txn-1 and txn-2
      await store.logChange({
        source: 'rule', affectedTable: 'transactions', affectedIds: ['txn-1', 'txn-2'],
        affectedCount: 2, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'Rule 1 applied',
        ruleId: 'rule-1',
      });

      // txn-1 still owned by rule-1, but txn-2 was reclassified by rule-2
      await db.run(`INSERT INTO transactions (id, row_index, applied_rule_id) VALUES (?, ?, ?)`, 'txn-1', 0, 'rule-1');
      await db.run(`INSERT INTO transactions (id, row_index, applied_rule_id) VALUES (?, ?, ?)`, 'txn-2', 1, 'rule-2');

      const result = await store.listByRuleId('rule-1');
      expect(result).toHaveLength(1);
      expect(result[0].affectedIds).toEqual(['txn-1']); // Only txn-1 still owned
      expect(result[0].affectedCount).toBe(1);
    });

    it('should exclude entries where all transactions were reclassified by other rules', async () => {
      await store.logChange({
        source: 'rule', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'Rule 1',
        ruleId: 'rule-1',
      });

      // txn-1 reclassified by rule-2
      await db.run(`INSERT INTO transactions (id, row_index, applied_rule_id) VALUES (?, ?, ?)`, 'txn-1', 0, 'rule-2');

      const result = await store.listByRuleId('rule-1');
      expect(result).toHaveLength(0); // No entries — all txns reclassified
    });

    it('should include already-reverted entries as-is', async () => {
      await db.run(`INSERT INTO transactions (id, row_index, taxonomy_node_id, applied_rule_id) VALUES (?, ?, ?, ?)`, 'txn-1', 0, 'new', 'rule-1');

      const changeId = await store.logChange({
        source: 'rule', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: { taxonomy_node_id: 'old' },
        newValues: { taxonomy_node_id: 'new' }, description: 'Rule 1',
        ruleId: 'rule-1',
      });

      // Revert the change
      await store.revertChange(changeId);

      const result = await store.listByRuleId('rule-1');
      expect(result).toHaveLength(1);
      expect(result[0].isReverted).toBe(true);
    });
  });

  describe('server-side search', () => {
    it('should filter by search term in description', async () => {
      await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: null, newValues: null,
        description: 'Reclassified Acme Corp transactions',
      });
      await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-2'],
        affectedCount: 1, oldValues: null, newValues: null,
        description: 'Updated Widget Inc supplier',
      });

      const results = await store.listChanges({ search: 'Acme' });
      expect(results).toHaveLength(1);
      expect(results[0].description).toContain('Acme');
    });

    it('should filter by search term in source', async () => {
      await store.logChange({
        source: 'pipeline', affectedTable: 'transactions', affectedIds: ['txn-1'],
        affectedCount: 1, oldValues: null, newValues: null, description: 'Batch run',
      });
      await store.logChange({
        source: 'manual', affectedTable: 'transactions', affectedIds: ['txn-2'],
        affectedCount: 1, oldValues: null, newValues: null, description: 'Manual change',
      });

      const results = await store.listChanges({ search: 'pipeline' });
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('pipeline');
    });

    it('should return correct paginated count with search', async () => {
      for (let i = 0; i < 5; i++) {
        await store.logChange({
          source: 'manual', affectedTable: 'transactions', affectedIds: [`txn-${i}`],
          affectedCount: 1, oldValues: null, newValues: null,
          description: i < 3 ? 'Target match' : 'Other change',
        });
      }

      const result = await store.listChangesPaginated({ search: 'Target', pageSize: 10 });
      expect(result.totalCount).toBe(3);
      expect(result.rows).toHaveLength(3);
    });
  });
});
