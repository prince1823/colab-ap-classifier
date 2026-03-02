import React, { useState, useRef, useMemo } from 'react'
import { ChevronRight, ChevronDown, X } from 'lucide-react'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type Aggregation,
  type HierarchicalPivotData,
  type FlattenedPivotRow,
} from '../../hooks/useHierarchicalPivotData'
import { usePivotTreeState, filterRowsBySearch } from '../../hooks/usePivotTreeState'
import PivotToolbar from './PivotToolbar'
import type { PivotFilterState } from './PivotFilterBar'
import '../../styles/PivotHierarchy.css'

interface HierarchicalPivotViewProps {
  pivotData: HierarchicalPivotData | null
  transactions?: Record<string, unknown>[]
  availableColumns: string[]
  rowDimensions: string[]
  valueDimension: string
  aggregation: Aggregation
  onRowDimensionsChange: (dims: string[]) => void
  onValueDimensionChange: (dim: string) => void
  onAggregationChange: (agg: Aggregation) => void
  /* Filter props */
  allRows?: Record<string, unknown>[]
  filterOptions?: Record<string, string[]>
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  onClearAllFilters: () => void
  /* Export */
  onExport: () => void
  exportDisabled: boolean
  /* Open in Review */
  onOpenInReview: () => void
  openInReviewDisabled: boolean
  /* Total transaction count (server-side mode) */
  totalCount?: number
}

const COLUMN_LABELS: Record<string, string> = {
  classification_l1: 'L1',
  classification_l2: 'L2',
  classification_l3: 'L3',
  classification_l4: 'L4',
  supplier_name: 'Supplier',
  gl_description: 'GL Desc',
  line_description: 'Line Desc',
  company: 'Company',
  spend_amount: 'Spend',
  amount: 'Amount',
  invoice_amount: 'Invoice Amt',
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  costCenter: 'Cost Center',
  country: 'Country',
}

function colLabel(col: string): string {
  return COLUMN_LABELS[col] || col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const fmtAbbrev = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

const fmt = (n: number, agg: Aggregation) => {
  if (n === 0) return ''
  if (agg === 'count') return n.toLocaleString()
  return fmtAbbrev(n)
}

export default function HierarchicalPivotView({
  pivotData,
  transactions,
  availableColumns,
  rowDimensions,
  valueDimension,
  aggregation,
  onRowDimensionsChange,
  onValueDimensionChange,
  onAggregationChange,
  allRows,
  filterOptions,
  filterState,
  onFilterStateChange,
  onClearAllFilters,
  onExport,
  exportDisabled,
  onOpenInReview,
  openInReviewDisabled,
  totalCount,
}: HierarchicalPivotViewProps) {
  const [search, setSearch] = useState('')
  const [isAllExpanded, setIsAllExpanded] = useState(false)

  const { flatRows, toggleExpand, expandAll, collapseAll } = usePivotTreeState(
    pivotData?.root ?? null
  )

  const handleToggleExpandAll = () => {
    if (isAllExpanded) {
      collapseAll()
    } else {
      expandAll()
    }
    setIsAllExpanded(!isAllExpanded)
  }

  const visibleRows = useMemo(
    () => filterRowsBySearch(flatRows, search),
    [flatRows, search]
  )

  const scrollRef = useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 20,
  })

  const hasData = totalCount ? totalCount > 0 : (transactions?.length ?? 0) > 0
  const grandTotal = pivotData?.grandTotal ?? 0

  // Flatten active filters into pills
  const activeFilters = useMemo(() => {
    const pills: { col: string; value: string }[] = []
    for (const [col, values] of Object.entries(filterState)) {
      for (const value of values) {
        pills.push({ col, value })
      }
    }
    return pills
  }, [filterState])

  const removeFilter = (col: string, value: string) => {
    const current = filterState[col] || []
    const next = current.filter(v => v !== value)
    onFilterStateChange({ ...filterState, [col]: next })
  }

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Top row — filter pills (left) + search/export (right) */}
      <div className="h-6 flex-shrink-0 flex items-center gap-1.5">
        {/* Filter pills — scrollable left section */}
        <div className="flex items-center gap-1 flex-nowrap overflow-x-auto flex-1 min-w-0 h-full">
          {activeFilters.length > 0 && (
            <>
              <span className="text-[9px] font-semibold text-blue-600 flex-shrink-0">Filters:</span>
              {activeFilters.map(({ col, value }) => (
                <span
                  key={`${col}-${value}`}
                  className="inline-flex items-center gap-0.5 rounded-full bg-blue-50 border border-blue-200 pl-1.5 pr-0.5 py-px text-[9px] text-blue-700 font-medium flex-shrink-0"
                >
                  <span className="text-blue-400">{colLabel(col)}:</span>
                  <span className="truncate max-w-[100px]">{value}</span>
                  <button
                    onClick={() => removeFilter(col, value)}
                    className="rounded-full hover:bg-blue-100 p-px flex-shrink-0 transition-colors"
                  >
                    <X size={8} />
                  </button>
                </span>
              ))}
              <button
                onClick={onClearAllFilters}
                className="text-[9px] font-medium text-red-500 hover:text-red-600 flex-shrink-0 ml-0.5 transition-colors"
              >
                Clear all
              </button>
            </>
          )}
        </div>

        {/* Right section — search + export */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <div className="relative flex items-center">
            <input
              type="text"
              className="pivot-toolbar-search"
              placeholder="Search rows..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 120, fontSize: 10, padding: '1px 6px', height: 20 }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-1 rounded-full hover:bg-gray-100 p-px"
              >
                <X size={8} />
              </button>
            )}
          </div>
          <button
            onClick={onExport}
            disabled={exportDisabled || !hasData}
            className="inline-flex items-center gap-0.5 rounded border border-gray-300 bg-white px-1.5 py-px text-[10px] text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            title="Export as Excel"
            style={{ height: 20 }}
          >
            <ArrowDownTrayIcon className="h-2.5 w-2.5" />
            <span>.xlsx</span>
          </button>
        </div>
      </div>

      {/* Toolbar — always visible so user can adjust filters */}
      <PivotToolbar
        availableColumns={availableColumns}
        rowDimensions={rowDimensions}
        valueDimension={valueDimension}
        aggregation={aggregation}
        onRowDimensionsChange={onRowDimensionsChange}
        onValueDimensionChange={onValueDimensionChange}
        onAggregationChange={onAggregationChange}
        isAllExpanded={isAllExpanded}
        onToggleExpandAll={handleToggleExpandAll}
        onOpenInReview={onOpenInReview}
        openInReviewDisabled={openInReviewDisabled}
        rows={allRows}
        filterOptions={filterOptions}
        filterState={filterState}
        onFilterStateChange={onFilterStateChange}
        onClearAllFilters={onClearAllFilters}
      />

      {!hasData && (
        <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
          No transactions match the current filters.
        </div>
      )}

      {/* Table — only render when there's data */}
      {hasData && pivotData && <div
        ref={scrollRef}
        className="overflow-auto flex-1 border border-gray-200 rounded-lg"
        style={{ position: 'relative' }}
      >
        <table className="pivot-hierarchy-table" style={{ minWidth: '100%' }}>
          {/* Header */}
          <thead className="pivot-hierarchy-thead">
            <tr>
              <th>
                {rowDimensions
                  .map(d => {
                    const label =
                      d.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                    return label
                  })
                  .join(' > ')}
              </th>
              <th>Total</th>
            </tr>
          </thead>

          {/* Virtualized body */}
          <tbody>
            {rowVirtualizer.getVirtualItems().length > 0 && (
              <>
                {/* Spacer before */}
                {rowVirtualizer.getVirtualItems()[0].start > 0 && (
                  <tr>
                    <td
                      colSpan={2}
                      style={{ height: rowVirtualizer.getVirtualItems()[0].start, padding: 0, border: 'none' }}
                    />
                  </tr>
                )}

                {rowVirtualizer.getVirtualItems().map(virtualRow => {
                  const row = visibleRows[virtualRow.index]
                  return (
                    <PivotTreeRow
                      key={row.key}
                      row={row}
                      aggregation={aggregation}
                      onToggle={toggleExpand}
                      rowDimensions={rowDimensions}
                      filterState={filterState}
                      onFilterStateChange={onFilterStateChange}
                    />
                  )
                })}

                {/* Spacer after */}
                {(() => {
                  const items = rowVirtualizer.getVirtualItems()
                  const lastItem = items[items.length - 1]
                  const afterSpace = rowVirtualizer.getTotalSize() - (lastItem.start + lastItem.size)
                  return afterSpace > 0 ? (
                    <tr>
                      <td
                        colSpan={2}
                        style={{ height: afterSpace, padding: 0, border: 'none' }}
                      />
                    </tr>
                  ) : null
                })()}
              </>
            )}
          </tbody>

          {/* Footer */}
          <tfoot className="pivot-hierarchy-tfoot">
            <tr>
              <td>Grand Total</td>
              <td>{fmt(grandTotal, aggregation)}</td>
            </tr>
          </tfoot>
        </table>
      </div>}
    </div>
  )
}

/** Single tree row */
function PivotTreeRow({
  row,
  aggregation,
  onToggle,
  rowDimensions,
  filterState,
  onFilterStateChange,
}: {
  row: FlattenedPivotRow
  aggregation: Aggregation
  onToggle: (key: string) => void
  rowDimensions: string[]
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
}) {
  const indent = row.depth * 20

  const groupBorderClass = row.isFirstInL1Group
    ? 'pivot-tree-row-group-start'
    : row.isFirstInL2Group
      ? 'pivot-tree-row-subgroup-start'
      : ''

  return (
    <tr
      className={`pivot-tree-row ${groupBorderClass}`}
      data-depth={row.depth}
    >
      {/* Label cell */}
      <td
        className="pivot-tree-label-cell"
        style={{
          paddingLeft: 10 + indent,
        }}
      >
        {row.hasChildren ? (
          <span
            className="pivot-tree-chevron"
            onClick={() => onToggle(row.key)}
          >
            {row.isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="pivot-tree-chevron-placeholder" />
        )}
        <span
          className="pivot-tree-label"
          title={row.label}
          onDoubleClick={() => {
            const dim = rowDimensions[row.depth]
            if (!dim) return
            const current = filterState[dim] || []
            const next = current.includes(row.label)
              ? current.filter(v => v !== row.label)
              : [...current, row.label]
            onFilterStateChange({ ...filterState, [dim]: next })
          }}
          style={{ cursor: 'default' }}
        >
          {row.label}
        </span>
        {row.hasChildren && (
          <span className="pivot-tree-count">({row.transactionCount})</span>
        )}
      </td>

      {/* Row total — show at every level */}
      <td className="pivot-tree-total-cell">
        {fmt(row.total, aggregation)}
      </td>
    </tr>
  )
}
