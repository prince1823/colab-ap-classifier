import { useState, useMemo } from 'react'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { useTransactions } from '../hooks/useTransactions'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import { usePivotData } from '../hooks/usePivotData'
import PivotView from '../components/review/PivotView'
import PivotFilterBar, {
  INITIAL_PIVOT_FILTER_STATE,
  applyPivotFilters,
  type PivotFilterState,
} from '../components/review/PivotFilterBar'
import { exportPivotExcel } from '../utils/exportPivotToExcel'

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

  const filteredRows = useMemo(() => applyPivotFilters(rows, filterState), [rows, filterState])

  const activeFilterCount = Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0)

  // --- Dimension state (lifted from PivotView) ---
  const [rowDimension, setRowDimension] = useState('gl_description')
  const [colDimension, setColDimension] = useState('supplier_name')

  // --- Pivot data (shared with export) ---
  const pivotData = usePivotData(filteredRows, rowDimension, colDimension)

  // --- Export handler ---
  const handleExportExcel = () => {
    if (!pivotData) return
    exportPivotExcel({ pivotData, rowDimension, colDimension })
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
      {/* Filter chips + export button in one row */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <PivotFilterBar
            rows={rows}
            filterState={filterState}
            onFilterStateChange={setFilterState}
            onClearAll={() => setFilterState(INITIAL_PIVOT_FILTER_STATE)}
          />
        </div>
        {activeFilterCount > 0 && (
          <span className="text-[10px] text-blue-600 bg-blue-50 rounded-full px-2 py-0.5 font-medium whitespace-nowrap flex-shrink-0">
            {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()}
          </span>
        )}
        <button
          onClick={handleExportExcel}
          disabled={!pivotData}
          className="inline-flex items-center gap-0.5 rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          title="Export as Excel"
        >
          <ArrowDownTrayIcon className="h-3 w-3" />
          <span>.xlsx</span>
        </button>
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
    </div>
  )
}
