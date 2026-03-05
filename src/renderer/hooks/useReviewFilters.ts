import { useCallback, useMemo } from 'react'
import { useReviewFilterContext } from '../components/review/ReviewFilterContext'
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
  const { filters, setFilters, clearFilters } = useReviewFilterContext()

  const setFilter = useCallback((field: string, values: string[]) => {
    setFilters(prev => ({
      filterState: { ...prev.filterState, [field]: values },
    }))
  }, [setFilters])

  /**
   * Convert current UI filter state into FilterCondition[] ready for IPC calls.
   * Each active filter becomes an `in_list` condition.
   */
  const toFilterConditions = useCallback((): FilterCondition[] => {
    const conditions: FilterCondition[] = []
    const seenColumns = new Set<string>()

    for (const [key, values] of Object.entries(filters.filterState)) {
      if (!Array.isArray(values) || values.length === 0) continue
      const column = FILTER_KEY_TO_COLUMN[key] || key
      seenColumns.add(column)

      const connector = filters.filterConnectors[column] || 'AND'
      conditions.push({
        field: column,
        operator: 'in_list',
        value: values,
        connector,
      })
    }

    for (const [key, value] of Object.entries(filters.activeFilters)) {
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
  }, [filters.filterState, filters.activeFilters, filters.filterConnectors])

  const activeChips = useMemo((): ReviewFilterChip[] => {
    const chips: ReviewFilterChip[] = []

    for (const [key, values] of Object.entries(filters.filterState)) {
      if (!Array.isArray(values) || values.length === 0) continue
      chips.push({
        field: key,
        label: key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()),
        values,
      })
    }

    for (const [key, value] of Object.entries(filters.activeFilters)) {
      if (!value || (Array.isArray(value) && value.length === 0)) continue
      if (filters.filterState[key]?.length > 0) continue
      const values = Array.isArray(value) ? value : [value]
      chips.push({
        field: key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase()),
        values,
      })
    }

    return chips
  }, [filters.filterState, filters.activeFilters])

  return {
    filters,
    setFilter,
    clearFilters,
    toFilterConditions,
    activeChips,
  }
}
