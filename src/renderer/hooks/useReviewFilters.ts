import { useCallback, useMemo } from 'react'
import { useWorkflowStore } from '../stores/workflowStore'
import type { FilterCondition } from '../../shared/types/transactions'

export interface ReviewFilterChip {
  field: string;
  label: string;
  values: string[];
}

/** Maps UI filter keys to backend column names */
const FILTER_KEY_TO_COLUMN: Record<string, string> = {
  supplier: 'supplier_name',
  classificationL1: 'L1',
  classificationL2: 'L2',
  classificationL3: 'L3',
  classificationL4: 'L4',
  glDescription: 'gl_description',
  lineDescription: 'line_description',
  company: 'company',
  year: 'year',
  quarter: 'quarter',
  month: 'month',
  costCenter: 'cost_center',
  country: 'country',
}

export function useReviewFilters() {
  const reviewFilters = useWorkflowStore(s => s.reviewFilters)
  const storeSetReviewFilters = useWorkflowStore(s => s.setReviewFilters)
  const clearReviewFilters = useWorkflowStore(s => s.clearReviewFilters)

  const setFilter = useCallback((field: string, values: string[]) => {
    const currentFilterState = useWorkflowStore.getState().reviewFilters.filterState
    storeSetReviewFilters({
      filterState: { ...currentFilterState, [field]: values },
    })
  }, [storeSetReviewFilters])

  const clearFilters = useCallback(() => {
    clearReviewFilters()
  }, [clearReviewFilters])

  /**
   * Convert current UI filter state into FilterCondition[] ready for IPC calls.
   * Each active filter becomes an `in_list` condition.
   */
  const toFilterConditions = useCallback((): FilterCondition[] => {
    const conditions: FilterCondition[] = []
    const { filterState, activeFilters, filterConnectors } = useWorkflowStore.getState().reviewFilters
    const seenColumns = new Set<string>()

    // filterState entries (dropdown filters)
    for (const [key, values] of Object.entries(filterState)) {
      if (!Array.isArray(values) || values.length === 0) continue
      const column = FILTER_KEY_TO_COLUMN[key] || key
      seenColumns.add(column)

      const connector = filterConnectors[column] || 'AND'
      conditions.push({
        field: column,
        operator: 'in_list',
        value: values,
        connector,
      })
    }

    // activeFilters (programmatic filters from tree clicks, etc.)
    for (const [key, value] of Object.entries(activeFilters)) {
      if (!value || (Array.isArray(value) && value.length === 0)) continue
      if (seenColumns.has(key)) continue
      const values = Array.isArray(value) ? value : [value]
      conditions.push({
        field: key,
        operator: 'in_list',
        value: values,
      })
    }

    return conditions
  }, [])

  const activeChips = useMemo((): ReviewFilterChip[] => {
    const chips: ReviewFilterChip[] = []

    for (const [key, values] of Object.entries(reviewFilters.filterState)) {
      if (!Array.isArray(values) || values.length === 0) continue
      chips.push({
        field: key,
        label: key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()),
        values,
      })
    }

    for (const [key, value] of Object.entries(reviewFilters.activeFilters)) {
      if (!value || (Array.isArray(value) && value.length === 0)) continue
      // Skip if already in filterState
      if (reviewFilters.filterState[key]?.length > 0) continue
      const values = Array.isArray(value) ? value : [value]
      chips.push({
        field: key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase()),
        values,
      })
    }

    return chips
  }, [reviewFilters.filterState, reviewFilters.activeFilters])

  return {
    filters: reviewFilters,
    setFilter,
    clearFilters,
    toFilterConditions,
    activeChips,
  }
}
