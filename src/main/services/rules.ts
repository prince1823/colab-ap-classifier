import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { buildWhereClause } from './transactions';
import type {
  OverrideRule,
  OverrideRuleCreate,
  OverrideRuleUpdate,
  FilterCondition,
} from '../../shared/types';

interface RuleRow {
  id: string;
  name: string;
  conditions: string;
  target_taxonomy_node_id: string;
  priority_score: number;
  is_active: boolean;
  created_at: string;
}

function rowToRule(row: RuleRow): OverrideRule {
  return {
    id: row.id,
    name: row.name,
    conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions) : row.conditions,
    targetTaxonomyNodeId: row.target_taxonomy_node_id,
    priorityScore: row.priority_score,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listRules(): Promise<OverrideRule[]> {
  const rows = await databaseService.all<RuleRow>(
    'SELECT * FROM override_rules ORDER BY priority_score ASC'
  );
  return rows.map(rowToRule);
}

export async function createRule(input: OverrideRuleCreate): Promise<{ id: string }> {
  const id = uuidv4();

  let priorityScore = input.priorityScore;
  if (priorityScore === undefined) {
    priorityScore = await getNextPriority();
  }

  await databaseService.run(
    `INSERT INTO override_rules (id, name, conditions, target_taxonomy_node_id, priority_score, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
    id,
    input.name,
    JSON.stringify(input.conditions),
    input.targetTaxonomyNodeId,
    priorityScore
  );

  return { id };
}

export async function updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    params.push(updates.name);
  }
  if (updates.conditions !== undefined) {
    setClauses.push('conditions = ?');
    params.push(JSON.stringify(updates.conditions));
  }
  if (updates.targetTaxonomyNodeId !== undefined) {
    setClauses.push('target_taxonomy_node_id = ?');
    params.push(updates.targetTaxonomyNodeId);
  }
  if (updates.priorityScore !== undefined) {
    setClauses.push('priority_score = ?');
    params.push(updates.priorityScore);
  }
  if (updates.isActive !== undefined) {
    setClauses.push('is_active = ?');
    params.push(updates.isActive);
  }

  if (setClauses.length === 0) return;

  params.push(ruleId);
  await databaseService.run(
    `UPDATE override_rules SET ${setClauses.join(', ')} WHERE id = ?`,
    ...params
  );
}

export async function deleteRule(ruleId: string): Promise<void> {
  await databaseService.run('DELETE FROM override_rules WHERE id = ?', ruleId);
}

// ---------------------------------------------------------------------------
// Evaluation — uses shared filter engine from transactions.ts
// ---------------------------------------------------------------------------

/**
 * Evaluate all active rules against transactions.
 * Returns map of transaction_id → { ruleId, targetTaxonomyNodeId }.
 * First matching rule wins (lowest priority_score = highest priority).
 */
export async function evaluateRules(
  transactionIds?: string[]
): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>> {
  const rules = await listRules();
  const activeRules = rules.filter((r) => r.isActive);
  const matched = new Map<string, { ruleId: string; targetTaxonomyNodeId: string }>();

  for (const rule of activeRules) {
    // Use shared filter engine to build WHERE clause from rule conditions
    const built = buildWhereClause(rule.conditions);
    if (!built) continue;

    let sql = `SELECT id FROM transactions WHERE (${built.sql})`;
    const params = [...built.params];

    // Only check specific transactions if provided
    if (transactionIds && transactionIds.length > 0) {
      sql += ` AND id IN (${transactionIds.map(() => '?').join(',')})`;
      params.push(...transactionIds);
    }

    const rows = await databaseService.all<{ id: string }>(sql, ...params);

    for (const row of rows) {
      // First match wins — don't overwrite
      if (!matched.has(row.id)) {
        matched.set(row.id, {
          ruleId: rule.id,
          targetTaxonomyNodeId: rule.targetTaxonomyNodeId,
        });
      }
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Get the next available priority score (max + 1, or 1 if no rules).
 */
async function getNextPriority(): Promise<number> {
  const result = await databaseService.get<{ max_priority: number | null }>(
    'SELECT MAX(priority_score) as max_priority FROM override_rules'
  );
  return (result?.max_priority ?? 0) + 1;
}
