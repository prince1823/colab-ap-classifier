import { makeEmptyGroup } from '../components/FilterConditionBuilder'
import type { GroupedFilter, ConditionGroup, FilterCondition } from '../../shared/types/transactions'
import type { FlattenedPivotRow } from '../types/pivot'

/**
 * Build a GroupedFilter from selected pivot rows.
 * Groups rows by dimensionField: values in the same field are OR'd via in_list,
 * different fields are AND'd together.
 * Only uses the leaf (deepest) segment of each row.
 */
export function buildGroupedConditionsFromRows(rows: FlattenedPivotRow[]): GroupedFilter {
  const fieldValues = new Map<string, Set<string>>()
  for (const row of rows) {
    const leaf = row.pathSegments[row.pathSegments.length - 1]
    if (!leaf) continue
    if (!fieldValues.has(leaf.dimensionField)) {
      fieldValues.set(leaf.dimensionField, new Set())
    }
    fieldValues.get(leaf.dimensionField)!.add(leaf.value)
  }

  if (fieldValues.size === 0) {
    return { groupConnector: 'AND', groups: [makeEmptyGroup()] }
  }

  // Each value becomes its own individual "equals" condition, OR'd within a group per field.
  // Multiple fields are AND'd via separate groups.
  const groups: ConditionGroup[] = []
  for (const [field, values] of fieldValues) {
    const valArr = Array.from(values)
    const conditions: FilterCondition[] = valArr.map(v => ({
      field,
      operator: 'equals' as const,
      value: v,
      connector: 'OR' as const,
    }))
    groups.push({ connector: 'OR', conditions })
  }

  return { groupConnector: 'AND', groups }
}
