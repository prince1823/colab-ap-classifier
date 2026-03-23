import { create } from 'zustand'
import type { Aggregation, SpendDisplayMode } from '../types/pivot'
import type { PivotFilterState } from '../components/review/PivotFilterBar'
import type { GroupedFilter } from '../../shared/types/transactions'

interface PivotState {
  /** Row dimensions for pivot grouping */
  rowDimensions: string[]
  /** Value column to aggregate */
  valueDimension: string
  /** Aggregation function */
  aggregation: Aggregation
  /** Pill filter state from dimension clicks / ⌘F */
  filterState: PivotFilterState
  /** Spend display mode: absolute or % */
  spendDisplayMode: SpendDisplayMode
  /** Advanced grouped filter (from AdvancedFilterModal) */
  advancedGrouped: GroupedFilter | null
  /** Whether the advanced filter modal is open */
  showAdvancedFilter: boolean
  /** Toggle: show only rows flagged for review */
  flaggedForReviewOnly: boolean
  // Actions
  setRowDimensions: (dims: string[]) => void
  setValueDimension: (dim: string) => void
  setAggregation: (agg: Aggregation) => void
  setFilterState: (state: PivotFilterState) => void
  setSpendDisplayMode: (mode: SpendDisplayMode) => void
  setAdvancedGrouped: (grouped: GroupedFilter | null) => void
  setShowAdvancedFilter: (show: boolean) => void
  setFlaggedForReviewOnly: (on: boolean) => void
  clearAllFilters: () => void
  /** Reset all state (e.g., on project switch) */
  reset: () => void
}

const INITIAL_STATE = {
  rowDimensions: [] as string[],
  valueDimension: 'spend_amount',
  aggregation: 'sum' as Aggregation,
  filterState: {} as PivotFilterState,
  spendDisplayMode: 'absolute' as SpendDisplayMode,
  advancedGrouped: null as GroupedFilter | null,
  showAdvancedFilter: false,
  flaggedForReviewOnly: false,
}

export const usePivotStore = create<PivotState>()((set) => ({
  ...INITIAL_STATE,

  setRowDimensions: (dims) => set({ rowDimensions: dims }),
  setValueDimension: (dim) => set({ valueDimension: dim }),
  setAggregation: (agg) => set({ aggregation: agg }),
  setFilterState: (state) => set({ filterState: state }),
  setSpendDisplayMode: (mode) => set({ spendDisplayMode: mode }),
  setAdvancedGrouped: (grouped) => set({ advancedGrouped: grouped }),
  setShowAdvancedFilter: (show) => set({ showAdvancedFilter: show }),
  setFlaggedForReviewOnly: (on) => set({ flaggedForReviewOnly: on }),
  clearAllFilters: () => set({ filterState: {}, advancedGrouped: null, flaggedForReviewOnly: false }),
  reset: () => set(INITIAL_STATE),
}))
