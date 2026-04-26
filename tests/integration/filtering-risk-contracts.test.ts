import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { DuckDBDatabase } from '../../src/main/services/database';
import { TransactionStore } from '../../src/main/services/transactions';
import { SupplierService } from '../../src/main/services/supplier-service';
import { RuleStore, decomposeConditions } from '../../src/main/services/rules';
import type { FilterCondition, GroupedFilter } from '../../src/shared/types/transactions';
import {
  createMockChangelogStore,
  createMockProjectStore,
  createMockSupplierService,
  createMockSupplierUniverse,
  createMockTransactionStore,
} from '../helpers/mock-services';

const tempPath = () =>
  path.join(os.tmpdir(), `c91-filtering-contracts-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);

const gf = (
  connector: 'AND' | 'OR',
  conditions: Array<Omit<FilterCondition, 'connector'>>,
  groupConnector: 'AND' | 'OR' = 'AND',
): GroupedFilter => ({
  groupConnector,
  groups: [{ connector, conditions: conditions.map((c) => ({ ...c })) }],
});

describe('filtering and rule risk contracts', () => {
  let dbPath: string;
  let db: DuckDBDatabase;
  let transactions: TransactionStore;
  let suppliers: SupplierService;
  let rules: RuleStore;

  beforeEach(async () => {
    dbPath = tempPath();
    db = new DuckDBDatabase();
    await db.openDatabase(dbPath);
    await db.run('ALTER TABLE transactions ADD COLUMN spend_amount VARCHAR');

    transactions = new TransactionStore(db, createMockChangelogStore());
    suppliers = new SupplierService(db, createMockSupplierUniverse());
    rules = new RuleStore(
      db,
      createMockTransactionStore(),
      createMockProjectStore(),
      createMockSupplierService(),
    );

    await db.run(
      `INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, parent_path)
       VALUES ('tax-1', 'Indirect|IT|Software', 'Indirect', 'IT', 'Software', 3, 'Indirect|IT')`,
    );
  });

  afterEach(async () => {
    try { await db.closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '.wal']) {
      const fp = dbPath + suffix;
      if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  });

  async function seedTransactionVirtualFieldData() {
    await db.run(`INSERT INTO project_suppliers (id, supplier_name) VALUES ('sup-acme', 'Acme'), ('sup-beta', 'Beta')`);
    await db.run(
      `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, is_active)
       VALUES
       ('rule-a', 'Rule A', '{"groupConnector":"AND","groups":[]}', 'tax-1', TRUE),
       ('rule-b', 'Rule B', '{"groupConnector":"AND","groups":[]}', 'tax-1', TRUE)`,
    );
    await db.run(
      `INSERT INTO transactions
         (id, row_index, project_supplier_id, taxonomy_node_id, applied_rule_id, classification_status, spend_amount)
       VALUES
         ('tx-1', 1, 'sup-acme', 'tax-1', 'rule-a', 'classified_by_rule', '10'),
         ('tx-2', 2, 'sup-acme', 'tax-1', 'rule-b', 'classified_by_rule', '20'),
         ('tx-3', 3, 'sup-beta', 'tax-1', NULL, 'unclassified', '30')`,
    );
  }

  describe('transaction virtual-field joins', () => {
    const ruleNameFilter = {
      groupedConditions: gf('AND', [
        { field: 'applied_rule_name', operator: 'equals', value: 'Rule A' },
      ]),
    };

    it('pivot aggregation accepts applied_rule_name as a filter even when it is not a dimension', async () => {
      await seedTransactionVirtualFieldData();

      const result = await transactions.queryPivotAggregation(['supplier_name'], 'spend_amount', ruleNameFilter);

      expect(result.rows.map((r) => [r.dimensions[0], r.count])).toEqual([['Acme', 1]]);
    });

    it('getCount uses the same applied_rule_name filter semantics as queryTransactions', async () => {
      await seedTransactionVirtualFieldData();

      await expect(transactions.queryTransactions(ruleNameFilter)).resolves.toHaveLength(1);
      await expect(transactions.getCount(ruleNameFilter)).resolves.toBe(1);
    });

    it('queryGroupedByColumn applies applied_rule_name filters for unrelated dimensions', async () => {
      await seedTransactionVirtualFieldData();

      const result = await transactions.queryGroupedByColumn('supplier_name', ruleNameFilter);

      expect(result.rows.map((r) => [r.value, r.count])).toEqual([['Acme', 1]]);
    });

    it('getTransactionIdsByColumnValue combines column value filters with applied_rule_name filters', async () => {
      await seedTransactionVirtualFieldData();

      await expect(
        transactions.getTransactionIdsByColumnValue('supplier_name', 'Acme', ruleNameFilter),
      ).resolves.toEqual(['tx-1']);
    });
  });

  describe('supplier aggregate filter grouping', () => {
    it('preserves OR across regular supplier fields and aggregate fields', async () => {
      await db.run(`INSERT INTO project_suppliers (id, supplier_name) VALUES ('sup-alpha', 'Alpha Medical'), ('sup-beta', 'Beta Logistics'), ('sup-gamma', 'Gamma')`);
      await db.run(
        `INSERT INTO transactions (id, row_index, project_supplier_id, original_supplier_name, spend_amount)
         VALUES
           ('tx-alpha', 1, 'sup-alpha', 'ALPHA', '100'),
           ('tx-beta', 2, 'sup-beta', 'BETA', '2500'),
           ('tx-gamma', 3, 'sup-gamma', 'GAMMA', '50')`,
      );

      const result = await suppliers.listProjectSuppliers({
        groupedConditions: gf('OR', [
          { field: 'supplier_name', operator: 'contains', value: 'Alpha' },
          { field: 'total_spend', operator: 'greater_than', value: 1000 },
        ]),
      });

      expect(result.map((s) => s.supplierName).sort()).toEqual(['Alpha Medical', 'Beta Logistics']);
    });
  });

  describe('rule filter assignment semantics', () => {
    async function seedRuleGroups() {
      await db.run(`INSERT INTO rule_groups (id, name, priority) VALUES ('group-priority', 'Priority Rules', 10), ('group-target', 'Target Group', 20)`);
      await db.run(
        `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, group_id, is_active, source)
         VALUES
         ('rule-priority', 'Grouped Rule', '{"groupConnector":"AND","groups":[]}', 'tax-1', 'group-priority', TRUE, 'manual'),
         ('rule-name', 'foo by name', '{"groupConnector":"AND","groups":[]}', 'tax-1', NULL, TRUE, 'manual'),
         ('rule-content', 'content match', '{"groupConnector":"AND","groups":[{"connector":"AND","conditions":[{"field":"supplier_name","operator":"equals","value":"Acme"}]}]}', 'tax-1', NULL, TRUE, 'manual')`,
      );
      const contentFilter: GroupedFilter = gf('AND', [
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
      ]);
      for (const row of decomposeConditions('rule-content', contentFilter)) {
        await db.run(
          `INSERT INTO rule_conditions
             (rule_id, group_idx, condition_idx, field, operator, value, group_connector, condition_connector)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          row.rule_id, row.group_idx, row.condition_idx, row.field, row.operator, row.value,
          row.group_connector, row.condition_connector,
        );
      }
    }

    it('matches rule_group filters by displayed group name, not internal group id', async () => {
      await seedRuleGroups();

      const result = await rules.filterAndAssignToGroup(gf('AND', [
        { field: 'rule_group', operator: 'equals', value: 'Priority Rules' },
      ]), 'group-target');

      const row = await db.get<{ group_id: string }>(`SELECT group_id FROM override_rules WHERE id = 'rule-priority'`);
      expect(result.matched).toBe(1);
      expect(row?.group_id).toBe('group-target');
    });

    it('does not prefilter away content matches when a rule property is ORed with rule content', async () => {
      await seedRuleGroups();

      const result = await rules.filterAndAssignToGroup(gf('OR', [
        { field: 'rule_name', operator: 'contains', value: 'foo' },
        { field: 'supplier_name', operator: 'equals', value: 'Acme' },
      ]), 'group-target');

      const rows = await db.all<{ id: string; group_id: string | null }>(
        `SELECT id, group_id FROM override_rules WHERE id IN ('rule-name', 'rule-content') ORDER BY id`,
      );
      expect(result.matched).toBe(2);
      expect(rows).toEqual([
        { id: 'rule-content', group_id: 'group-target' },
        { id: 'rule-name', group_id: 'group-target' },
      ]);
    });
  });
});
