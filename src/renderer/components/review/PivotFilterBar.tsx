import { useState, useMemo } from 'react'
import { ChevronDownIcon, XMarkIcon, PlusIcon } from '@heroicons/react/24/outline'
import * as Popover from '@radix-ui/react-popover'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PivotFilterState {
  supplier: string[]
  classificationL1: string[]
  classificationL2: string[]
  classificationL3: string[]
  classificationL4: string[]
  glDescription: string[]
  company: string[]
}

export const INITIAL_PIVOT_FILTER_STATE: PivotFilterState = {
  supplier: [],
  classificationL1: [],
  classificationL2: [],
  classificationL3: [],
  classificationL4: [],
  glDescription: [],
  company: [],
}

interface FilterDef {
  key: keyof PivotFilterState
  label: string
  extract: (row: Record<string, unknown>) => string | undefined
}

const FILTER_DEFS: FilterDef[] = [
  { key: 'supplier', label: 'Supplier', extract: (r) => r.supplier_name as string | undefined },
  { key: 'glDescription', label: 'GL Description', extract: (r) => r.gl_description as string | undefined },
  { key: 'company', label: 'Company', extract: (r) => r.company as string | undefined },
  {
    key: 'classificationL1',
    label: 'L1',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[0]?.trim() || undefined
    },
  },
  {
    key: 'classificationL2',
    label: 'L2',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[1]?.trim() || undefined
    },
  },
  {
    key: 'classificationL3',
    label: 'L3',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[2]?.trim() || undefined
    },
  },
  {
    key: 'classificationL4',
    label: 'L4',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[3]?.trim() || undefined
    },
  },
]

const PRIMARY_KEYS: (keyof PivotFilterState)[] = [
  'supplier',
  'glDescription',
]

const SECONDARY_KEYS: (keyof PivotFilterState)[] = [
  'company',
  'classificationL1',
  'classificationL2',
  'classificationL3',
  'classificationL4',
]

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

interface PivotFilterBarProps {
  rows: Record<string, unknown>[]
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  onClearAll: () => void
}

/* ------------------------------------------------------------------ */
/* FilterChipPopover — one per primary filter dimension                */
/* ------------------------------------------------------------------ */

function FilterChipPopover({
  def,
  options,
  selected,
  onToggle,
  onClear,
}: {
  def: FilterDef
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
          {def.label}
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
                Clear {def.label}
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/* ------------------------------------------------------------------ */
/* MoreFiltersPopover — single popover for secondary dimensions        */
/* ------------------------------------------------------------------ */

function MoreFiltersPopover({
  defs,
  filterOptions,
  filterState,
  onToggle,
  onClearKey,
}: {
  defs: FilterDef[]
  filterOptions: Record<string, string[]>
  filterState: PivotFilterState
  onToggle: (key: keyof PivotFilterState, value: string) => void
  onClearKey: (key: keyof PivotFilterState) => void
}) {
  const [searches, setSearches] = useState<Record<string, string>>({})

  const secondaryActiveCount = defs.reduce(
    (sum, def) => sum + filterState[def.key].length,
    0
  )

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setSearches({}) }}>
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
          className="z-50 w-72 max-h-[400px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {defs.map((def) => {
            const options = filterOptions[def.key] || []
            if (options.length === 0) return null
            const selected = filterState[def.key]
            const searchTerm = (searches[def.key] || '').toLowerCase()
            const filtered = searchTerm
              ? options.filter((o) => o.toLowerCase().includes(searchTerm))
              : options

            return (
              <div key={def.key} className="border-b border-gray-100 last:border-b-0">
                <div className="px-3 pt-2.5 pb-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-gray-700">{def.label}</span>
                    {selected.length > 0 && (
                      <button
                        onClick={() => onClearKey(def.key)}
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
                      value={searches[def.key] || ''}
                      onChange={(e) => setSearches({ ...searches, [def.key]: e.target.value })}
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
                          onChange={() => onToggle(def.key, option)}
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
  onRemove: (key: keyof PivotFilterState, value: string) => void
  onClearAll: () => void
}) {
  // Flatten all active filters into a single ordered list
  const allPills: { key: keyof PivotFilterState; label: string; value: string }[] = []
  for (const def of FILTER_DEFS) {
    for (const value of filterState[def.key]) {
      allPills.push({ key: def.key, label: def.label, value })
    }
  }

  const VISIBLE_COUNT = 2
  const visible = allPills.slice(0, VISIBLE_COUNT)
  const overflow = allPills.slice(VISIBLE_COUNT)

  const pill = (item: { key: keyof PivotFilterState; value: string }) => (
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
  filterState,
  onFilterStateChange,
  onClearAll,
}: PivotFilterBarProps) {
  // Compute options for each filter dimension
  const filterOptions = useMemo(() => {
    const opts: Record<string, string[]> = {}
    for (const def of FILTER_DEFS) {
      const vals = new Set<string>()
      for (const row of rows) {
        const v = def.extract(row)
        if (v) vals.add(v)
      }
      const sorted = [...vals].sort()
      opts[def.key] = sorted.slice(0, 100)
    }
    return opts
  }, [rows])

  const activeCount = Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0)

  const toggleOption = (key: keyof PivotFilterState, value: string) => {
    const current = filterState[key]
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    onFilterStateChange({ ...filterState, [key]: next })
  }

  const clearKey = (key: keyof PivotFilterState) => {
    onFilterStateChange({ ...filterState, [key]: [] })
  }

  const removeFilter = (key: keyof PivotFilterState, value: string) => {
    onFilterStateChange({
      ...filterState,
      [key]: filterState[key].filter((v) => v !== value),
    })
  }

  // Visible primary/secondary filters (only those with options)
  const visiblePrimary = FILTER_DEFS.filter(
    (def) => PRIMARY_KEYS.includes(def.key) && (filterOptions[def.key]?.length ?? 0) > 0
  )
  const visibleSecondary = FILTER_DEFS.filter(
    (def) => SECONDARY_KEYS.includes(def.key) && (filterOptions[def.key]?.length ?? 0) > 0
  )

  return (
    <div className="flex flex-col gap-1">
      {/* Chip row */}
      <div className="flex items-center gap-1 flex-wrap">
        {visiblePrimary.map((def) => (
          <FilterChipPopover
            key={def.key}
            def={def}
            options={filterOptions[def.key] || []}
            selected={filterState[def.key]}
            onToggle={(val) => toggleOption(def.key, val)}
            onClear={() => clearKey(def.key)}
          />
        ))}

        {visibleSecondary.length > 0 && (
          <MoreFiltersPopover
            defs={visibleSecondary}
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
  // Short-circuit if no filters active
  const hasAnyFilter = Object.values(filterState).some((arr) => arr.length > 0)
  if (!hasAnyFilter) return rows

  return rows.filter((row) => {
    if (filterState.supplier.length > 0) {
      if (!filterState.supplier.includes(String(row.supplier_name || ''))) return false
    }
    if (filterState.glDescription.length > 0) {
      if (!filterState.glDescription.includes(String(row.gl_description || ''))) return false
    }
    if (filterState.company.length > 0) {
      if (!filterState.company.includes(String(row.company || ''))) return false
    }
    const path = String(row.classification_path || row.taxonomy_path || '')
    const parts = path.split('|').map((p) => p.trim())
    if (filterState.classificationL1.length > 0) {
      if (!parts[0] || !filterState.classificationL1.some((v) => parts[0].toLowerCase() === v.toLowerCase()))
        return false
    }
    if (filterState.classificationL2.length > 0) {
      if (!parts[1] || !filterState.classificationL2.some((v) => parts[1].toLowerCase() === v.toLowerCase()))
        return false
    }
    if (filterState.classificationL3.length > 0) {
      if (!parts[2] || !filterState.classificationL3.some((v) => parts[2].toLowerCase() === v.toLowerCase()))
        return false
    }
    if (filterState.classificationL4.length > 0) {
      if (!parts[3] || !filterState.classificationL4.some((v) => parts[3].toLowerCase() === v.toLowerCase()))
        return false
    }
    return true
  })
}

/* ------------------------------------------------------------------ */
/* Summarize active filters for export template                        */
/* ------------------------------------------------------------------ */

export function summarizeFilters(filterState: PivotFilterState): string {
  const parts: string[] = []
  for (const def of FILTER_DEFS) {
    const vals = filterState[def.key]
    if (vals.length > 0) {
      parts.push(`${def.label}: ${vals.length > 3 ? `${vals.slice(0, 3).join(', ')} +${vals.length - 3} more` : vals.join(', ')}`)
    }
  }
  return parts.length > 0 ? parts.join(' | ') : 'None'
}
