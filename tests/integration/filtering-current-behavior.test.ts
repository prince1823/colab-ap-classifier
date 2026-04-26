import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { DuckDBDatabase } from '../../src/main/services/database';
import { TransactionStore } from '../../src/main/services/transactions';
import { SupplierService } from '../../src/main/services/supplier-service';
import { RuleStore, decomposeConditions } from '../../src/main/services/rules';
import type { FilterCondition, GroupedFilter } from '../../src/shared/types/transactions';
import { conditionsToGroupedFilter } from '../../src/shared/filter-utils';
import {
  createMockChangelogStore,
  createMockProjectStore,
  createMockSupplierService,
  createMockSupplierUniverse,
  createMockTransactionStore,
} from '../helpers/mock-services';

const tempPath = () =>
  path.join(os.tmpdir(), `c91-current-filtering-${Date.now()}-${Math.random().toString(36).slice(2)}.c91`);

const group = (
  connector: 'AND' | 'OR',
  conditions: Array<Omit<FilterCondition, 'connector'>>,
  groupConnector?: 'AND' | 'OR',
) => ({ connector, conditions: conditions.map((c) => ({ ...c })), groupConnector });

const grouped = (groups: ReturnType<typeof group>[], groupConnector: 'AND' | 'OR' = 'AND'): GroupedFilter => ({
  groupConnector,
  groups,
});

describe('current filtering behavior characterization', () => {
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
    await db.run('ALTER TABLE transactions ADD COLUMN company VARCHAR');
    await db.run('ALTER TABLE transactions ADD COLUMN gl_description VARCHAR');

    transactions = new TransactionStore(db, createMockChangelogStore());
    suppliers = new SupplierService(db, createMockSupplierUniverse());
    rules = new RuleStore(
      db,
      createMockTransactionStore(),
      createMockProjectStore(),
      createMockSupplierService(),
    );

    await seedProject();
  });

  afterEach(async () => {
    try { await db.closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '.wal']) {
      const fp = dbPath + suffix;
      if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  });

  async function seedProject() {
    await db.run(
      `INSERT INTO supplier_parents (id, name)
       VALUES ('parent-medical', 'Medical Parent'), ('parent-logistics', 'Logistics Parent')`,
    );
    await db.run(
      `INSERT INTO project_suppliers
         (id, supplier_name, confirmation_status, is_tail_spend, is_researched, parent_supplier_id)
       VALUES
         ('sup-acme', 'Acme', 'confirmed', FALSE, TRUE, 'parent-medical'),
         ('sup-beta', 'Beta', 'pending', FALSE, FALSE, 'parent-logistics'),
         ('sup-gamma', 'Gamma', 'confirmed', TRUE, FALSE, NULL)`,
    );
    await db.run(
      `INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, parent_path)
       VALUES
         ('tax-it', 'Indirect|IT|Software', 'Indirect', 'IT', 'Software', 3, 'Indirect|IT'),
         ('tax-fac', 'Indirect|Facilities|Cleaning', 'Indirect', 'Facilities', 'Cleaning', 3, 'Indirect|Facilities')`,
    );
    await db.run(
      `INSERT INTO uploads (id, file_name, file_path, column_mappings, row_count, status, created_at)
       VALUES
         ('upload-jan', 'jan.csv', '/tmp/jan.csv', '{}', 2, 'completed', TIMESTAMP '2026-01-01 10:00:00'),
         ('upload-feb', 'feb.csv', '/tmp/feb.csv', '{}', 2, 'completed', TIMESTAMP '2026-02-01 10:00:00')`,
    );
    await db.run(
      `INSERT INTO transactions
         (id, row_index, upload_id, project_supplier_id, taxonomy_node_id, classification_status,
          flagged_for_review, human_reviewed, original_supplier_name, spend_amount, company, gl_description)
       VALUES
         ('tx-1', 1, 'upload-jan', 'sup-acme', 'tax-it',  'unclassified',     TRUE,  FALSE, 'ACME INC',  '100',  'US', 'software license'),
         ('tx-2', 2, 'upload-feb', 'sup-acme', 'tax-fac', 'classified_by_ai', FALSE, TRUE,  'ACME LLC',  '2000', 'EU', 'office cleaning'),
         ('tx-3', 3, 'upload-jan', 'sup-beta', 'tax-it',  'unclassified',     TRUE,  FALSE, 'BETA LTD',  '500',  'US', 'security software'),
         ('tx-4', 4, 'upload-feb', 'sup-gamma', NULL,     'unclassified',     FALSE, FALSE, 'GAMMA CO',  '50',   'US', 'misc')`,
    );
  }

  function ids(rows: Array<{ id: string }>) {
    return rows.map((r) => r.id).sort();
  }

  describe('transaction filters that currently work', () => {
    it('single-group conditions support scalar, boolean, and numeric operators together', async () => {
      const rows = await transactions.queryTransactions({
        groupedConditions: conditionsToGroupedFilter([
          { field: 'company', operator: 'equals', value: 'US', connector: 'AND' },
          { field: 'flagged_for_review', operator: 'is_true', value: '', connector: 'AND' },
          { field: 'spend_amount', operator: 'greater_than_or_equal', value: 100 },
        ]),
      });

      expect(ids(rows)).toEqual(['tx-1', 'tx-3']);
    });

    it('equivalent single-group query and direct grouped-id lookup resolve the same transaction ids', async () => {
      const queryRows = await transactions.queryTransactions({
        groupedConditions: conditionsToGroupedFilter([
          { field: 'company', operator: 'equals', value: 'US', connector: 'AND' },
          { field: 'flagged_for_review', operator: 'is_true', value: '' },
        ]),
      });
      const groupedIds = await transactions.getIdsByGroupedConditions(grouped([
        group('AND', [
          { field: 'company', operator: 'equals', value: 'US' },
          { field: 'flagged_for_review', operator: 'is_true', value: '' },
        ]),
      ]));

      expect(groupedIds.sort()).toEqual(ids(queryRows));
    });

    it('grouped OR filters combine virtual supplier fields with taxonomy filters', async () => {
      const result = await transactions.getIdsByGroupedConditions(grouped([
        group('OR', [
          { field: 'supplier_name', operator: 'equals', value: 'Acme' },
          { field: 'supplier_name', operator: 'equals', value: 'Beta' },
        ]),
        group('AND', [
          { field: 'classification_l2', operator: 'equals', value: 'IT' },
        ], 'AND'),
      ]));

      expect(result.sort()).toEqual(['tx-1', 'tx-3']);
    });

    it('source_file virtual filters match uploaded file labels', async () => {
      const rows = await transactions.queryTransactions({
        groupedConditions: grouped([
          group('AND', [
            { field: 'source_file', operator: 'equals', value: 'jan.csv (2026-01-01 10:00)' },
          ]),
        ]),
      });

      expect(ids(rows)).toEqual(['tx-1', 'tx-3']);
    });

    it('flagged-only flat filtering is honored by pivot aggregation', async () => {
      const result = await transactions.queryPivotAggregation(['supplier_name'], 'spend_amount', {
        groupedConditions: conditionsToGroupedFilter([{ field: 'flagged_for_review', operator: 'is_true', value: '' }]),
      });

      expect(result.rows.map((r) => [r.dimensions[0], r.count]).sort()).toEqual([
        ['Acme', 1],
        ['Beta', 1],
      ]);
    });
  });

  describe('supplier filters that currently work', () => {
    it('pure regular grouped OR supplier filters preserve OR semantics', async () => {
      const result = await suppliers.listProjectSuppliers({
        groupedConditions: grouped([
          group('OR', [
            { field: 'supplier_name', operator: 'equals', value: 'Acme' },
            { field: 'parent_name', operator: 'equals', value: 'Logistics Parent' },
          ]),
        ]),
      });

      expect(result.map((s) => s.supplierName).sort()).toEqual(['Acme', 'Beta']);
    });

    it('pure aggregate supplier filters apply after aggregation', async () => {
      const result = await suppliers.listProjectSuppliers({
        groupedConditions: grouped([
          group('AND', [
            { field: 'total_spend', operator: 'greater_than', value: 1000 },
          ]),
        ]),
      });

      expect(result.map((s) => s.supplierName)).toEqual(['Acme']);
    });

    it('mixed regular and aggregate supplier filters preserve AND semantics', async () => {
      const result = await suppliers.listProjectSuppliers({
        groupedConditions: grouped([
          group('AND', [
            { field: 'confirmation_status', operator: 'equals', value: 'confirmed' },
            { field: 'total_spend', operator: 'greater_than', value: 1000 },
          ]),
        ]),
      });

      expect(result.map((s) => s.supplierName)).toEqual(['Acme']);
    });
  });

  describe('rule filter assignment behavior that currently works', () => {
    async function seedRules() {
      await db.run(`INSERT INTO rule_groups (id, name, priority) VALUES ('target-group', 'Target Group', 50)`);
      const acmeFilter = grouped([
        group('AND', [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }]),
      ]);
      const betaFilter = grouped([
        group('AND', [{ field: 'supplier_name', operator: 'equals', value: 'Beta' }]),
      ]);
      await db.run(
        `INSERT INTO override_rules
           (id, name, grouped_conditions, target_taxonomy_node_id, is_active, source)
         VALUES
           ('rule-acme', 'Acme content rule', ?, 'tax-it', TRUE, 'manual'),
           ('rule-beta', 'Beta content rule', ?, 'tax-it', TRUE, 'manual')`,
        JSON.stringify(acmeFilter),
        JSON.stringify(betaFilter),
      );
      for (const row of [
        ...decomposeConditions('rule-acme', acmeFilter),
        ...decomposeConditions('rule-beta', betaFilter),
      ]) {
        await db.run(
          `INSERT INTO rule_conditions
             (rule_id, group_idx, condition_idx, field, operator, value, group_connector, condition_connector)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          row.rule_id, row.group_idx, row.condition_idx, row.field, row.operator, row.value,
          row.group_connector, row.condition_connector,
        );
      }
    }

    it('content-only filters assign matching rules to a group', async () => {
      await seedRules();

      const result = await rules.filterAndAssignToGroup(grouped([
        group('AND', [{ field: 'supplier_name', operator: 'equals', value: 'Acme' }]),
      ]), 'target-group');

      const rows = await db.all<{ id: string; group_id: string | null }>(
        `SELECT id, group_id FROM override_rules ORDER BY id`,
      );
      expect(result.matched).toBe(1);
      expect(rows).toEqual([
        { id: 'rule-acme', group_id: 'target-group' },
        { id: 'rule-beta', group_id: null },
      ]);
    });
  });
});
