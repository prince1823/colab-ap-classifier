import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { readRulePack } from './colabip';
import * as taxonomyService from './taxonomy';
import * as supplierService from './suppliers';
import type {
  OverrideRule,
  OverrideRuleCreate,
  OverrideRuleUpdate,
  RuleCondition,
  RuleSource,
} from '../../shared/types';

interface RuleRow {
  id: string;
  name: string;
  source: string;
  conditions: string;
  target_taxonomy_node_id: string;
  priority_score: number;
  is_active: boolean;
  imported_at: string | null;
  created_at: string;
}

function rowToRule(row: RuleRow): OverrideRule {
  return {
    id: row.id,
    name: row.name,
    source: row.source as RuleSource,
    conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions) : row.conditions,
    targetTaxonomyNodeId: row.target_taxonomy_node_id,
    priorityScore: row.priority_score,
    isActive: row.is_active,
    importedAt: row.imported_at,
    createdAt: row.created_at,
  };
}

export async function listRules(): Promise<OverrideRule[]> {
  const rows = await databaseService.all<RuleRow>(
    'SELECT * FROM override_rules ORDER BY priority_score ASC'
  );
  return rows.map(rowToRule);
}

export async function createRule(input: OverrideRuleCreate): Promise<{ id: string }> {
  const id = uuidv4();
  const source = input.source || 'project';

  let priorityScore = input.priorityScore;
  if (priorityScore === undefined) {
    priorityScore = await getNextPriority(source);
  }

  await databaseService.run(
    `INSERT INTO override_rules (id, name, source, conditions, target_taxonomy_node_id, priority_score, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
    id,
    input.name,
    source,
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

export async function importFromColabip(rulePack: string): Promise<{ imported: number }> {
  const rules = await readRulePack(rulePack);
  const nodes = await taxonomyService.getNodes();

  let imported = 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    // Find taxonomy node by path
    const node = nodes.find((n) => n.fullPath === rule.targetPath);
    if (!node) {
      console.warn(`[Rules] Skipping rule "${rule.name}" — taxonomy path not found: ${rule.targetPath}`);
      continue;
    }

    await createRule({
      name: rule.name,
      source: 'taxonomy',
      conditions: rule.conditions,
      targetTaxonomyNodeId: node.id,
      priorityScore: 200 + i,
    });
    imported++;
  }

  return { imported };
}

/**
 * Evaluate rules against transactions. Returns map of transaction_id → rule_id.
 */
export async function evaluateRules(
  transactionIds?: string[]
): Promise<Map<string, string>> {
  const rules = await listRules();
  const activeRules = rules.filter((r) => r.isActive);
  const matched = new Map<string, string>();

  for (const rule of activeRules) {
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    // Build condition SQL
    for (const condition of rule.conditions) {
      const clause = conditionToSQL(condition, params);
      if (clause) whereClauses.push(clause);
    }

    if (whereClauses.length === 0) continue;

    let sql = `SELECT id FROM transactions WHERE ${whereClauses.join(' AND ')}`;

    // Only check specific transactions if provided
    if (transactionIds && transactionIds.length > 0) {
      sql += ` AND id IN (${transactionIds.map(() => '?').join(',')})`;
      params.push(...transactionIds);
    }

    const rows = await databaseService.all<{ id: string }>(sql, ...params);

    for (const row of rows) {
      if (!matched.has(row.id)) {
        matched.set(row.id, rule.id);
      }
    }
  }

  return matched;
}

/**
 * Sync rules from taxonomy and supplier sources.
 * Delete existing taxonomy/supplier rules, rebuild from ColabIP + Category A.
 */
export async function syncRulesFromSources(): Promise<void> {
  // Delete auto-generated rules
  await databaseService.run(
    "DELETE FROM override_rules WHERE source IN ('taxonomy', 'supplier')"
  );

  // Rebuild supplier rules from Category A
  const suppliers = await supplierService.listSuppliers();
  const categoryASuppliers = suppliers.filter(
    (s) => s.categoryA && s.categoryATaxonomyNodeId
  );

  for (let i = 0; i < categoryASuppliers.length; i++) {
    const supplier = categoryASuppliers[i];
    await createRule({
      name: `Category A: ${supplier.supplierName}`,
      source: 'supplier',
      conditions: [
        { field: 'supplier_name', operator: 'equals', value: supplier.supplierName },
      ],
      targetTaxonomyNodeId: supplier.categoryATaxonomyNodeId!,
      priorityScore: 300 + i,
    });
  }
}

function conditionToSQL(condition: RuleCondition, params: unknown[]): string | null {
  const { field, operator, value } = condition;
  const col = field; // canonical column name

  switch (operator) {
    case 'equals':
      params.push(value);
      return `${col} = ?`;
    case 'not_equals':
      params.push(value);
      return `${col} != ?`;
    case 'contains':
      params.push(`%${value}%`);
      return `${col} LIKE ?`;
    case 'not_contains':
      params.push(`%${value}%`);
      return `${col} NOT LIKE ?`;
    case 'starts_with':
      params.push(`${value}%`);
      return `${col} LIKE ?`;
    case 'ends_with':
      params.push(`%${value}`);
      return `${col} LIKE ?`;
    case 'regex':
      return `regexp_matches(${col}, '${String(value).replace(/'/g, "''")}')`;
    case 'in_list': {
      const listValues = Array.isArray(value)
        ? value
        : String(value).split(',').map((v: string) => v.trim());
      const placeholders = listValues.map(() => '?').join(',');
      params.push(...listValues);
      return `${col} IN (${placeholders})`;
    }
    case 'greater_than':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) > ?`;
    case 'less_than':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) < ?`;
    case 'greater_than_or_equal':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) >= ?`;
    case 'less_than_or_equal':
      params.push(typeof value === 'number' ? value : parseFloat(String(value)));
      return `CAST(${col} AS DOUBLE) <= ?`;
    default:
      return null;
  }
}

async function getNextPriority(source: string): Promise<number> {
  const base = source === 'project' ? 100 : source === 'taxonomy' ? 200 : 300;
  const result = await databaseService.get<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM override_rules WHERE source = ?',
    source
  );
  return base + (result?.cnt || 0);
}
