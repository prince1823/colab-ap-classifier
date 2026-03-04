import type { FilterCondition } from '../../shared/types/transactions';

export function conditionToSQL(condition: FilterCondition, params: unknown[]): string | null {
  const { field, operator, value } = condition;
  const col = `"${field}"`;

  switch (operator) {
    case 'equals':
      params.push(value);
      return `${col} = ?`;
    case 'not_equals':
      params.push(value);
      return `${col} != ?`;
    case 'contains':
      params.push(`%${value}%`);
      return `${col} ILIKE ?`;
    case 'not_contains':
      params.push(`%${value}%`);
      return `${col} NOT ILIKE ?`;
    case 'starts_with':
      params.push(`${value}%`);
      return `${col} ILIKE ?`;
    case 'ends_with':
      params.push(`%${value}`);
      return `${col} ILIKE ?`;
    case 'regex':
      params.push(value);
      return `regexp_matches(${col}, ?)`;
    case 'in_list': {
      const values = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
      if (values.length === 0) return null;
      const placeholders = values.map(v => { params.push(v); return '?'; }).join(', ');
      return `${col} IN (${placeholders})`;
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

export function buildWhereClause(conditions: FilterCondition[]): { sql: string; params: unknown[] } | null {
  if (!conditions || conditions.length === 0) return null;

  const params: unknown[] = [];
  const parts: string[] = [];

  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    const fragment = conditionToSQL(condition, params);
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
