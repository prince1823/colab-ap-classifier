import { useState, useMemo } from 'react'
import { ChevronDownIcon, XMarkIcon, PlusIcon } from '@heroicons/react/24/outline'
import * as Popover from '@radix-ui/react-popover'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Dynamic filter state — keyed by column name */
export type PivotFilterState = Record<string, string[]>

export const INITIAL_PIVOT_FILTER_STATE: PivotFilterState = {}

/** Human-readable labels for well-known columns */
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
  classification_path: 'Classification Path',
}

function colLabel(col: string): string {
  return COLUMN_LABELS[col] || col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Columns shown as top-level primary filter chips (always visible) */
const PRIMARY_COLUMNS = ['supplier_name', 'gl_description']

/** Columns to exclude from the filter list (non-filterable) */
const EXCLUDE_COLUMNS = new Set([
  'id', 'row_index', 'taxonomy_node_id', 'classification_reasoning',
  'classification_status', 'spend_amount', 'amount', 'invoice_amount',
])

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

interface PivotFilterBarProps {
  rows: Record<string, unknown>[]
  availableColumns: string[]
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  onClearAll: () => void
}

/* ------------------------------------------------------------------ */
/* FilterChipPopover — one per primary filter dimension                */
/* ------------------------------------------------------------------ */

function FilterChipPopover({
  column,
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  column: string
  label: string
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
}) {
  const [search, setSearch] = useState('')
  const hasSelection = selected.length > 0

  const filtered = search
    ? options.filter((o) => o.toLowerCase().includes(search.toLowerCase()))
    : options

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setSearch('') }}>
      <Popover.Trigger asChild>
        <button
          className={`inline-flex items-center gap-0.5 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
            hasSelection
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {label}
          {hasSelection && (
            <span className="inline-flex items-center justify-center rounded-full bg-blue-600 text-white text-[8px] h-3.5 min-w-[14px] px-0.5">
              {selected.length}
            </span>
          )}
          <ChevronDownIcon className="h-2.5 w-2.5 opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          align="start"
          collisionPadding={8}
          className="z-50 w-64 rounded-lg border border-gray-200 bg-white shadow-lg"
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
            {hasSelection && (
              <button
                onClick={onClear}
                className="mt-1.5 text-[10px] text-red-500 hover:text-red-600 font-medium"
              >
                Clear {label}
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/* ------------------------------------------------------------------ */
/* MoreFiltersPopover — single popover for all secondary columns       */
/* ------------------------------------------------------------------ */

function MoreFiltersPopover({
  columns,
  filterOptions,
  filterState,
  onToggle,
  onClearKey,
}: {
  columns: { key: string; label: string }[]
  filterOptions: Record<string, string[]>
  filterState: PivotFilterState
  onToggle: (key: string, value: string) => void
  onClearKey: (key: string) => void
}) {
  const [searches, setSearches] = useState<Record<string, string>>({})
  const [columnSearch, setColumnSearch] = useState('')

  const secondaryActiveCount = columns.reduce(
    (sum, col) => sum + (filterState[col.key]?.length || 0),
    0
  )

  const filteredColumns = columnSearch
    ? columns.filter(c => c.label.toLowerCase().includes(columnSearch.toLowerCase()))
    : columns

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) { setSearches({}); setColumnSearch('') } }}>
      <Popover.Trigger asChild>
        <button
          className={`inline-flex items-center gap-0.5 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
            secondaryActiveCount > 0
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <PlusIcon className="h-2.5 w-2.5" />
          More
          {secondaryActiveCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-blue-600 text-white text-[8px] h-3.5 min-w-[14px] px-0.5">
              {secondaryActiveCount}
            </span>
          )}
          <ChevronDownIcon className="h-2.5 w-2.5 opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          align="start"
          collisionPadding={8}
          className="z-50 w-72 max-h-[450px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {/* Column search at top */}
          {columns.length > 8 && (
            <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-3 py-2">
              <input
                type="text"
                placeholder="Find a column..."
                value={columnSearch}
                onChange={(e) => setColumnSearch(e.target.value)}
                className="w-full rounded border border-gray-200 px-2 py-1 text-[11px] focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                autoFocus
              />
            </div>
          )}
          {filteredColumns.map((col) => {
            const options = filterOptions[col.key] || []
            if (options.length === 0) return null
            const selected = filterState[col.key] || []
            const searchTerm = (searches[col.key] || '').toLowerCase()
            const filtered = searchTerm
              ? options.filter((o) => o.toLowerCase().includes(searchTerm))
              : options

            return (
              <div key={col.key} className="border-b border-gray-100 last:border-b-0">
                <div className="px-3 pt-2.5 pb-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-gray-700">{col.label}</span>
                    {selected.length > 0 && (
                      <button
                        onClick={() => onClearKey(col.key)}
                        className="text-[10px] text-red-500 hover:text-red-600 font-medium"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {options.length > 6 && (
                    <input
                      type="text"
                      placeholder="Search…"
                      value={searches[col.key] || ''}
                      onChange={(e) => setSearches({ ...searches, [col.key]: e.target.value })}
                      className="w-full rounded border border-gray-200 px-2 py-1 text-[11px] mt-1 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                    />
                  )}
                </div>
                <div className="px-3 pb-2.5 max-h-32 overflow-y-auto space-y-0.5">
                  {filtered.map((option) => {
                    const isSelected = selected.includes(option)
                    return (
                      <label
                        key={option}
                        className={`flex items-center gap-2 rounded px-2 py-0.5 text-[11px] cursor-pointer transition-colors ${
                          isSelected ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggle(col.key, option)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3 w-3"
                        />
                        <span className="truncate">{option}</span>
                      </label>
                    )
                  })}
                  {filtered.length === 0 && (
                    <p className="text-[10px] text-gray-400 py-1 text-center">No matches</p>
                  )}
                </div>
              </div>
            )
          })}
          {filteredColumns.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-gray-400">
              No matching columns
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/* ------------------------------------------------------------------ */
/* ActivePillRow — shows first 2 pills, rest behind +N more popover    */
/* ------------------------------------------------------------------ */

function ActivePillRow({
  filterState,
  onRemove,
  onClearAll,
}: {
  filterState: PivotFilterState
  onRemove: (key: string, value: string) => void
  onClearAll: () => void
}) {
  // Flatten all active filters into a single ordered list
  const allPills: { key: string; value: string }[] = []
  for (const [key, values] of Object.entries(filterState)) {
    for (const value of values) {
      allPills.push({ key, value })
    }
  }

  const VISIBLE_COUNT = 2
  const visible = allPills.slice(0, VISIBLE_COUNT)
  const overflow = allPills.slice(VISIBLE_COUNT)

  const pill = (item: { key: string; value: string }) => (
    <span
      key={`${item.key}-${item.value}`}
      className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 text-blue-700 pl-1.5 pr-0.5 py-px text-[9px] font-medium max-w-[160px]"
    >
      <span className="truncate">{item.value}</span>
      <button
        onClick={() => onRemove(item.key, item.value)}
        className="rounded-full hover:bg-blue-200 p-px flex-shrink-0"
      >
        <XMarkIcon className="h-2 w-2" />
      </button>
    </span>
  )

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map(pill)}

      {overflow.length > 0 && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 text-gray-600 px-1.5 py-px text-[9px] font-medium hover:bg-gray-200 transition-colors">
              +{overflow.length} more
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              sideOffset={4}
              align="start"
              collisionPadding={8}
              className="z-50 w-64 max-h-[250px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg p-2"
            >
              <div className="flex flex-wrap gap-1.5">
                {overflow.map(pill)}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Main Component                                                      */
/* ------------------------------------------------------------------ */

export default function PivotFilterBar({
  rows,
  availableColumns,
  filterState,
  onFilterStateChange,
  onClearAll,
}: PivotFilterBarProps) {
  // Build list of filterable string columns (exclude numeric-only and internal fields)
  const filterableColumns = useMemo(() => {
    return availableColumns.filter(col => !EXCLUDE_COLUMNS.has(col))
  }, [availableColumns])

  // Split into primary (always shown as chips) and secondary (behind + More)
  const primaryColumns = useMemo(
    () => filterableColumns.filter(col => PRIMARY_COLUMNS.includes(col)),
    [filterableColumns]
  )
  const secondaryColumns = useMemo(
    () => filterableColumns.filter(col => !PRIMARY_COLUMNS.includes(col)),
    [filterableColumns]
  )

  // Compute unique options for each filterable column
  const filterOptions = useMemo(() => {
    const opts: Record<string, string[]> = {}
    for (const col of filterableColumns) {
      const vals = new Set<string>()
      for (const row of rows) {
        const v = row[col]
        if (v !== null && v !== undefined && v !== '') {
          const s = String(v).trim()
          if (s) vals.add(s)
        }
      }
      const sorted = [...vals].sort()
      opts[col] = sorted.slice(0, 200) // cap at 200 unique values
    }
    return opts
  }, [rows, filterableColumns])

  const activeCount = Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0)

  const toggleOption = (key: string, value: string) => {
    const current = filterState[key] || []
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    onFilterStateChange({ ...filterState, [key]: next })
  }

  const clearKey = (key: string) => {
    const next = { ...filterState }
    delete next[key]
    onFilterStateChange(next)
  }

  const removeFilter = (key: string, value: string) => {
    const current = filterState[key] || []
    const next = current.filter((v) => v !== value)
    onFilterStateChange({ ...filterState, [key]: next.length > 0 ? next : [] })
  }

  // Only show primary chips for columns that have options
  const visiblePrimary = primaryColumns.filter(col => (filterOptions[col]?.length ?? 0) > 0)
  const visibleSecondary = secondaryColumns
    .filter(col => (filterOptions[col]?.length ?? 0) > 0)
    .map(col => ({ key: col, label: colLabel(col) }))

  return (
    <div className="flex flex-col gap-1">
      {/* Chip row */}
      <div className="flex items-center gap-1 flex-wrap">
        {visiblePrimary.map((col) => (
          <FilterChipPopover
            key={col}
            column={col}
            label={colLabel(col)}
            options={filterOptions[col] || []}
            selected={filterState[col] || []}
            onToggle={(val) => toggleOption(col, val)}
            onClear={() => clearKey(col)}
          />
        ))}

        {visibleSecondary.length > 0 && (
          <MoreFiltersPopover
            columns={visibleSecondary}
            filterOptions={filterOptions}
            filterState={filterState}
            onToggle={toggleOption}
            onClearKey={clearKey}
          />
        )}

        {activeCount > 0 && (
          <button
            onClick={onClearAll}
            className="inline-flex items-center gap-0.5 text-[10px] text-red-500 hover:text-red-600 font-medium ml-0.5"
          >
            <XMarkIcon className="h-2.5 w-2.5" />
            Clear all
          </button>
        )}
      </div>

      {/* Active filter pills — show first 2, then +N more */}
      {activeCount > 0 && (
        <ActivePillRow filterState={filterState} onRemove={removeFilter} onClearAll={onClearAll} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Filter application (pure function, used by PivotPage)               */
/* ------------------------------------------------------------------ */

export function applyPivotFilters(
  rows: Record<string, unknown>[],
  filterState: PivotFilterState
): Record<string, unknown>[] {
  // Collect only active filter entries
  const activeFilters = Object.entries(filterState).filter(
    ([, values]) => values.length > 0
  )
  if (activeFilters.length === 0) return rows

  return rows.filter((row) => {
    for (const [col, allowedValues] of activeFilters) {
      const cellValue = String(row[col] ?? '').trim()
      if (!cellValue) return false
      // Case-insensitive match
      if (!allowedValues.some(v => v.toLowerCase() === cellValue.toLowerCase())) return false
    }
    return true
  })
}

/* ------------------------------------------------------------------ */
/* Summarize active filters for export template                        */
/* ------------------------------------------------------------------ */

export function summarizeFilters(filterState: PivotFilterState): string {
  const parts: string[] = []
  for (const [col, vals] of Object.entries(filterState)) {
    if (vals.length > 0) {
      const label = colLabel(col)
      parts.push(`${label}: ${vals.length > 3 ? `${vals.slice(0, 3).join(', ')} +${vals.length - 3} more` : vals.join(', ')}`)
    }
  }
  return parts.length > 0 ? parts.join(' | ') : 'None'
}
