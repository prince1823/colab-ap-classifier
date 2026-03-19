import { v4 as uuidv4 } from 'uuid';
import type { Database, RuleStore as IRuleStore, TransactionStore as ITransactionStore } from '../../shared/types/services';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types/rules';
import type { GroupedFilter } from '../../shared/types/transactions';

// Minimum gap between two float priorities before renormalization is triggered.
const PRIORITY_PRECISION_THRESHOLD = 1e-10;

interface RuleRow {
  id: string;
  name: string;
  source: string;
  conditions: string;
  grouped_conditions: string | null;
  target_taxonomy_node_id: string;
  priority: number;
  rank: number;
  is_active: boolean;
  created_at: string;
}

function parseGroupedConditions(raw: string | null): GroupedFilter | undefined {
  if (!raw) return undefined;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

function rowToRule(row: RuleRow): OverrideRule {
  return {
    id: row.id,
    name: row.name,
    source: (row.source as OverrideRule['source']) || 'project',
    conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions) : row.conditions,
    groupedConditions: parseGroupedConditions(row.grouped_conditions),
    targetTaxonomyNodeId: row.target_taxonomy_node_id,
    priorityScore: row.rank,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export class RuleStore implements IRuleStore {
  constructor(private db: Database, private transactions: ITransactionStore) {}

  async listRules(): Promise<OverrideRule[]> {
    const rows = await this.db.all<RuleRow>(
      'SELECT *, ROW_NUMBER() OVER (ORDER BY priority ASC) as rank FROM override_rules ORDER BY priority ASC'
    );
    return rows.map(rowToRule);
  }

  async createRule(input: OverrideRuleCreate): Promise<{ id: string }> {
    const id = uuidv4();
    let float: number;

    if (input.priorityScore === undefined) {
      float = await this.getNextPriority();
    } else {
      float = await this.floatForRank(input.priorityScore);
    }

    try {
      await this.db.run(
        `INSERT INTO override_rules (id, name, conditions, grouped_conditions, target_taxonomy_node_id, priority, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
        id, input.name, JSON.stringify(input.conditions),
        input.groupedConditions ? JSON.stringify(input.groupedConditions) : null,
        input.targetTaxonomyNodeId, float
      );
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('unique')) {
        throw new Error(`A rule named "${input.name}" already exists. Rule names must be unique.`);
      }
      throw err;
    }

    return { id };
  }

  async updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
    if (updates.conditions !== undefined) { setClauses.push('conditions = ?'); params.push(JSON.stringify(updates.conditions)); }
    if (updates.groupedConditions !== undefined) { setClauses.push('grouped_conditions = ?'); params.push(JSON.stringify(updates.groupedConditions)); }
    if (updates.targetTaxonomyNodeId !== undefined) { setClauses.push('target_taxonomy_node_id = ?'); params.push(updates.targetTaxonomyNodeId); }
    if (updates.isActive !== undefined) { setClauses.push('is_active = ?'); params.push(updates.isActive); }

    if (updates.priorityScore !== undefined) {
      const float = await this.floatForRank(updates.priorityScore, ruleId);
      setClauses.push('priority = ?');
      params.push(float);
    }

    if (setClauses.length === 0) return;

    params.push(ruleId);
    try {
      await this.db.run(
        `UPDATE override_rules SET ${setClauses.join(', ')} WHERE id = ?`,
        ...params
      );
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('unique')) {
        throw new Error(`A rule named "${updates.name}" already exists. Rule names must be unique.`);
      }
      throw err;
    }
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
      // Prefer grouped conditions (preserves exact AND/OR group structure); fall back to flat conditions
      let matchedIds: string[];
      if (rule.groupedConditions && rule.groupedConditions.groups.length > 0) {
        matchedIds = await this.transactions.getIdsByGroupedConditions(rule.groupedConditions, transactionIds);
      } else {
        matchedIds = await this.transactions.getIdsByConditions(rule.conditions, transactionIds);
      }

      for (const id of matchedIds) {
        if (!matched.has(id)) {
          matched.set(id, { ruleId: rule.id, targetTaxonomyNodeId: rule.targetTaxonomyNodeId });
        }
      }
    }

    return matched;
  }

  /**
   * Compute the float priority for inserting/moving a rule to a given rank.
   * If excludeId is provided, that rule is excluded from the rank calculation
   * (used when reordering an existing rule).
   * Triggers renormalization if the gap between neighbors is below precision threshold.
   */
  private async floatForRank(rank: number, excludeId?: string): Promise<number> {
    const safeRank = Math.max(1, Math.floor(rank));
    let { prev, next } = await this.getNeighborFloats(safeRank, excludeId);

    if (prev !== null && next !== null && next - prev < PRIORITY_PRECISION_THRESHOLD) {
      await this.renormalize();
      ({ prev, next } = await this.getNeighborFloats(safeRank, excludeId));
    }

    return this.computeFloat(prev, next);
  }

  /**
   * Returns the internal float priorities immediately before and after rank P
   * in the sorted list, optionally excluding a specific rule by id.
   */
  private async getNeighborFloats(
    rank: number,
    excludeId?: string
  ): Promise<{ prev: number | null; next: number | null }> {
    const where = excludeId ? 'WHERE id != ?' : '';
    const baseParams: unknown[] = excludeId ? [excludeId] : [];

    const [prevRow, nextRow] = await Promise.all([
      rank > 1
        ? this.db.get<{ priority: number }>(
            `SELECT priority FROM override_rules ${where} ORDER BY priority ASC LIMIT 1 OFFSET ?`,
            ...baseParams, rank - 2
          )
        : Promise.resolve(undefined),
      this.db.get<{ priority: number }>(
        `SELECT priority FROM override_rules ${where} ORDER BY priority ASC LIMIT 1 OFFSET ?`,
        ...baseParams, rank - 1
      ),
    ]);

    return {
      prev: prevRow?.priority ?? null,
      next: nextRow?.priority ?? null,
    };
  }

  private computeFloat(prev: number | null, next: number | null): number {
    if (prev === null && next === null) return 1.0;
    if (prev === null) return next! - 1.0;
    if (next === null) return prev + 1.0;
    return (prev + next) / 2;
  }

  /**
   * Reassign all priorities as 1.0, 2.0, 3.0, ... resetting float precision.
   * O(n) but called only when float gaps near exhaustion (~every 52 bisections).
   */
  private async renormalize(): Promise<void> {
    await this.db.exec(`
      UPDATE override_rules
      SET priority = sub.new_priority
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY priority ASC) AS new_priority
        FROM override_rules
      ) sub
      WHERE override_rules.id = sub.id
    `);
  }

  private async getNextPriority(): Promise<number> {
    const result = await this.db.get<{ max_priority: number | null }>(
      'SELECT MAX(priority) as max_priority FROM override_rules'
    );
    return (result?.max_priority ?? 0) + 1;
  }
}
