import type { FilterCondition, ConditionGroup, GroupedFilter } from '../../shared/types/transactions';

/** Optional column resolver — maps field name to SQL expression. Default: quoted column name. */
export type ColumnResolver = (field: string) => string;

const defaultResolver: ColumnResolver = (field) => `"${field}"`;

/** Max parameters per IN-clause chunk — keeps spreads below the JS call-stack limit. */
const IN_CLAUSE_BATCH = 500;

export function conditionToSQL(
  condition: FilterCondition,
  params: unknown[],
  resolveColumn: ColumnResolver = defaultResolver
): string | null {
  const { field, operator, value } = condition;
  const col = resolveColumn(field);

  switch (operator) {
    case 'equals':
      params.push(value);
      return `${col} = ?`;
    case 'not_equals':
      params.push(value);
      return `(${col} IS NULL OR ${col} != ?)`;
    case 'contains':
      params.push(`%${value}%`);
      return `${col} ILIKE ?`;
    case 'not_contains':
      params.push(`%${value}%`);
      return `(${col} IS NULL OR ${col} NOT ILIKE ?)`;
    case 'starts_with':
      params.push(`${value}%`);
      return `${col} ILIKE ?`;
    case 'ends_with':
      params.push(`%${value}`);
      return `${col} ILIKE ?`;
    case 'regex':
      params.push(value);
      return `regexp_matches(${col}, ?)`;
    case 'is_null':
      return `${col} IS NULL`;
    case 'is_true':
      return `${col} IS TRUE`;
    case 'is_false':
      return `${col} IS FALSE`;
    case 'in_list': {
      const values = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
      if (values.length === 0) return null;
      // Always parameterize. For large lists, chunk into multiple IN clauses
      // joined by OR so we never spread thousands of params into one call.
      const chunks: string[] = [];
      for (let i = 0; i < values.length; i += IN_CLAUSE_BATCH) {
        const chunk = values.slice(i, i + IN_CLAUSE_BATCH);
        const placeholders = chunk.map(v => { params.push(v); return '?'; }).join(', ');
        chunks.push(`${col} IN (${placeholders})`);
      }
      return chunks.length === 1 ? chunks[0] : `(${chunks.join(' OR ')})`;
    }
    case 'greater_than':
      params.push(value);
      return `CAST(${col} AS DOUBLE) > ?`;
    case 'less_than':
      params.push(value);
      return `CAST(${col} AS DOUBLE) < ?`;
    case 'greater_than_or_equal':
      params.push(value);
      return `CAST(${col} AS DOUBLE) >= ?`;
    case 'less_than_or_equal':
      params.push(value);
      return `CAST(${col} AS DOUBLE) <= ?`;
    default:
      return null;
  }
}

export function buildWhereClause(
  conditions: FilterCondition[],
  resolveColumn?: ColumnResolver
): { sql: string; params: unknown[] } | null {
  if (!conditions || conditions.length === 0) return null;

  const params: unknown[] = [];
  const parts: string[] = [];

  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    const fragment = conditionToSQL(condition, params, resolveColumn);
    if (!fragment) continue;

    if (parts.length > 0) {
      const connector = conditions[i - 1]?.connector || 'AND';
      parts.push(connector);
    }
    parts.push(fragment);
  }

  if (parts.length === 0) return null;
  return { sql: parts.join(' '), params };
}

/**
 * Build a WHERE clause from grouped conditions.
 * Each group's conditions are parenthesized; groups are joined by groupConnector.
 * Example: (A AND B) OR (C AND D)
 */
export function buildGroupedWhereClause(
  grouped: GroupedFilter,
  resolveColumn?: ColumnResolver
): { sql: string; params: unknown[] } | null {
  const params: unknown[] = [];
  const groupSQLs: string[] = [];

  for (const group of grouped.groups) {
    const validConditions = group.conditions.filter(c => c.field);
    if (validConditions.length === 0) continue;

    const parts: string[] = [];
    for (let vi = 0; vi < validConditions.length; vi++) {
      const fragment = conditionToSQL(validConditions[vi], params, resolveColumn);
      if (!fragment) continue;
      if (parts.length > 0) {
        // Groups are homogeneous (type invariant, enforced by UI) — use the
        // group's connector, not per-condition. Keeps filter semantics aligned
        // with rule evaluation, which collapses per-condition connectors.
        parts.push(group.connector);
      }
      parts.push(fragment);
    }

    if (parts.length > 0) {
      // Wrap in parens only if multiple parts and there are multiple groups
      groupSQLs.push(parts.length > 1 ? `(${parts.join(' ')})` : parts[0]);
    }
  }

  if (groupSQLs.length === 0) return null;

  // Join groups with per-group connectors (each group can have its own connector to the previous)
  let sql = groupSQLs[0];
  const validGroups = grouped.groups.filter(g => g.conditions.some(c => c.field));
  for (let i = 1; i < groupSQLs.length; i++) {
    const connector = validGroups[i]?.groupConnector ?? grouped.groupConnector;
    sql += ` ${connector} ${groupSQLs[i]}`;
  }

  return { sql, params };
}
