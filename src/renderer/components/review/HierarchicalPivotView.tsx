import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ChevronDown, X } from 'lucide-react'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Aggregation, HierarchicalPivotData, FlattenedPivotRow, SpendDisplayMode } from '../../types/pivot'
import { usePivotTreeState, filterRowsBySearch } from '../../hooks/usePivotTreeState'
import { usePivotKeyboard } from '../../hooks/usePivotKeyboard'
import PivotToolbar from './PivotToolbar'
import type { PivotFilterState } from './PivotFilterBar'
import { fmtAbbrev } from '../../utils/formatSpend'
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
  /* Total transaction count (server-side mode) */
  totalCount?: number
  /* Spend display */
  spendDisplayMode: SpendDisplayMode
  onSpendDisplayModeChange: (mode: SpendDisplayMode) => void
  /* Reclassify */
  onReclassify?: (rows: FlattenedPivotRow[]) => void
  /* Drill-down */
  onDrillDown?: (row: FlattenedPivotRow) => void
  /** Whether a modal is open (suppresses keyboard) */
  modalOpen?: boolean
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

const fmtAbsolute = (n: number, agg: Aggregation) => {
  if (n === 0) return ''
  if (agg === 'count') return n.toLocaleString()
  return fmtAbbrev(n)
}

function displayValue(col: string, value: string): string {
  if (col === 'classification_path' && value.includes('|')) {
    return value.split('|').map(p => p.trim()).filter(Boolean).pop() || value
  }
  return value
}

/** Grouped filter chip: "Label: first_value  +N" with dropdown */
function FilterGroupChip({
  col,
  label,
  values,
  onRemove,
}: {
  col: string
  label: string
  values: string[]
  onRemove: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const chipRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  // Position dropdown below the chip using fixed positioning (escapes overflow clipping)
  useEffect(() => {
    if (!open || !chipRef.current) return
    const rect = chipRef.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        chipRef.current && !chipRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const first = displayValue(col, values[0])
  const rest = values.length - 1

  return (
    <div ref={chipRef} className="flex-shrink-0">
      <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-50 border border-blue-200 pl-1.5 pr-1 py-px text-[9px] text-blue-700 font-medium">
        <span className="text-blue-400">{label}:</span>
        <span className="truncate max-w-[100px]">{first}</span>
        {values.length === 1 && (
          <button
            onClick={() => onRemove(values[0])}
            className="rounded-full hover:bg-blue-100 p-px flex-shrink-0 transition-colors"
          >
            <X size={8} />
          </button>
        )}
        {rest > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
            className="rounded bg-blue-200/60 hover:bg-blue-200 text-blue-600 px-1 py-px text-[8px] font-semibold ml-0.5 transition-colors"
          >
            +{rest}
          </button>
        )}
      </span>

      {/* Portal dropdown — escapes overflow:auto clipping */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] min-w-[180px] max-w-[260px] rounded-lg border border-gray-200 bg-white shadow-lg py-1"
          style={{ top: pos.top, left: pos.left }}
        >
          {values.map((value) => (
            <div
              key={value}
              className="flex items-center justify-between gap-2 px-2.5 py-1 text-[10px] text-gray-700 hover:bg-gray-50"
            >
              <span className="truncate">{displayValue(col, value)}</span>
              <button
                onClick={() => onRemove(value)}
                className="rounded-full hover:bg-red-100 text-gray-400 hover:text-red-500 p-0.5 flex-shrink-0 transition-colors"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
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
  totalCount,
  spendDisplayMode,
  onSpendDisplayModeChange,
  onReclassify,
  onDrillDown,
  modalOpen = false,
}: HierarchicalPivotViewProps) {
  const [search, setSearch] = useState('')
  const [collapseLevel, setCollapseLevel] = useState(rowDimensions.length) // start fully expanded

  const { flatRows, allFlatRows, toggleExpand, expandToLevel, depth0TotalMap } = usePivotTreeState(
    pivotData?.root ?? null
  )

  // When searching, use allFlatRows (ignores expand/collapse) so collapsed children are found.
  // When not searching, use flatRows (respects expand/collapse state).
  const visibleRows = useMemo(
    () => search.trim() ? filterRowsBySearch(allFlatRows, search) : flatRows,
    [flatRows, allFlatRows, search]
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevModalOpenRef = useRef(modalOpen)

  // Auto-focus the table on mount so keyboard navigation works immediately
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.focus()
    }
  }, [pivotData])

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 20,
    scrollPaddingStart: 40,
    scrollPaddingEnd: 40,
  })

  // Keyboard navigation
  const handleCmdK = useMemo(() => (rows: FlattenedPivotRow[]) => {
    // OR filter: use each row's deepest (most specific) dimension value.
    // Values in the same dimension are OR'd via in_list.
    const newFilter: PivotFilterState = { ...filterState }
    for (const row of rows) {
      const deepest = row.pathSegments[row.pathSegments.length - 1]
      if (!deepest) continue
      const current = newFilter[deepest.dimensionField] || []
      if (!current.includes(deepest.value)) {
        newFilter[deepest.dimensionField] = [...current, deepest.value]
      }
    }
    onFilterStateChange(newFilter)
  }, [filterState, onFilterStateChange])

  const handleCmdF = useMemo(() => (rows: FlattenedPivotRow[]) => {
    if (rows.length === 0) return  // no explicit selection → don't open
    onReclassify?.(rows)
  }, [onReclassify])

  const { focusedIndex, selectedKeys, handleKeyDown, clearSelection } = usePivotKeyboard({
    visibleRows,
    rowVirtualizer,
    onCmdK: handleCmdK,
    onCmdF: handleCmdF,
    onToggleExpand: toggleExpand,
    onClearAllFilters,
    disabled: modalOpen,
  })

  // When modal closes: clear selection and restore keyboard focus to table
  useEffect(() => {
    if (prevModalOpenRef.current && !modalOpen) {
      clearSelection()
      requestAnimationFrame(() => scrollRef.current?.focus())
    }
    prevModalOpenRef.current = modalOpen
  }, [modalOpen, clearSelection])

  // Cycle expand/collapse
  const maxDepth = rowDimensions.length
  const handleCycleCollapse = () => {
    const nextLevel = collapseLevel >= maxDepth ? 0 : collapseLevel + 1
    setCollapseLevel(nextLevel)
    expandToLevel(nextLevel)
  }
  const cycleLabelMap = (level: number) => {
    if (level >= maxDepth) return 'All'
    const dim = rowDimensions[level]
    return dim ? colLabel(dim) : `D${level + 1}`
  }

  const hasData = totalCount ? totalCount > 0 : (transactions?.length ?? 0) > 0
  const grandTotal = pivotData?.grandTotal ?? 0

  // Format spend value based on display mode
  const fmtSpend = (row: FlattenedPivotRow) => {
    if (row.total === 0) return ''
    if (aggregation === 'count') return row.total.toLocaleString()
    if (spendDisplayMode === 'percentage' && aggregation === 'sum') {
      if (row.depth === 0) return '100%'
      const base = depth0TotalMap.get(row.depth0AncestorKey) ?? 0
      if (base === 0) return '--'
      return ((row.total / base) * 100).toFixed(1) + '%'
    }
    return fmtAbbrev(row.total)
  }

  // Group active filters by column
  const groupedFilters = useMemo(() => {
    const groups: { col: string; values: string[] }[] = []
    for (const [col, values] of Object.entries(filterState)) {
      if (values.length > 0) {
        groups.push({ col, values })
      }
    }
    return groups
  }, [filterState])

  const totalFilterCount = groupedFilters.reduce((sum, g) => sum + g.values.length, 0)

  const refocusTable = () => {
    requestAnimationFrame(() => scrollRef.current?.focus())
  }

  const removeFilter = (col: string, value: string) => {
    const current = filterState[col] || []
    const next = current.filter(v => v !== value)
    onFilterStateChange({ ...filterState, [col]: next })
    refocusTable()
  }

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Top row — filter pills (left) + search/export (right) */}
      <div className="h-6 flex-shrink-0 flex items-center gap-1.5">
        {/* Filter pills — grouped by column */}
        <div className="flex items-center gap-1 flex-nowrap overflow-x-auto flex-1 min-w-0 h-full">
          {totalFilterCount > 0 && (
            <>
              <span className="text-[9px] font-semibold text-blue-600 flex-shrink-0">Filters:</span>
              {groupedFilters.map(({ col, values }) => (
                <FilterGroupChip
                  key={col}
                  col={col}
                  label={colLabel(col)}
                  values={values}
                  onRemove={(value) => removeFilter(col, value)}
                />
              ))}
              <button
                onClick={() => { onClearAllFilters(); refocusTable() }}
                className="text-[9px] font-medium text-red-500 hover:text-red-600 flex-shrink-0 ml-0.5 transition-colors"
              >
                Clear all
              </button>
            </>
          )}
          {/* Selection indicator */}
          {selectedKeys.size > 0 && (
            <span className="inline-flex items-center gap-1 text-[9px] font-medium text-indigo-600 flex-shrink-0 ml-1">
              {selectedKeys.size} selected
              <button onClick={clearSelection} className="hover:text-indigo-800">
                <X size={8} />
              </button>
              <kbd className="text-[8px] bg-gray-100 border border-gray-300 rounded px-0.5">⌘K</kbd>
              <span className="text-gray-400">filter</span>
              <kbd className="text-[8px] bg-gray-100 border border-gray-300 rounded px-0.5">⌘F</kbd>
              <span className="text-gray-400">classify</span>
            </span>
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
                onClick={() => { setSearch(''); refocusTable() }}
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
            title="Export CSV"
            style={{ height: 20 }}
          >
            <ArrowDownTrayIcon className="h-2.5 w-2.5" />
            <span>CSV</span>
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
        collapseLevel={collapseLevel}
        onCycleCollapse={handleCycleCollapse}
        cycleLevelLabel={cycleLabelMap(collapseLevel)}
        rows={allRows}
        filterOptions={filterOptions}
        filterState={filterState}
        onFilterStateChange={onFilterStateChange}
        onClearAllFilters={onClearAllFilters}
        spendDisplayMode={spendDisplayMode}
        onSpendDisplayModeChange={onSpendDisplayModeChange}
        showSpendToggle={aggregation === 'sum'}
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
        style={{ position: 'relative', outline: 'none', scrollPaddingBottom: 40, scrollPaddingTop: 40 }}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          // Auto-reclaim focus unless it moved to an interactive element or a modal is open
          const target = e.relatedTarget as HTMLElement | null
          const tag = target?.tagName
          if (modalOpen || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return
          requestAnimationFrame(() => scrollRef.current?.focus())
        }}
        role="grid"
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
              <th>{spendDisplayMode === 'percentage' && aggregation === 'sum' ? '% of Total' : 'Total'}</th>
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
                      isFocused={virtualRow.index === focusedIndex}
                      isSelected={selectedKeys.has(row.key)}
                      formattedTotal={fmtSpend(row)}
                      onDrillDown={onDrillDown}
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
              <td>{spendDisplayMode === 'percentage' && aggregation === 'sum' ? '' : fmtAbsolute(grandTotal, aggregation)}</td>
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
  isFocused,
  isSelected,
  formattedTotal,
  onDrillDown,
}: {
  row: FlattenedPivotRow
  aggregation: Aggregation
  onToggle: (key: string) => void
  rowDimensions: string[]
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  isFocused: boolean
  isSelected: boolean
  formattedTotal: string
  onDrillDown?: (row: FlattenedPivotRow) => void
}) {
  const indent = row.depth * 20

  const groupBorderClass = row.isFirstInL1Group
    ? 'pivot-tree-row-group-start'
    : row.isFirstInL2Group
      ? 'pivot-tree-row-subgroup-start'
      : ''

  return (
    <tr
      className={`pivot-tree-row group/row ${groupBorderClass}`}
      data-depth={row.depth}
      data-focused={isFocused || undefined}
      data-selected={isSelected || undefined}
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
        {row.isLeaf && onDrillDown && (
          <button
            className="pivot-tree-drilldown ml-1 opacity-0 group-hover/row:opacity-100 text-gray-400 hover:text-blue-600 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onDrillDown(row) }}
            title="View transactions"
          >
            <ChevronRight size={12} />
          </button>
        )}
      </td>

      {/* Row total — show at every level */}
      <td className="pivot-tree-total-cell">
        {formattedTotal}
      </td>
    </tr>
  )
}
