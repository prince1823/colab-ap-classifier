import { useState, useMemo } from 'react'
import {
  FunnelIcon,
  ArrowDownTrayIcon,
  DocumentArrowDownIcon,
} from '@heroicons/react/24/outline'
import { useTransactions } from '../hooks/useTransactions'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import { usePivotData } from '../hooks/usePivotData'
import PivotView from '../components/review/PivotView'
import PivotFilterBar, {
  INITIAL_PIVOT_FILTER_STATE,
  applyPivotFilters,
  summarizeFilters,
  type PivotFilterState,
} from '../components/review/PivotFilterBar'
import { exportPivotExcel, exportPivotTemplate } from '../utils/exportPivotToExcel'

export default function PivotPage() {
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

  // --- Filters ---
  const [filterState, setFilterState] = useState<PivotFilterState>(INITIAL_PIVOT_FILTER_STATE)
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)

  const filteredRows = useMemo(() => applyPivotFilters(rows, filterState), [rows, filterState])

  const activeFilterCount = Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0)

  // --- Dimension state (lifted from PivotView) ---
  const [rowDimension, setRowDimension] = useState('gl_description')
  const [colDimension, setColDimension] = useState('supplier_name')

  // --- Pivot data (shared with export) ---
  const pivotData = usePivotData(filteredRows, rowDimension, colDimension)

  // --- Filter summary for export ---
  const filterSummary = useMemo(() => summarizeFilters(filterState), [filterState])

  // --- Export handlers ---
  const handleExportExcel = () => {
    if (!pivotData) return
    exportPivotExcel({ pivotData, rowDimension, colDimension })
  }

  const handleExportTemplate = () => {
    if (!pivotData) return
    exportPivotTemplate({
      pivotData,
      rowDimension,
      colDimension,
      filterSummary,
      totalTransactions: rows.length,
      filteredTransactions: filteredRows.length,
    })
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
      {/* Single compact toolbar row */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
        {/* Left: Title + filter count */}
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-900">Pivot Analysis</h1>
          {activeFilterCount > 0 && (
            <span className="text-xs text-blue-600 bg-blue-50 rounded-full px-2.5 py-0.5 font-medium">
              {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()}
            </span>
          )}
        </div>

        {/* Right: Filter toggle + Export icons */}
        <div className="flex items-center gap-1.5">
          {/* Filter button */}
          <button
            onClick={() => setFilterPanelOpen(true)}
            className={`relative inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              activeFilterCount > 0
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
            title="Open filters"
          >
            <FunnelIcon className="h-3.5 w-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-blue-600 text-white text-[9px] h-4 min-w-[16px] px-1">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Divider */}
          <div className="w-px h-5 bg-gray-200 mx-0.5" />

          {/* Export Excel */}
          <button
            onClick={handleExportExcel}
            disabled={!pivotData}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export as Excel"
          >
            <ArrowDownTrayIcon className="h-3.5 w-3.5" />
            <span>.xlsx</span>
          </button>

          {/* Export Template */}
          <button
            onClick={handleExportTemplate}
            disabled={!pivotData}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export as formatted report"
          >
            <DocumentArrowDownIcon className="h-3.5 w-3.5" />
            <span>Report</span>
          </button>
        </div>
      </div>

      {/* Pivot table (takes remaining space) */}
      <div className="flex-1 min-h-0">
        <PivotView
          transactions={filteredRows}
          availableColumns={availableColumns}
          rowDimension={rowDimension}
          colDimension={colDimension}
          onRowDimensionChange={setRowDimension}
          onColDimensionChange={setColDimension}
        />
      </div>

      {/* Filter slide-over panel */}
      <PivotFilterBar
        rows={rows}
        filterState={filterState}
        onFilterStateChange={setFilterState}
        onClearAll={() => setFilterState(INITIAL_PIVOT_FILTER_STATE)}
        isOpen={filterPanelOpen}
        onToggle={() => setFilterPanelOpen(false)}
      />
    </div>
  )
}
