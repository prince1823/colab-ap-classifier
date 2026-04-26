import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

vi.mock('electron', () => {
  const _win = { webContents: { send: () => {} } };
  const BW = Object.assign(vi.fn(() => _win), {
    getFocusedWindow: vi.fn(() => _win),
    getAllWindows: vi.fn(() => [_win]),
  });
  return {
    dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: BW,
  };
});

import { DuckDBDatabase } from '../../src/main/services/database';
import { RuleStore } from '../../src/main/services/rules';
import {
  createMockProjectStore,
  createMockSupplierService,
  createMockTransactionStore,
} from '../helpers/mock-services';
import type { GroupedFilter } from '../../src/shared/types/transactions';

function tempPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `rules-bulk-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}

describe('RuleStore.evaluateRulesBulk integration', () => {
  let dbPath: string;
  let db: DuckDBDatabase;
  let rules: RuleStore;
  let targetTaxonomyNodeId: string;

  beforeEach(async () => {
    dbPath = tempPath('.c91');
    db = new DuckDBDatabase();
    await db.openDatabase(dbPath);
    await db.run('ALTER TABLE transactions ADD COLUMN line_description VARCHAR');

    targetTaxonomyNodeId = crypto.randomUUID();
    await db.run(
      `INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, parent_path)
       VALUES (?, 'Indirect|IT|Software', 'Indirect', 'IT', 'Software', 3, 'Indirect|IT')`,
      targetTaxonomyNodeId
    );

    await db.run(
      `INSERT INTO transactions (id, row_index, original_supplier_name, line_description, classification_status)
       VALUES
         ('tx-supplier', 1, 'Acme Services', 'routine maintenance', 'unclassified'),
         ('tx-line', 2, 'Beta LLC', 'urgent software license', 'unclassified'),
         ('tx-both', 3, 'Acme Services', 'urgent software license', 'unclassified'),
         ('tx-none', 4, 'Beta LLC', 'routine maintenance', 'unclassified')`
    );

    rules = new RuleStore(
      db,
      createMockTransactionStore(),
      createMockProjectStore(),
      createMockSupplierService()
    );
  });

  afterEach(async () => {
    await db.closeDatabase();
    for (const suffix of ['', '.wal']) {
      const filePath = dbPath + suffix;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });

  async function insertRule(name: string, groupedConditions: GroupedFilter): Promise<string> {
    const ruleId = crypto.randomUUID();
    await db.run(
      `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, is_active)
       VALUES (?, ?, ?, ?, TRUE)`,
      ruleId,
      name,
      JSON.stringify(groupedConditions),
      targetTaxonomyNodeId
    );

    for (let gi = 0; gi < groupedConditions.groups.length; gi++) {
      const group = groupedConditions.groups[gi];
      for (let ci = 0; ci < group.conditions.length; ci++) {
        const condition = group.conditions[ci];
        await db.run(
          `INSERT INTO rule_conditions
             (rule_id, group_idx, condition_idx, field, operator, value, group_connector, condition_connector)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ruleId,
          gi,
          ci,
          condition.field,
          condition.operator,
          condition.value == null ? null : String(condition.value),
          group.groupConnector ?? groupedConditions.groupConnector,
          condition.connector ?? group.connector
        );
      }
    }

    return ruleId;
  }

  it('respects OR stored on the previous condition even when the group connector is AND', async () => {
    const ruleId = await insertRule('supplier-or-line', {
      groupConnector: 'AND',
      groups: [{
        connector: 'AND',
        conditions: [
          { field: 'original_supplier_name', operator: 'contains', value: 'Acme', connector: 'OR' },
          { field: 'line_description', operator: 'contains', value: 'urgent' },
        ],
      }],
    });

    const result = await rules.evaluateRulesBulk({ ruleIds: [ruleId] });

    expect([...result.keys()].sort()).toEqual(['tx-both', 'tx-line', 'tx-supplier']);
    expect(result.has('tx-none')).toBe(false);
  });

  it('matches in_list conditions in the bulk evaluator', async () => {
    const ruleId = await insertRule('supplier-in-list', {
      groupConnector: 'AND',
      groups: [{
        connector: 'AND',
        conditions: [
          { field: 'original_supplier_name', operator: 'in_list', value: 'Acme Services, Beta LLC' },
        ],
      }],
    });

    const result = await rules.evaluateRulesBulk({ ruleIds: [ruleId] });

    expect([...result.keys()].sort()).toEqual(['tx-both', 'tx-line', 'tx-none', 'tx-supplier']);
  });

  it('requires every group connected by AND to match the same transaction', async () => {
    const ruleId = await insertRule('supplier-and-line-groups', {
      groupConnector: 'AND',
      groups: [
        {
          connector: 'AND',
          conditions: [
            { field: 'original_supplier_name', operator: 'contains', value: 'Acme' },
          ],
        },
        {
          connector: 'AND',
          groupConnector: 'AND',
          conditions: [
            { field: 'line_description', operator: 'contains', value: 'urgent' },
          ],
        },
      ],
    });

    const result = await rules.evaluateRulesBulk({ ruleIds: [ruleId] });

    expect([...result.keys()]).toEqual(['tx-both']);
  });
});
