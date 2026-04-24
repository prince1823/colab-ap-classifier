/**
 * Behavioral parity: GroupedFilter → WHERE clause (transaction filter UI,
 * export, supplier filter) vs GroupedFilter → rule evaluation
 * (evaluateRulesBulk, which powers rule preview + classification).
 *
 * Both consume the same GroupedFilter shape. They MUST return the same set
 * of transaction IDs for any GroupedFilter, or rules silently classify
 * different rows than the filter preview shows.
 *
 * The test runs each scenario against a real DuckDB instance:
 *   expected = rows matching buildGroupedWhereClause(filter)
 *   actual   = rows matching a rule whose grouped_conditions == filter,
 *              as evaluated by evaluateRulesBulk
 * and asserts equality. Divergences are collected into a summary printed
 * in afterAll so the failure table is readable as a whole.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

import { DuckDBDatabase } from '../../src/main/services/database';
import { RuleStore, decomposeConditions } from '../../src/main/services/rules';
import { buildGroupedWhereClause } from '../../src/main/utils/query-builder';
import type { FilterCondition, ConditionGroup, GroupedFilter } from '../../src/shared/types/transactions';
import {
  createMockTransactionStore,
  createMockProjectStore,
  createMockSupplierService,
} from '../helpers/mock-services';

// ── Test data ─────────────────────────────────────────────────────────────
// 9 transactions across two native columns. Kept small so expected sets can
// be read by eye; varied enough to distinguish AND from OR semantics.
type Seed = { id: string; sup: string | null; status: string };
const SEED: Seed[] = [
  { id: 'tx1', sup: 'Acme',  status: 'unclassified' },
  { id: 'tx2', sup: 'Acme',  status: 'classified_by_ai' },
  { id: 'tx3', sup: 'Beta',  status: 'unclassified' },
  { id: 'tx4', sup: 'Beta',  status: 'classified_by_ai' },
  { id: 'tx5', sup: 'Gamma', status: 'unclassified' },
  { id: 'tx6', sup: 'Gamma', status: 'classified_by_ai' },
  { id: 'tx7', sup: 'Delta', status: 'unclassified' },
  { id: 'tx8', sup: 'Delta', status: 'classified_by_qc_agent' },
  { id: 'tx9', sup: null,    status: 'unclassified' },
];

const SUP = 'original_supplier_name';
const ST  = 'classification_status';

// ── Builders ──────────────────────────────────────────────────────────────
const eq = (field: string, value: string, connector: 'AND' | 'OR' = 'AND'): FilterCondition =>
  ({ field, operator: 'equals', value, connector });
const ne = (field: string, value: string, connector: 'AND' | 'OR' = 'AND'): FilterCondition =>
  ({ field, operator: 'not_equals', value, connector });
const grp = (
  connector: 'AND' | 'OR',
  conditions: FilterCondition[],
  groupConnector?: 'AND' | 'OR',
): ConditionGroup => ({ connector, conditions, groupConnector });
const filt = (groupConnector: 'AND' | 'OR', groups: ConditionGroup[]): GroupedFilter =>
  ({ groupConnector, groups });

type Scenario = {
  name: string;
  filter: GroupedFilter;
  /** Human-readable expectation. Not evaluated; a note for the reader. */
  note?: string;
};

// ── Scenario matrix ───────────────────────────────────────────────────────
// Ordered from simple → complex so the first failure points at the narrowest
// bug. Each scenario's expected set is computed at runtime from
// buildGroupedWhereClause, not hard-coded, so the test stays correct if the
// seed changes.
const SCENARIOS: Scenario[] = [
  // ── Group A: sanity — single condition, homogeneous AND
  { name: 'A1 single equals',
    filter: filt('AND', [grp('AND', [eq(SUP, 'Acme')])]) },
  { name: 'A2 single not_equals',
    filter: filt('AND', [grp('AND', [ne(SUP, 'Acme')])]) },
  { name: 'A3 one AND group, 2 conditions',
    filter: filt('AND', [grp('AND', [eq(SUP, 'Acme'), eq(ST, 'unclassified')])]) },
  { name: 'A4 one AND group, 3 conditions',
    filter: filt('AND', [grp('AND', [eq(SUP, 'Acme'), eq(ST, 'unclassified'), ne(SUP, 'Beta')])]) },

  // ── Group B: within-group OR (the case the PR fixes)
  { name: 'B1 one OR group, 2 conditions (disjoint matches)',
    filter: filt('AND', [grp('OR', [eq(SUP, 'Acme', 'OR'), eq(SUP, 'Beta', 'OR')])]) },
  { name: 'B2 one OR group, 2 conditions (only one ever matches)',
    filter: filt('AND', [grp('OR', [eq(SUP, 'Zeta', 'OR'), eq(SUP, 'Acme', 'OR')])]) },
  { name: 'B3 one OR group, 2 conditions (neither matches)',
    filter: filt('AND', [grp('OR', [eq(SUP, 'Zeta', 'OR'), eq(SUP, 'Omega', 'OR')])]) },
  { name: 'B4 one OR group, 3 conditions',
    filter: filt('AND', [grp('OR', [eq(SUP, 'Acme', 'OR'), eq(SUP, 'Beta', 'OR'), eq(SUP, 'Gamma', 'OR')])]) },
  { name: 'B5 one OR group, conditions across two fields',
    filter: filt('AND', [grp('OR', [eq(SUP, 'Acme', 'OR'), eq(ST, 'classified_by_qc_agent', 'OR')])]) },

  // ── Group C: between-group homogeneous AND
  { name: 'C1 two AND-AND groups',
    filter: filt('AND', [
      grp('AND', [eq(SUP, 'Acme')]),
      grp('AND', [eq(ST, 'unclassified')], 'AND'),
    ]) },
  { name: 'C2 three AND-AND groups',
    filter: filt('AND', [
      grp('AND', [eq(SUP, 'Acme')]),
      grp('AND', [eq(ST, 'unclassified')], 'AND'),
      grp('AND', [ne(SUP, 'Beta')], 'AND'),
    ]) },

  // ── Group D: between-group homogeneous OR
  { name: 'D1 two groups OR-joined',
    filter: filt('OR', [
      grp('AND', [eq(SUP, 'Acme')]),
      grp('AND', [eq(ST, 'classified_by_ai')], 'OR'),
    ]) },
  { name: 'D2 three groups OR-joined',
    filter: filt('OR', [
      grp('AND', [eq(SUP, 'Acme')]),
      grp('AND', [eq(SUP, 'Beta')], 'OR'),
      grp('AND', [eq(SUP, 'Gamma')], 'OR'),
    ]) },

  // ── Group E: between-group MIXED AND/OR — SQL precedence (AND binds
  //    tighter than OR) vs rule eval's "any OR anywhere → any_group_matched"
  { name: 'E1 three groups: G1 AND G2 OR G3 — only G2 matches',
    filter: filt('AND', [
      grp('AND', [eq(SUP, 'Zeta')]),                    // G1: never matches
      grp('AND', [eq(ST, 'unclassified')], 'AND'),      // G2: tx1,3,5,7,9
      grp('AND', [eq(SUP, 'Omega')], 'OR'),             // G3: never matches
    ]),
    note: 'filter: (G1 AND G2) OR G3 = {} ∪ {} = {}; rule eval has an OR → any_group_matched = G2 rows' },
  { name: 'E2 three groups: G1 AND G2 OR G3 — G1∩G2 matches some; G3 matches others',
    filter: filt('AND', [
      grp('AND', [eq(SUP, 'Acme')]),                    // G1: tx1,2
      grp('AND', [eq(ST, 'unclassified')], 'AND'),      // G2: tx1,3,5,7,9
      grp('AND', [eq(SUP, 'Gamma')], 'OR'),             // G3: tx5,6
    ]),
    note: 'filter: (Acme AND unclassified) OR Gamma = {tx1} ∪ {tx5,tx6} = {tx1,tx5,tx6}' },
  { name: 'E3 three groups: G1 OR G2 AND G3',
    filter: filt('AND', [
      grp('AND', [eq(SUP, 'Zeta')]),                    // G1: never matches
      grp('AND', [eq(SUP, 'Acme')], 'OR'),              // G2: tx1,2
      grp('AND', [eq(ST, 'unclassified')], 'AND'),      // G3: tx1,3,5,7,9
    ]),
    note: 'filter: G1 OR (G2 AND G3) = {} ∪ {tx1} = {tx1}' },
  { name: 'E4 four groups: G1 AND G2 OR G3 AND G4',
    filter: filt('AND', [
      grp('AND', [eq(SUP, 'Acme')]),                    // G1: tx1,2
      grp('AND', [eq(ST, 'unclassified')], 'AND'),      // G2: tx1,3,5,7,9
      grp('AND', [eq(SUP, 'Gamma')], 'OR'),             // G3: tx5,6
      grp('AND', [eq(ST, 'classified_by_ai')], 'AND'),  // G4: tx2,4,6
    ]),
    note: 'filter: (G1 AND G2) OR (G3 AND G4) = {tx1} ∪ {tx6} = {tx1,tx6}' },

  // ── Group F: within-group MIXED condition-level connectors
  //    decomposeConditions faithfully stores per-condition connectors, but
  //    the PR's fix uses BOOL_OR(condition_connector='OR') — any OR → whole
  //    group is OR. buildGroupedWhereClause emits literal SQL and leans on
  //    SQL precedence.
  { name: 'F1 one group, mixed condition connectors: A AND B OR C',
    filter: filt('AND', [grp('AND', [
      eq(SUP, 'Acme', 'AND'),              // A
      eq(SUP, 'Beta', 'OR'),               // B  — connector to C is OR
      eq(ST, 'unclassified'),              // C
    ])]),
    note: 'filter: (Acme AND Beta) OR unclassified = {} ∪ {tx1,3,5,7,9}; rule: any condition matches → {tx1,2,3,5,7,9}' },
];

// ── Harness ───────────────────────────────────────────────────────────────
let dbPath: string;
let db: DuckDBDatabase;
let rules: RuleStore;

const tempPath = (suffix: string) =>
  path.join(os.tmpdir(), `c91-parity-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);

beforeAll(async () => {
  dbPath = tempPath('.c91');
  db = new DuckDBDatabase();
  await db.openDatabase(dbPath);

  // Minimal taxonomy node so rules have a valid target.
  const taxId = crypto.randomUUID();
  await db.run(
    `INSERT INTO taxonomy (id, full_path, l1, l2, l3, depth, parent_path)
     VALUES (?, 'L1|L2|Leaf', 'L1', 'L2', 'Leaf', 3, 'L1|L2')`,
    taxId,
  );
  (globalThis as unknown as { __parityTaxId: string }).__parityTaxId = taxId;

  // Seed transactions.
  for (const r of SEED) {
    await db.run(
      `INSERT INTO transactions (id, row_index, original_supplier_name, classification_status)
       VALUES (?, ?, ?, ?)`,
      r.id, parseInt(r.id.slice(2)), r.sup, r.status,
    );
  }

  rules = new RuleStore(
    db,
    createMockTransactionStore(),
    createMockProjectStore(),
    createMockSupplierService(),
  );
});

afterAll(async () => {
  try { await db.closeDatabase(); } catch { /* */ }
  for (const suffix of ['', '.wal']) {
    const fp = dbPath + suffix;
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch { /* */ }
  }
});

// Native-column resolver — matches what TransactionStore.buildFilterSQL uses
// for non-virtual fields.
const nativeResolver = (field: string) => `t."${field}"`;

/** Run buildGroupedWhereClause against the transactions table → matched IDs. */
async function matchesViaFilter(filter: GroupedFilter): Promise<Set<string>> {
  const built = buildGroupedWhereClause(filter, nativeResolver);
  const sql = built
    ? `SELECT t.id FROM transactions t WHERE ${built.sql} ORDER BY t.id`
    : `SELECT t.id FROM transactions t ORDER BY t.id`;
  const rows = await db.all<{ id: string }>(sql, ...(built?.params ?? []));
  return new Set(rows.map(r => r.id));
}

/** Insert a rule with this filter, run evaluateRulesBulk, return matched IDs. */
async function matchesViaRule(filter: GroupedFilter): Promise<Set<string>> {
  const ruleId = crypto.randomUUID();
  const taxId = (globalThis as unknown as { __parityTaxId: string }).__parityTaxId;

  // Fresh state — evaluateRulesBulk considers every active rule if ruleIds
  // is omitted; we pass ruleIds to scope to just this rule, but we also
  // wipe to keep the rule_conditions table clean across scenarios.
  await db.run('DELETE FROM rule_conditions');
  await db.run('DELETE FROM override_rules');

  await db.run(
    `INSERT INTO override_rules (id, name, grouped_conditions, target_taxonomy_node_id, is_active)
     VALUES (?, ?, ?, ?, TRUE)`,
    ruleId, 'parity-test', JSON.stringify(filter), taxId,
  );

  const rows = decomposeConditions(ruleId, filter);
  for (const r of rows) {
    await db.run(
      `INSERT INTO rule_conditions
         (rule_id, group_idx, condition_idx, field, operator, value, group_connector, condition_connector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r.rule_id, r.group_idx, r.condition_idx, r.field, r.operator, r.value,
      r.group_connector, r.condition_connector,
    );
  }

  const matched = await rules.evaluateRulesBulk({ ruleIds: [ruleId] });
  return new Set(matched.keys());
}

type Result = { name: string; expected: string[]; actual: string[]; pass: boolean; note?: string };
const results: Result[] = [];

describe('GroupedFilter parity — filter WHERE clause vs rule evaluation', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const expected = await matchesViaFilter(sc.filter);
      const actual = await matchesViaRule(sc.filter);

      const expArr = [...expected].sort();
      const actArr = [...actual].sort();
      const pass = expArr.length === actArr.length &&
                   expArr.every((v, i) => v === actArr[i]);
      results.push({ name: sc.name, expected: expArr, actual: actArr, pass, note: sc.note });

      expect(actArr).toEqual(expArr);
    });
  }

  afterAll(() => {
    const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
    const lines: string[] = [];
    lines.push('');
    lines.push('── Parity summary ─────────────────────────────────────────────────');
    lines.push(`${pad('Scenario', 60)} ${pad('Pass', 6)} Expected → Actual`);
    for (const r of results) {
      const verdict = r.pass ? 'OK' : 'FAIL';
      const exp = '[' + r.expected.join(',') + ']';
      const act = '[' + r.actual.join(',') + ']';
      lines.push(`${pad(r.name, 60)} ${pad(verdict, 6)} ${exp} → ${act}`);
      if (!r.pass && r.note) lines.push(`    note: ${r.note}`);
    }
    const failed = results.filter(r => !r.pass).length;
    lines.push(`── ${failed} / ${results.length} scenarios diverged ──`);
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  });
});
