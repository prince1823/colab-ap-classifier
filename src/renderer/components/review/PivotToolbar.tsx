import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Plus, X, ChevronUp, ChevronDown, Filter, Layers } from 'lucide-react'
import { useDrag, useDrop } from 'react-dnd'
import * as Popover from '@radix-ui/react-popover'
import type { Aggregation, SpendDisplayMode } from '../../types/pivot'
import type { PivotFilterState } from './PivotFilterBar'
import '../../styles/PivotHierarchy.css'

const PIVOT_DIM_TYPE = 'PIVOT_DIM'

// Human-readable labels for common columns
const COLUMN_LABELS: Record<string, string> = {
  classification_l1: 'Classification L1',
  classification_l2: 'Classification L2',
  classification_l3: 'Classification L3',
  classification_l4: 'Classification L4',
  supplier_name: 'Supplier',
  gl_description: 'GL Description',
  line_description: 'Line Description',
  company: 'Company',
  spend_amount: 'Spend Amount',
  amount: 'Amount',
  invoice_amount: 'Invoice Amount',
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  costCenter: 'Cost Center',
  country: 'Country',
}

function colLabel(col: string): string {
  return COLUMN_LABELS[col] || col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

interface PivotToolbarProps {
  availableColumns: string[]
  rowDimensions: string[]
  valueDimension: string
  aggregation: Aggregation
  onRowDimensionsChange: (dims: string[]) => void
  onValueDimensionChange: (dim: string) => void
  onAggregationChange: (agg: Aggregation) => void
  /* Expand/collapse cycle */
  collapseLevel: number
  onCycleCollapse: () => void
  cycleLevelLabel: string
  /* Filter props */
  rows?: Record<string, unknown>[]
  filterOptions?: Record<string, string[]>
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  onClearAllFilters: () => void
  /* Spend display toggle */
  spendDisplayMode: SpendDisplayMode
  onSpendDisplayModeChange: (mode: SpendDisplayMode) => void
  showSpendToggle: boolean
  /* Advanced filter */
  advancedFilterCount?: number
  onOpenAdvancedFilter?: () => void
}

/** Columns to exclude from the filter list (non-filterable) */
const FILTER_EXCLUDE = new Set([
  'id', 'row_index', 'taxonomy_node_id',
  'classification_status', 'spend_amount', 'amount', 'invoice_amount',
])

export default function PivotToolbar({
  availableColumns,
  rowDimensions,
  valueDimension,
  aggregation,
  onRowDimensionsChange,
  onValueDimensionChange,
  onAggregationChange,
  collapseLevel,
  onCycleCollapse,
  cycleLevelLabel,
  rows,
  filterOptions: filterOptionsProp,
  filterState,
  onFilterStateChange,
  onClearAllFilters,
  spendDisplayMode,
  onSpendDisplayModeChange,
  showSpendToggle,
  advancedFilterCount = 0,
  onOpenAdvancedFilter,
}: PivotToolbarProps) {
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [addMenuSearch, setAddMenuSearch] = useState('')
  const [showOverflow, setShowOverflow] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)

  // Use pre-fetched filter options when available, otherwise compute from rows
  const filterOptions = useMemo(() => {
    if (filterOptionsProp) return filterOptionsProp
    if (!rows) return {} as Record<string, string[]>
    const opts: Record<string, string[]> = {}
    for (const dim of rowDimensions) {
      if (FILTER_EXCLUDE.has(dim)) continue
      const vals = new Set<string>()
      for (const row of rows) {
        const v = row[dim]
        if (v !== null && v !== undefined && v !== '') {
          const s = String(v).trim()
          if (s) vals.add(s)
        }
      }
      opts[dim] = [...vals].sort().slice(0, 200)
    }
    return opts
  }, [filterOptionsProp, rows, rowDimensions])

  const toggleFilterOption = (col: string, value: string) => {
    const current = filterState[col] || []
    const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value]
    onFilterStateChange({ ...filterState, [col]: next })
  }

  const clearColumnFilter = (col: string) => {
    const next = { ...filterState }
    delete next[col]
    onFilterStateChange(next)
  }

  const activeFilterCount = Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0)

  useEffect(() => {
    if (!showAddMenu && !showOverflow) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      // Ignore clicks inside Radix popover portals (filter popovers render outside the overflow ref)
      const popoverContent = (target as Element).closest?.('[data-radix-popper-content-wrapper]')
      if (popoverContent) return

      if (showAddMenu && addMenuRef.current && !addMenuRef.current.contains(target)) {
        setShowAddMenu(false)
        setAddMenuSearch('')
      }
      if (showOverflow && overflowRef.current && !overflowRef.current.contains(target)) {
        setShowOverflow(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showAddMenu, showOverflow])

  // Columns available to add as row dimensions (not already selected)
  const availableForRows = availableColumns.filter(
    c => !rowDimensions.includes(c)
  )

  // Numeric columns for value selector
  const numericColumns = availableColumns.filter(c =>
    ['spend_amount', 'amount', 'invoice_amount'].includes(c)
  )
  if (numericColumns.length === 0) numericColumns.push('spend_amount')

  const removeRowDim = (idx: number) => {
    const next = [...rowDimensions]
    next.splice(idx, 1)
    onRowDimensionsChange(next)
  }

  const moveDim = useCallback((fromIndex: number, toIndex: number) => {
    const next = [...rowDimensions]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    onRowDimensionsChange(next)
  }, [rowDimensions, onRowDimensionsChange])

  const moveRowDim = (idx: number, direction: 'up' | 'down') => {
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= rowDimensions.length) return
    const next = [...rowDimensions]
    ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
    onRowDimensionsChange(next)
  }

  const MAX_ROW_DIMS = 6

  const addRowDim = (col: string) => {
    if (rowDimensions.length >= MAX_ROW_DIMS) return
    onRowDimensionsChange([...rowDimensions, col])
    setShowAddMenu(false)
  }

  /** Render a single dimension chip — clicking label or filter icon opens filter */
  const renderDimChip = (dim: string, idx: number) => {
    const colFilterCount = (filterState[dim] || []).length
    const options = filterOptions[dim] || []
    const isFilterable = options.length > 0

    return (
      <DimFilterChip
        key={dim}
        dim={dim}
        label={colLabel(dim)}
        isFilterable={isFilterable}
        options={options}
        selected={filterState[dim] || []}
        activeCount={colFilterCount}
        onToggle={(val) => toggleFilterOption(dim, val)}
        onClear={() => clearColumnFilter(dim)}
        showRemove={rowDimensions.length > 1}
        onRemove={() => removeRowDim(idx)}
      />
    )
  }

  return (
    <div className="pivot-toolbar">
      {/* Pivot dimensions — shown as arrow-separated path */}
      <div className="pivot-toolbar-section">
        <span className="pivot-toolbar-label">Pivot:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {rowDimensions.length === 0 && (
            <span style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic' }}>Add pivot dimensions with +</span>
          )}
          {rowDimensions.slice(0, 3).map((dim, idx) => (
            <React.Fragment key={dim}>
              {idx > 0 && (
                <span style={{ fontSize: 9, color: '#9ca3af', margin: '0 1px', userSelect: 'none' }}>→</span>
              )}
              <DraggableDimChip
                dim={dim}
                index={idx}
                label={colLabel(dim)}
                onMove={moveDim}
                onRemove={() => removeRowDim(idx)}
              />
            </React.Fragment>
          ))}
          {/* Overflow: +N more button with dropdown */}
          {rowDimensions.length > 3 && (
            <React.Fragment>
              <span style={{ fontSize: 9, color: '#9ca3af', margin: '0 1px', userSelect: 'none' }}>→</span>
              <div ref={overflowRef} style={{ position: 'relative', display: 'inline-flex' }}>
                <button
                  className="pivot-dim-chip"
                  style={{ cursor: 'pointer', fontSize: 10, color: 'var(--primary-color)', borderColor: 'var(--primary-color)', background: 'rgba(59,130,246,0.06)' }}
                  onClick={() => setShowOverflow(!showOverflow)}
                >
                  +{rowDimensions.length - 3} more
                </button>
                {showOverflow && (
                  <div className="pivot-add-field-menu" style={{ minWidth: 220 }}>
                    {rowDimensions.slice(3).map((dim, i) => {
                      const realIdx = i + 3
                      return (
                        <DraggableOverflowRow
                          key={dim}
                          dim={dim}
                          index={realIdx}
                          label={colLabel(dim)}
                          onMove={moveDim}
                          onRemove={() => removeRowDim(realIdx)}
                          onDragEnd={() => setShowOverflow(false)}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            </React.Fragment>
          )}
        </div>
        {/* Add field button */}
        {availableForRows.length > 0 && rowDimensions.length < MAX_ROW_DIMS && (
          <div ref={addMenuRef} style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              className="pivot-add-field-btn"
              onClick={() => setShowAddMenu(!showAddMenu)}
            >
              <Plus size={10} />
            </button>
            {showAddMenu && (() => {
              const filtered = addMenuSearch
                ? availableForRows.filter(col =>
                    colLabel(col).toLowerCase().includes(addMenuSearch.toLowerCase())
                  )
                : availableForRows
              return (
                <div className="pivot-add-field-menu" style={{ minWidth: 200, maxHeight: 280 }}>
                  <div style={{ padding: '4px 6px', position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 1 }}>
                    <input
                      type="text"
                      className="pivot-toolbar-search"
                      placeholder="Filter columns..."
                      value={addMenuSearch}
                      onChange={e => setAddMenuSearch(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                      style={{ width: '100%' }}
                    />
                  </div>
                  {filtered.map(col => (
                    <div
                      key={col}
                      className="pivot-add-field-item"
                      onClick={() => {
                        addRowDim(col)
                        setAddMenuSearch('')
                      }}
                    >
                      {colLabel(col)}
                    </div>
                  ))}
                  {filtered.length === 0 && (
                    <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--text-light)' }}>
                      No matching columns
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
        {/* Clear all filters */}
        {activeFilterCount > 0 && (
          <button
            onClick={onClearAllFilters}
            className="pivot-dim-chip-x"
            title="Clear all filters"
            style={{ opacity: 1, padding: '1px 3px', marginLeft: 2, color: '#ef4444' }}
          >
            <X size={9} />
            <span style={{ fontSize: 10, marginLeft: 1 }}>Filters</span>
          </button>
        )}
      </div>

      {/* Value + Aggregation + Spend toggle */}
      <div className="pivot-toolbar-section">
        <span className="pivot-toolbar-label">Value:</span>
        <select
          className="pivot-toolbar-select"
          value={valueDimension}
          onChange={e => onValueDimensionChange(e.target.value)}
        >
          {numericColumns.map(col => (
            <option key={col} value={col}>{colLabel(col)}</option>
          ))}
        </select>
        <select
          className="pivot-toolbar-select"
          value={aggregation}
          onChange={e => onAggregationChange(e.target.value as Aggregation)}
          style={{ width: 60 }}
        >
          <option value="sum">Sum</option>
          <option value="count">Count</option>
          <option value="average">Avg</option>
        </select>
        {showSpendToggle && (
          <button
            className="pivot-toolbar-icon-btn"
            onClick={() => onSpendDisplayModeChange(spendDisplayMode === 'absolute' ? 'percentage' : 'absolute')}
            title={spendDisplayMode === 'absolute' ? 'Show as percentage of top-level total' : 'Show absolute values'}
            data-active={spendDisplayMode === 'percentage' ? '' : undefined}
          >
            <span style={{ fontSize: 11, fontWeight: 600, minWidth: 14, textAlign: 'center' }}>
              {spendDisplayMode === 'absolute' ? '$' : '%'}
            </span>
          </button>
        )}
        {onOpenAdvancedFilter && (
          <button
            className="pivot-toolbar-icon-btn"
            onClick={onOpenAdvancedFilter}
            title="Advanced filters"
            data-active={advancedFilterCount > 0 ? '' : undefined}
            style={{ position: 'relative' }}
          >
            <Filter size={12} />
            {advancedFilterCount > 0 && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                background: '#3b82f6', color: '#fff',
                fontSize: 8, fontWeight: 700,
                width: 14, height: 14,
                borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {advancedFilterCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Collapse cycle + Review — right side */}
      <div className="flex items-center gap-1" style={{ marginLeft: 'auto' }}>
        <button
          className="pivot-toolbar-icon-btn"
          onClick={onCycleCollapse}
          title={`Showing: ${cycleLevelLabel}. Click to cycle collapse level.`}
        >
          <Layers size={12} />
          <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 2 }}>{cycleLevelLabel}</span>
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* DimFilterChip — whole chip is clickable to open filter popover      */
/* ------------------------------------------------------------------ */

function DimFilterChip({
  dim,
  label,
  isFilterable,
  options,
  selected,
  activeCount,
  onToggle,
  onClear,
  showRemove,
  onRemove,
}: {
  dim: string
  label: string
  isFilterable: boolean
  options: string[]
  selected: string[]
  activeCount: number
  onToggle: (value: string) => void
  onClear: () => void
  showRemove: boolean
  onRemove: () => void
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  if (!isFilterable) {
    // Non-filterable chip — just label + remove
    return (
      <span className="pivot-dim-chip">
        <span>{label}</span>
        {showRemove && (
          <button className="pivot-dim-chip-x" onClick={onRemove} title="Remove">
            <X size={9} />
          </button>
        )}
      </span>
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <span className="pivot-dim-chip" data-filterable>
        <Popover.Trigger asChild>
          <button className="pivot-dim-chip-trigger" title={`Filter ${label}`}>
            <span>{label}</span>
            <Filter size={9} className="pivot-dim-chip-filter-icon" data-active={activeCount > 0 ? '' : undefined} />
            {activeCount > 0 && (
              <span className="pivot-dim-filter-badge">{activeCount}</span>
            )}
          </button>
        </Popover.Trigger>
        {showRemove && (
          <button className="pivot-dim-chip-x" onClick={onRemove} title="Remove">
            <X size={9} />
          </button>
        )}
      </span>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          align="start"
          collisionPadding={8}
          className="z-50 w-64 rounded-lg border border-gray-200 bg-white shadow-lg"
          onPointerDownOutside={(e) => {
            const target = e.detail.originalEvent.target as Element
            if (target?.closest?.('[data-radix-popper-content-wrapper]')) e.preventDefault()
          }}
        >
          <div className="p-2">
            {options.length > 6 && (
              <input
                type="text"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-[11px] mb-2 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                autoFocus
              />
            )}
            <div className="max-h-[250px] overflow-y-auto space-y-0.5">
              {filtered.map((option) => {
                const isSelected = selected.includes(option)
                return (
                  <label
                    key={option}
                    className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggle(option)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3 w-3"
                    />
                    <span className="truncate">{option}</span>
                  </label>
                )
              })}
              {filtered.length === 0 && (
                <p className="text-[11px] text-gray-400 py-2 text-center">No matches</p>
              )}
            </div>
            {activeCount > 0 && (
              <button
                onClick={onClear}
                className="mt-1.5 text-[10px] text-red-500 hover:text-red-600 font-medium"
              >
                Clear filter
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/* ------------------------------------------------------------------ */
/* DraggableDimChip — drag-and-drop reorderable dimension chip         */
/* ------------------------------------------------------------------ */

function DraggableDimChip({
  dim,
  index,
  label,
  onMove,
  onRemove,
}: {
  dim: string
  index: number
  label: string
  onMove: (fromIndex: number, toIndex: number) => void
  onRemove: () => void
}) {
  const chipRef = useRef<HTMLSpanElement>(null)

  const [{ isDragging }, drag] = useDrag({
    type: PIVOT_DIM_TYPE,
    item: () => ({ index }),
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  })

  const [{ isOver }, drop] = useDrop({
    accept: PIVOT_DIM_TYPE,
    hover: (item: { index: number }) => {
      if (item.index === index) return
      onMove(item.index, index)
      item.index = index
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  })

  drag(drop(chipRef))

  return (
    <span
      ref={chipRef}
      className="pivot-dim-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'grab',
        opacity: isDragging ? 0.4 : 1,
        background: isOver ? 'rgba(59,130,246,0.08)' : undefined,
        transition: 'opacity 0.15s, background 0.15s',
      }}
    >
      <span style={{ fontSize: 10 }}>{label}</span>
      <button
        className="pivot-dim-chip-x"
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        title="Remove"
      >
        <X size={9} />
      </button>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* DraggableOverflowRow — drag-and-drop row in the overflow dropdown   */
/* ------------------------------------------------------------------ */

function DraggableOverflowRow({
  dim,
  index,
  label,
  onMove,
  onRemove,
  onDragEnd,
}: {
  dim: string
  index: number
  label: string
  onMove: (fromIndex: number, toIndex: number) => void
  onRemove: () => void
  onDragEnd?: () => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)

  const [{ isDragging }, drag] = useDrag({
    type: PIVOT_DIM_TYPE,
    item: () => ({ index }),
    end: () => {
      onDragEnd?.()
    },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  })

  const [{ isOver }, drop] = useDrop({
    accept: PIVOT_DIM_TYPE,
    hover: (item: { index: number }) => {
      if (item.index === index) return
      onMove(item.index, index)
      item.index = index
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  })

  drag(drop(rowRef))

  return (
    <div
      ref={rowRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 8px',
        fontSize: 11,
        cursor: 'grab',
        opacity: isDragging ? 0.4 : 1,
        background: isOver ? 'rgba(59,130,246,0.08)' : undefined,
        borderRadius: 4,
        transition: 'opacity 0.15s, background 0.15s',
      }}
    >
      <span style={{ flex: 1 }}>⠿ {label}</span>
      <button
        className="pivot-dim-chip-x"
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Remove"
        style={{ opacity: 0.7, cursor: 'pointer', padding: '2px 4px', borderRadius: 3 }}
      >
        <X size={9} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* OverflowFilterBtn — filter icon for overflow list items             */
/* ------------------------------------------------------------------ */

function OverflowFilterBtn({
  column,
  label,
  showLabel,
  options,
  selected,
  onToggle,
  onClear,
  activeCount,
}: {
  column: string
  label: string
  showLabel?: boolean
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
  activeCount: number
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <Popover.Trigger asChild>
        <button
          className={showLabel ? 'pivot-dim-chip-trigger' : 'pivot-dim-filter-btn'}
          title={`Filter ${label}`}
          data-active={activeCount > 0 ? '' : undefined}
          style={showLabel ? { flex: 1, justifyContent: 'flex-start' } : undefined}
        >
          {showLabel && <span>{label}</span>}
          <Filter size={9} className={showLabel ? 'pivot-dim-chip-filter-icon' : undefined} data-active={activeCount > 0 ? '' : undefined} />
          {activeCount > 0 && (
            <span className="pivot-dim-filter-badge">{activeCount}</span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          align="start"
          collisionPadding={8}
          className="z-50 w-64 rounded-lg border border-gray-200 bg-white shadow-lg"
          onPointerDownOutside={(e) => {
            const target = e.detail.originalEvent.target as Element
            if (target?.closest?.('[data-radix-popper-content-wrapper]')) e.preventDefault()
          }}
        >
          <div className="p-2">
            {options.length > 6 && (
              <input
                type="text"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-[11px] mb-2 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                autoFocus
              />
            )}
            <div className="max-h-[250px] overflow-y-auto space-y-0.5">
              {filtered.map((option) => {
                const isSelected = selected.includes(option)
                return (
                  <label
                    key={option}
                    className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggle(option)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3 w-3"
                    />
                    <span className="truncate">{option}</span>
                  </label>
                )
              })}
              {filtered.length === 0 && (
                <p className="text-[11px] text-gray-400 py-2 text-center">No matches</p>
              )}
            </div>
            {activeCount > 0 && (
              <button
                onClick={onClear}
                className="mt-1.5 text-[10px] text-red-500 hover:text-red-600 font-medium"
              >
                Clear filter
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
