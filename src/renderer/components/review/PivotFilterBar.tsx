import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronDownIcon, XMarkIcon, FunnelIcon, XCircleIcon } from '@heroicons/react/24/outline'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PivotFilterState {
  supplier: string[]
  classificationL1: string[]
  classificationL2: string[]
  classificationL3: string[]
  glDescription: string[]
  company: string[]
  year: string[]
  quarter: string[]
  month: string[]
  costCenter: string[]
  supplierCategory: string[]
  country: string[]
}

export const INITIAL_PIVOT_FILTER_STATE: PivotFilterState = {
  supplier: [],
  classificationL1: [],
  classificationL2: [],
  classificationL3: [],
  glDescription: [],
  company: [],
  year: [],
  quarter: [],
  month: [],
  costCenter: [],
  supplierCategory: [],
  country: [],
}

interface FilterDef {
  key: keyof PivotFilterState
  label: string
  extract: (row: Record<string, unknown>) => string | undefined
}

const FILTER_DEFS: FilterDef[] = [
  { key: 'supplier', label: 'Supplier', extract: (r) => r.supplier_name as string | undefined },
  {
    key: 'classificationL1',
    label: 'Classification L1',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[0]?.trim() || undefined
    },
  },
  {
    key: 'classificationL2',
    label: 'Classification L2',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[1]?.trim() || undefined
    },
  },
  {
    key: 'classificationL3',
    label: 'Classification L3',
    extract: (r) => {
      const p = String(r.classification_path || '')
      return p.split('|')[2]?.trim() || undefined
    },
  },
  { key: 'glDescription', label: 'GL Description', extract: (r) => r.gl_description as string | undefined },
  { key: 'company', label: 'Company', extract: (r) => r.company as string | undefined },
  { key: 'year', label: 'Year', extract: (r) => r['Accounting Date-Year'] as string | undefined },
  { key: 'quarter', label: 'Quarter', extract: (r) => r['Accounting Date-Quarter'] as string | undefined },
  { key: 'month', label: 'Month', extract: (r) => r['Accounting Date-Month'] as string | undefined },
  { key: 'costCenter', label: 'Cost Center', extract: (r) => r['Cost Center Name'] as string | undefined },
  { key: 'supplierCategory', label: 'Supplier Category', extract: (r) => r['Supplier Category'] as string | undefined },
  { key: 'country', label: 'Country', extract: (r) => r.Country as string | undefined },
]

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

interface PivotFilterBarProps {
  rows: Record<string, unknown>[]
  filterState: PivotFilterState
  onFilterStateChange: (state: PivotFilterState) => void
  onClearAll: () => void
  isOpen: boolean
  onToggle: () => void
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function PivotFilterBar({
  rows,
  filterState,
  onFilterStateChange,
  onClearAll,
  isOpen,
  onToggle,
}: PivotFilterBarProps) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({})
  const panelRef = useRef<HTMLDivElement>(null)

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

  // Only show filters that have options
  const visibleFilters = useMemo(() => {
    return FILTER_DEFS.filter((def) => filterOptions[def.key]?.length > 0)
  }, [filterOptions])

  const activeCount = Object.values(filterState).reduce((sum, arr) => sum + arr.length, 0)

  const toggleOption = (key: keyof PivotFilterState, value: string) => {
    const current = filterState[key]
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    onFilterStateChange({ ...filterState, [key]: next })
  }

  const removeFilter = (key: keyof PivotFilterState, value: string) => {
    onFilterStateChange({
      ...filterState,
      [key]: filterState[key].filter((v) => v !== value),
    })
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onToggle()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onToggle])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30" onClick={onToggle} />

      {/* Slide-over panel from right */}
      <div
        ref={panelRef}
        className="fixed right-0 top-0 bottom-0 z-40 w-80 bg-white border-l border-gray-200 shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: 'slideInRight 0.2s ease-out' }}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-2">
            <FunnelIcon className="h-4 w-4 text-gray-600" />
            <h3 className="text-sm font-semibold text-gray-900">Filters</h3>
            {activeCount > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-blue-600 text-white text-[10px] h-5 min-w-[20px] px-1.5 font-medium">
                {activeCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeCount > 0 && (
              <button
                onClick={onClearAll}
                className="text-[11px] text-red-600 hover:text-red-700 font-medium"
              >
                Clear all
              </button>
            )}
            <button
              onClick={onToggle}
              className="rounded-md p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Active filter pills */}
        {activeCount > 0 && (
          <div className="px-4 py-2.5 border-b border-gray-100 bg-blue-50/40">
            <div className="flex items-center gap-1.5 flex-wrap">
              {FILTER_DEFS.map((def) =>
                filterState[def.key].map((value) => (
                  <span
                    key={`${def.key}-${value}`}
                    className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 text-blue-700 pl-2 pr-1 py-0.5 text-[10px] font-medium max-w-[180px]"
                  >
                    <span className="truncate">{value}</span>
                    <button
                      onClick={() => removeFilter(def.key, value)}
                      className="rounded-full hover:bg-blue-200 p-0.5 flex-shrink-0"
                    >
                      <XMarkIcon className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>
        )}

        {/* Filter groups */}
        <div className="flex-1 overflow-y-auto">
          {visibleFilters.map((def) => {
            const selected = filterState[def.key]
            const isExpanded = expandedGroup === def.key
            const options = filterOptions[def.key] || []
            const searchTerm = (searchTerms[def.key] || '').toLowerCase()
            const filteredOptions = searchTerm
              ? options.filter((o) => o.toLowerCase().includes(searchTerm))
              : options

            return (
              <div key={def.key} className="border-b border-gray-100">
                {/* Group header */}
                <button
                  onClick={() => setExpandedGroup(isExpanded ? null : def.key)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50 transition-colors"
                >
                  <span className="text-xs font-medium text-gray-700">{def.label}</span>
                  <div className="flex items-center gap-1.5">
                    {selected.length > 0 && (
                      <span className="inline-flex items-center justify-center rounded-full bg-blue-100 text-blue-700 text-[10px] h-4 min-w-[16px] px-1 font-semibold">
                        {selected.length}
                      </span>
                    )}
                    <ChevronDownIcon
                      className={`h-3.5 w-3.5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  </div>
                </button>

                {/* Expanded: search + checkbox list */}
                {isExpanded && (
                  <div className="px-4 pb-3">
                    {options.length > 6 && (
                      <input
                        type="text"
                        placeholder={`Search…`}
                        value={searchTerms[def.key] || ''}
                        onChange={(e) => setSearchTerms({ ...searchTerms, [def.key]: e.target.value })}
                        className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-[11px] mb-2 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                        autoFocus
                      />
                    )}
                    <div className="max-h-44 overflow-y-auto space-y-0.5">
                      {filteredOptions.map((option) => {
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
                              onChange={() => toggleOption(def.key, option)}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3 w-3"
                            />
                            <span className="truncate">{option}</span>
                          </label>
                        )
                      })}
                      {filteredOptions.length === 0 && (
                        <p className="text-[11px] text-gray-400 py-2 text-center">No matches</p>
                      )}
                    </div>
                    {selected.length > 0 && (
                      <button
                        onClick={() => onFilterStateChange({ ...filterState, [def.key]: [] })}
                        className="mt-1.5 text-[10px] text-red-500 hover:text-red-600 font-medium"
                      >
                        Clear {def.label}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Keyframe animation */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </>
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
    if (filterState.classificationL1.length > 0) {
      const path = String(row.classification_path || row.taxonomy_path || '')
      const parts = path.split('|').map((p) => p.trim())
      if (!parts[0] || !filterState.classificationL1.some((v) => parts[0].toLowerCase() === v.toLowerCase()))
        return false
    }
    if (filterState.classificationL2.length > 0) {
      const path = String(row.classification_path || row.taxonomy_path || '')
      const parts = path.split('|').map((p) => p.trim())
      if (!parts[1] || !filterState.classificationL2.some((v) => parts[1].toLowerCase() === v.toLowerCase()))
        return false
    }
    if (filterState.classificationL3.length > 0) {
      const path = String(row.classification_path || row.taxonomy_path || '')
      const parts = path.split('|').map((p) => p.trim())
      if (!parts[2] || !filterState.classificationL3.some((v) => parts[2].toLowerCase() === v.toLowerCase()))
        return false
    }
    if (filterState.glDescription.length > 0) {
      if (!filterState.glDescription.includes(String(row.gl_description || ''))) return false
    }
    if (filterState.company.length > 0) {
      if (!filterState.company.includes(String(row.company || ''))) return false
    }
    if (filterState.year.length > 0) {
      if (!filterState.year.includes(String(row['Accounting Date-Year'] || ''))) return false
    }
    if (filterState.quarter.length > 0) {
      if (!filterState.quarter.includes(String(row['Accounting Date-Quarter'] || ''))) return false
    }
    if (filterState.month.length > 0) {
      if (!filterState.month.includes(String(row['Accounting Date-Month'] || ''))) return false
    }
    if (filterState.costCenter.length > 0) {
      if (!filterState.costCenter.includes(String(row['Cost Center Name'] || ''))) return false
    }
    if (filterState.supplierCategory.length > 0) {
      if (!filterState.supplierCategory.includes(String(row['Supplier Category'] || ''))) return false
    }
    if (filterState.country.length > 0) {
      if (!filterState.country.includes(String(row.Country || ''))) return false
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
