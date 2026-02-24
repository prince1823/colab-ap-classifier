import { useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTransactions } from '../hooks/useTransactions'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import HierarchicalPivotView from '../components/review/HierarchicalPivotView'
import {
  INITIAL_PIVOT_FILTER_STATE,
  applyPivotFilters,
  type PivotFilterState,
} from '../components/review/PivotFilterBar'
import { exportHierarchicalPivotExcel } from '../utils/exportPivotToExcel'
import { useHierarchicalPivotData, type Aggregation } from '../hooks/useHierarchicalPivotData'
import { useWorkflowStore } from '../stores/workflowStore'
import { convertPivotFiltersToReview } from '../utils/pivotToReviewFilters'

export default function PivotPage() {
  const navigate = useNavigate()
  const { data: transactions, loading, error } = useTransactions()

  // --- Transform rows ---
  const rows = useMemo(() => {
    if (!transactions) return []
    return transactions.map((t, idx) => transactionToDashboardRow(t, idx))
  }, [transactions])

  const availableColumns = useMemo(() => {
    if (!rows.length) return []
    const keys = new Set<string>()
    for (const row of rows.slice(0, 100)) {
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
          keys.add(k)
        }
      }
    }
    const exclude = new Set(['id', 'row_index', 'taxonomy_node_id', 'classification_reasoning', 'invoice_group_key'])
    return [...keys].filter((k) => !exclude.has(k)).sort()
  }, [rows])

  // --- Pivot settings from store (persists across tab switches) ---
  const pivotSettings = useWorkflowStore((s) => s.pivotSettings)
  const setPivotSettings = useWorkflowStore((s) => s.setPivotSettings)

  const { rowDimensions, valueDimension, aggregation, filterState } = pivotSettings

  const setRowDimensions = useCallback((v: string[]) => setPivotSettings({ rowDimensions: v }), [setPivotSettings])
  const setValueDimension = useCallback((v: string) => setPivotSettings({ valueDimension: v }), [setPivotSettings])
  const setAggregation = useCallback((v: Aggregation) => setPivotSettings({ aggregation: v }), [setPivotSettings])
  const setFilterState = useCallback((v: PivotFilterState) => setPivotSettings({ filterState: v }), [setPivotSettings])

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

  // --- Filters ---
  const filteredRows = useMemo(() => applyPivotFilters(rows, filterState), [rows, filterState])

  // --- Pivot data (for export) ---
  const pivotData = useHierarchicalPivotData(
    filteredRows,
    rowDimensions,
    valueDimension,
    aggregation
  )

  // --- Export handler ---
  const handleExportExcel = () => {
    if (!pivotData) return
    exportHierarchicalPivotExcel({ data: pivotData })
  }

  // --- Loading / Error states ---
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          <span className="text-sm text-gray-500">Loading transactions…</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-red-600 font-medium">Failed to load transactions</p>
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
          transactions={filteredRows}
          availableColumns={availableColumns}
          rowDimensions={rowDimensions}
          valueDimension={valueDimension}
          aggregation={aggregation}
          onRowDimensionsChange={setRowDimensions}
          onValueDimensionChange={setValueDimension}
          onAggregationChange={setAggregation}
          allRows={rows}
          filterState={filterState}
          onFilterStateChange={setFilterState}
          onClearAllFilters={() => setPivotSettings({ filterState: INITIAL_PIVOT_FILTER_STATE })}
          onExport={handleExportExcel}
          exportDisabled={!pivotData}
          onOpenInReview={handleOpenInReview}
          openInReviewDisabled={openInReviewDisabled}
        />
      </div>
    </div>
  )
}
