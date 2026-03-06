import { v4 as uuidv4 } from 'uuid';
import type { Database, RuleStore as IRuleStore, TransactionStore as ITransactionStore } from '../../shared/types/services';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types/rules';

interface RuleRow {
  id: string;
  name: string;
  source: string;
  conditions: string;
  target_taxonomy_node_id: string;
  priority: number;
  is_active: boolean;
  created_at: string;
}

function rowToRule(row: RuleRow): OverrideRule {
  return {
    id: row.id,
    name: row.name,
    source: (row.source as OverrideRule['source']) || 'project',
    conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions) : row.conditions,
    targetTaxonomyNodeId: row.target_taxonomy_node_id,
    priorityScore: row.priority,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export class RuleStore implements IRuleStore {
  constructor(private db: Database, private transactions: ITransactionStore) {}

  async listRules(): Promise<OverrideRule[]> {
    const rows = await this.db.all<RuleRow>(
      'SELECT * FROM override_rules ORDER BY priority ASC'
    );
    return rows.map(rowToRule);
  }

  async createRule(input: OverrideRuleCreate): Promise<{ id: string }> {
    const id = uuidv4();
    let priority = input.priorityScore;
    if (priority === undefined) {
      priority = await this.getNextPriority();
    }

    await this.db.run(
      `INSERT INTO override_rules (id, name, conditions, target_taxonomy_node_id, priority, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
      id, input.name, JSON.stringify(input.conditions), input.targetTaxonomyNodeId, priority
    );

    return { id };
  }

  async updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.conditions !== undefined) { setClauses.push('conditions = ?'); params.push(JSON.stringify(updates.conditions)); }
    if (updates.targetTaxonomyNodeId !== undefined) { setClauses.push('target_taxonomy_node_id = ?'); params.push(updates.targetTaxonomyNodeId); }
    if (updates.priorityScore !== undefined) { setClauses.push('priority = ?'); params.push(updates.priorityScore); }
    if (updates.isActive !== undefined) { setClauses.push('is_active = ?'); params.push(updates.isActive); }

    if (setClauses.length === 0) return;

    params.push(ruleId);
    await this.db.run(
      `UPDATE override_rules SET ${setClauses.join(', ')} WHERE id = ?`,
      ...params
    );
  }

  async deleteRule(ruleId: string): Promise<void> {
    await this.db.run('DELETE FROM override_rules WHERE id = ?', ruleId);
  }

  async evaluateRules(
    transactionIds?: string[]
  ): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>> {
    const rules = await this.listRules();
    const activeRules = rules.filter((r) => r.isActive);
    const matched = new Map<string, { ruleId: string; targetTaxonomyNodeId: string }>();

    for (const rule of activeRules) {
      const matchedIds = await this.transactions.getIdsByConditions(rule.conditions, transactionIds);

      for (const id of matchedIds) {
        if (!matched.has(id)) {
          matched.set(id, { ruleId: rule.id, targetTaxonomyNodeId: rule.targetTaxonomyNodeId });
        }
      }
    }

    return matched;
  }

  private async getNextPriority(): Promise<number> {
    const result = await this.db.get<{ max_priority: number | null }>(
      'SELECT MAX(priority) as max_priority FROM override_rules'
    );
    return (result?.max_priority ?? 0) + 1;
  }
}
