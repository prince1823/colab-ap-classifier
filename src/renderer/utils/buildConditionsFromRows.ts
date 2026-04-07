import { makeEmptyGroup } from '../components/FilterConditionBuilder'
import type { GroupedFilter, ConditionGroup, FilterCondition } from '../../shared/types/transactions'
import type { FlattenedPivotRow } from '../types/pivot'

/** Sentinel label the pivot UI assigns to NULL/empty dimension values. */
const UNCLASSIFIED_SENTINEL = '(Unclassified)'

/**
 * Check if a classification-related field value represents unclassified transactions.
 * Handles both exact sentinel ("(Unclassified)") and composed paths like "(Unclassified) >  >".
 */
function isUnclassifiedValue(field: string, value: string): boolean {
  if (!field.startsWith('classification_')) return false
  return value === UNCLASSIFIED_SENTINEL || value.startsWith(UNCLASSIFIED_SENTINEL)
}

/**
 * Build a GroupedFilter from selected pivot rows.
 * Groups rows by dimensionField: values in the same field are OR'd via in_list,
 * different fields are AND'd together.
 * Only uses the leaf (deepest) segment of each row.
 *
 * When a classification field has an "(Unclassified)" value (exact or in a composed
 * path like "classification_path"), the condition is replaced with
 * `taxonomy_node_id IS NULL` to match transactions with no classification —
 * avoiding string format mismatches between the trimmed UI label and the raw SQL output.
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
    const conditions: FilterCondition[] = valArr.map(v => {
      // Classification fields showing "(Unclassified)" → match via taxonomy_node_id IS NULL
      if (isUnclassifiedValue(field, v)) {
        return {
          field: 'taxonomy_node_id',
          operator: 'is_null' as const,
          value: '',
          connector: 'OR' as const,
        }
      }
      return {
        field,
        operator: 'equals' as const,
        value: v,
        connector: 'OR' as const,
      }
    })
    groups.push({ connector: 'OR', conditions })
  }

  return { groupConnector: 'AND', groups }
}
