import type { PivotFilterState } from '../components/review/PivotFilterBar'

/**
 * Maps pivot filter keys (backend column names) to review filterState UI keys.
 * Keys not in this map go directly into activeFilters.
 */
const PIVOT_TO_REVIEW_KEY: Record<string, string> = {
  supplier_name: 'supplier',
  gl_description: 'glDescription',
  classification_l1: 'classificationL1',
  classification_l2: 'classificationL2',
  classification_l3: 'classificationL3',
  classification_l4: 'classificationL4',
  company: 'company',
  year: 'year',
  quarter: 'quarter',
  month: 'month',
  costCenter: 'costCenter',
  country: 'country',
  line_description: 'lineDescription',
}

/** Classification keys — these are evaluated via path parsing in Dashboard,
 *  not by direct column lookup, so they must NOT go into activeFilters. */
const CLASSIFICATION_KEYS = new Set([
  'classification_l1',
  'classification_l2',
  'classification_l3',
  'classification_l4',
])

/** Keys managed by Dashboard's filterState→activeFilters sync */
const SYNC_MANAGED_KEYS = new Set([
  'supplier_name', 'gl_description', 'company', 'year',
  'quarter', 'month', 'costCenter', 'country', 'lineDescription',
])

const EMPTY_REVIEW_FILTER_STATE: Record<string, string[]> = {
  supplier: [],
  classificationL1: [],
  classificationL2: [],
  classificationL3: [],
  classificationL4: [],
  glDescription: [],
  company: [],
  year: [],
  quarter: [],
  month: [],
  costCenter: [],
  country: [],
  lineDescription: [],
}

/**
 * Convert pivot filter state to review filter state format.
 *
 * - Mapped columns → filterState (UI layer) + activeFilters (backend layer)
 * - Classification L1-L4 → filterState only (Dashboard parses classification_path)
 * - Unmapped columns → activeFilters only
 */
export function convertPivotFiltersToReview(pivotFilterState: PivotFilterState) {
  const reviewFilterState = { ...EMPTY_REVIEW_FILTER_STATE }
  const activeFilters: Record<string, string[]> = {}

  for (const [pivotKey, values] of Object.entries(pivotFilterState)) {
    if (!values || values.length === 0) continue

    const reviewKey = PIVOT_TO_REVIEW_KEY[pivotKey]

    if (reviewKey && reviewKey in reviewFilterState) {
      // Set in filterState (UI layer)
      reviewFilterState[reviewKey] = [...values]
    }

    // Also set in activeFilters for non-classification mapped columns
    // (Dashboard's prevFilterStateRef sync won't fire on first mount)
    if (CLASSIFICATION_KEYS.has(pivotKey)) {
      // Skip — Dashboard evaluates these via classification_path parsing
      continue
    }

    if (reviewKey && SYNC_MANAGED_KEYS.has(pivotKey)) {
      // Mapped column — use the backend key for activeFilters
      activeFilters[pivotKey] = [...values]
    } else if (!reviewKey) {
      // Unmapped column — set directly in activeFilters
      activeFilters[pivotKey] = [...values]
    }
  }

  return { filterState: reviewFilterState, activeFilters }
}
