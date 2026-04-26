import type { FilterCondition, GroupedFilter } from './types/transactions';

export function hasValidGroupedFilter(grouped: GroupedFilter | null | undefined): grouped is GroupedFilter {
  return Boolean(grouped?.groups?.some((group) => group.conditions.some((condition) => condition.field)));
}

export function conditionsToGroupedFilter(
  conditions: FilterCondition[],
  connector: 'AND' | 'OR' = 'AND',
): GroupedFilter {
  const valid = conditions.filter((condition) => condition.field);
  return {
    groupConnector: 'AND',
    groups: valid.length > 0 ? [{ connector, conditions: valid }] : [],
  };
}

export function groupedToConditions(grouped: GroupedFilter): FilterCondition[] {
  const result: FilterCondition[] = [];
  for (let gi = 0; gi < grouped.groups.length; gi++) {
    const group = grouped.groups[gi];
    for (let ci = 0; ci < group.conditions.length; ci++) {
      const condition = { ...group.conditions[ci] };
      if (ci < group.conditions.length - 1) {
        condition.connector = group.connector ?? 'AND';
      } else if (gi < grouped.groups.length - 1) {
        condition.connector = grouped.groupConnector ?? 'AND';
      }
      result.push(condition);
    }
  }
  return result;
}

export function andGroupedFilters(...filters: Array<GroupedFilter | null | undefined>): GroupedFilter | undefined {
  const groups = filters
    .filter(hasValidGroupedFilter)
    .flatMap((filter) => filter.groups.filter((group) => group.conditions.some((condition) => condition.field)));

  if (groups.length === 0) return undefined;
  return { groupConnector: 'AND', groups };
}
