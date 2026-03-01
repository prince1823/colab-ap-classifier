import { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import HierarchicalPivotView from '../components/review/HierarchicalPivotView'
import {
  INITIAL_PIVOT_FILTER_STATE,
  type PivotFilterState,
} from '../components/review/PivotFilterBar'
import { exportHierarchicalPivotExcel } from '../utils/exportPivotToExcel'
import { type Aggregation } from '../hooks/useHierarchicalPivotData'
import { useServerPivotData } from '../hooks/useServerPivotData'
import { useWorkflowStore } from '../stores/workflowStore'
import { convertPivotFiltersToReview } from '../utils/pivotToReviewFilters'
import { ipc } from '../lib/ipc'
import type { TransactionFilter, ColumnFilter } from '../../shared/types/transactions'

/**
 * Convert PivotFilterState (Record<string, string[]>) to TransactionFilter
 * for server-side filtering in the pivot aggregation query.
 */
function pivotFiltersToTransactionFilter(
  filterState: PivotFilterState
): TransactionFilter | undefined {
  const columnFilters: ColumnFilter[] = []
  for (const [col, values] of Object.entries(filterState)) {
    if (values.length > 0) {
      columnFilters.push({ column: col, operator: 'is', values })
    }
  }
  if (columnFilters.length === 0) return undefined
  return { columnFilters, filterCombinator: 'AND' }
}

export default function PivotPage() {
  const navigate = useNavigate()

  // --- Available columns from DuckDB ---
  const [availableColumns, setAvailableColumns] = useState<string[]>([])
  useEffect(() => {
    const exclude = new Set(['id', 'row_index', 'taxonomy_node_id', 'classification_reasoning', 'invoice_group_key'])
    ipc.transactions.getColumns().then((cols) => {
      setAvailableColumns(cols.filter((c) => !exclude.has(c)).sort())
    }).catch(() => {})
  }, [])

  // --- Pivot settings from store (persists across tab switches) ---
  const pivotSettings = useWorkflowStore((s) => s.pivotSettings)
  const setPivotSettings = useWorkflowStore((s) => s.setPivotSettings)

  const { rowDimensions, valueDimension, aggregation, filterState } = pivotSettings

  const setRowDimensions = useCallback((v: string[]) => setPivotSettings({ rowDimensions: v }), [setPivotSettings])
  const setValueDimension = useCallback((v: string) => setPivotSettings({ valueDimension: v }), [setPivotSettings])
  const setAggregation = useCallback((v: Aggregation) => setPivotSettings({ aggregation: v }), [setPivotSettings])
  const setFilterState = useCallback((v: PivotFilterState) => setPivotSettings({ filterState: v }), [setPivotSettings])

  // --- Server-side filter ---
  const serverFilter = useMemo(
    () => pivotFiltersToTransactionFilter(filterState),
    [filterState]
  )

  // --- Server-side pivot aggregation (replaces useTransactions + useHierarchicalPivotData) ---
  const { pivotData, loading, error, totalCount } = useServerPivotData(
    rowDimensions,
    valueDimension,
    aggregation,
    serverFilter
  )

  // --- Fetch distinct values for filter dropdowns (server-side) ---
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  useEffect(() => {
    if (!rowDimensions.length) return
    let cancelled = false
    Promise.all(
      rowDimensions.map((dim) =>
        ipc.transactions.distinctValues(dim, 500).then((vals) => ({ dim, vals }))
      )
    ).then((results) => {
      if (cancelled) return
      const opts: Record<string, string[]> = {}
      for (const { dim, vals } of results) {
        opts[dim] = vals
      }
      setFilterOptions(opts)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [rowDimensions])

  // --- Open in Review ---
  const setReviewFilters = useWorkflowStore((s) => s.setReviewFilters)
  const hasClassifiedData = useWorkflowStore((s) => s.hasClassifiedData)

  const activeFilterCount = useMemo(
    () => Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0),
    [filterState]
  )

  const handleOpenInReview = useCallback(() => {
    const { filterState: reviewFS, activeFilters } = convertPivotFiltersToReview(filterState)
    setReviewFilters({
      filterState: reviewFS,
      activeFilters,
      filterGroupOperators: {},
      filterConnectors: {},
      filterCombinator: 'AND',
      showFilterPanel: false,
    })
    navigate('/workflow/review')
  }, [filterState, setReviewFilters, navigate])

  const openInReviewDisabled = activeFilterCount === 0 || !hasClassifiedData

  // --- Export handler ---
  const handleExportExcel = () => {
    if (!pivotData) return
    exportHierarchicalPivotExcel({ data: pivotData })
  }

  // --- Loading / Error states ---
  if (loading && !pivotData) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          <span className="text-sm text-gray-500">Loading pivot data…</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-red-600 font-medium">Failed to load pivot data</p>
          <p className="text-sm text-gray-500 mt-1">{String(error)}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full p-5">
      {/* Hierarchical pivot table (takes all space — toolbar is inside) */}
      <div className="flex-1 min-h-0">
        <HierarchicalPivotView
          pivotData={pivotData}
          availableColumns={availableColumns}
          rowDimensions={rowDimensions}
          valueDimension={valueDimension}
          aggregation={aggregation}
          onRowDimensionsChange={setRowDimensions}
          onValueDimensionChange={setValueDimension}
          onAggregationChange={setAggregation}
          filterOptions={filterOptions}
          filterState={filterState}
          onFilterStateChange={setFilterState}
          onClearAllFilters={() => setPivotSettings({ filterState: INITIAL_PIVOT_FILTER_STATE })}
          onExport={handleExportExcel}
          exportDisabled={!pivotData}
          onOpenInReview={handleOpenInReview}
          openInReviewDisabled={openInReviewDisabled}
          totalCount={totalCount}
        />
      </div>
    </div>
  )
}
