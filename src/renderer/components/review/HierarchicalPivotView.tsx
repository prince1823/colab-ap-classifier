import React, { useState, useRef, useMemo } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
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
  transactions: Record<string, unknown>[]
  availableColumns: string[]
  rowDimensions: string[]
  valueDimension: string
  aggregation: Aggregation
  onRowDimensionsChange: (dims: string[]) => void
  onValueDimensionChange: (dim: string) => void
  onAggregationChange: (agg: Aggregation) => void
  /* Filter props */
  allRows: Record<string, unknown>[]
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  onClearAllFilters: () => void
  /* Export */
  onExport: () => void
  exportDisabled: boolean
  /* Open in Review */
  onOpenInReview: () => void
  openInReviewDisabled: boolean
}

const fmt = (n: number, agg: Aggregation) => {
  if (n === 0) return ''
  if (agg === 'count') return n.toLocaleString()
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
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
  filterState,
  onFilterStateChange,
  onClearAllFilters,
  onExport,
  exportDisabled,
  onOpenInReview,
  openInReviewDisabled,
}: HierarchicalPivotViewProps) {
  const [search, setSearch] = useState('')

  const { flatRows, toggleExpand, expandAll, collapseAll } = usePivotTreeState(
    pivotData?.root ?? null
  )

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

  const hasData = transactions.length > 0
  const grandTotal = pivotData?.grandTotal ?? 0

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Toolbar — always visible so user can adjust filters */}
      <PivotToolbar
        availableColumns={availableColumns}
        rowDimensions={rowDimensions}
        valueDimension={valueDimension}
        aggregation={aggregation}
        search={search}
        onRowDimensionsChange={onRowDimensionsChange}
        onValueDimensionChange={onValueDimensionChange}
        onAggregationChange={onAggregationChange}
        onSearchChange={setSearch}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        rows={allRows}
        filterState={filterState}
        onFilterStateChange={onFilterStateChange}
        onClearAllFilters={onClearAllFilters}
        onExport={onExport}
        exportDisabled={exportDisabled || !hasData}
        onOpenInReview={onOpenInReview}
        openInReviewDisabled={openInReviewDisabled}
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
