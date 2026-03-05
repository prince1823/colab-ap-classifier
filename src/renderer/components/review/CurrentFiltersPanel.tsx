import React, { useState, useMemo, useRef, useEffect } from 'react'
import { X, Plus, ChevronDown } from 'lucide-react'
import { useDrop } from 'react-dnd'
import { ITEM_TYPE } from './MultiTableSystem'
import type { ReviewTableConfig } from './ReviewFilterContext'
import '../../styles/CurrentFiltersPanel.css'

/** Compute AND group membership for visual grouping in the filter panel UI. */
function computeAndGroupIndices(
  conditionKeys: string[],
  filterConnectors: Record<string, 'AND' | 'OR'>
): number[] {
  if (conditionKeys.length === 0) return []
  const groupIndices: number[] = [0]
  let currentGroup = 0
  for (let i = 1; i < conditionKeys.length; i++) {
    const prevKey = conditionKeys[i - 1]
    const connector = filterConnectors[prevKey] || 'AND'
    if (connector === 'OR') currentGroup++
    groupIndices.push(currentGroup)
  }
  return groupIndices
}

/** Build a human-readable expression preview showing how conditions are grouped. */
function buildExpressionPreview(
  labels: string[],
  conditionKeys: string[],
  filterConnectors: Record<string, 'AND' | 'OR'>
): string | null {
  if (labels.length < 2) return null
  const connectors: string[] = []
  for (let i = 0; i < conditionKeys.length - 1; i++) {
    connectors.push(filterConnectors[conditionKeys[i]] || 'AND')
  }
  const hasAnd = connectors.includes('AND')
  const hasOr = connectors.includes('OR')
  if (!hasAnd || !hasOr) return null
  const groups: string[][] = [[labels[0]]]
  for (let i = 1; i < labels.length; i++) {
    if (connectors[i - 1] === 'OR') {
      groups.push([labels[i]])
    } else {
      groups[groups.length - 1].push(labels[i])
    }
  }
  return groups.map(g => g.length === 1 ? g[0] : `(${g.join(' AND ')})`).join(' OR ')
}

// Map backend/activeFilters keys to human-readable labels
const allFilterLabels: Record<string, string> = {
  supplier_name: 'Supplier Name',
  classification_l1: 'Classification L1',
  classification_l2: 'Classification L2',
  classification_l3: 'Classification L3',
  classification_l4: 'Classification L4',
  gl_description: 'GL Description',
  line_description: 'Line Description',
  company: 'Company',
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  costCenter: 'Cost Center',
  country: 'Country',
  // UI filterState keys mapped too
  supplier: 'Supplier Name',
  classificationL1: 'Classification L1',
  classificationL2: 'Classification L2',
  classificationL3: 'Classification L3',
  classificationL4: 'Classification L4',
  glDescription: 'GL Description',
  lineDescription: 'Line Description',
}

// Filterable columns available in the field dropdown
const filterableFields = [
  { key: 'supplier_name', label: 'Supplier Name' },
  { key: 'gl_description', label: 'GL Description' },
  { key: 'line_description', label: 'Line Description' },
  { key: 'company', label: 'Company' },
  { key: 'classification_l1', label: 'Classification L1' },
  { key: 'classification_l2', label: 'Classification L2' },
  { key: 'classification_l3', label: 'Classification L3' },
  { key: 'classification_l4', label: 'Classification L4' },
]

// Available filter operators
const filterOperators = [
  { key: 'is', label: 'is' },
  { key: 'is_not', label: 'is not' },
  { key: 'contains', label: 'contains' },
  { key: 'not_contains', label: 'not contains' },
  { key: 'starts_with', label: 'starts with' },
  { key: 'ends_with', label: 'ends with' },
]

// Map backend keys to filterState keys
const keyMapping: Record<string, string> = {
  supplier_name: 'supplier',
  classification_l1: 'classificationL1',
  classification_l2: 'classificationL2',
  classification_l3: 'classificationL3',
  classification_l4: 'classificationL4',
  gl_description: 'glDescription',
  line_description: 'lineDescription'
}

// Reverse map: filterState keys → backend keys (for normalizing group keys)
const fsKeyToBackendKey: Record<string, string> = {
  supplier: 'supplier_name',
  classificationL1: 'classification_l1',
  classificationL2: 'classification_l2',
  classificationL3: 'classification_l3',
  classificationL4: 'classification_l4',
  glDescription: 'gl_description',
  lineDescription: 'line_description',
}

interface DropdownOption {
  key: string
  label: string
}

interface InlineDropdownProps {
  options: DropdownOption[]
  value: string
  onChange: (val: string) => void
  className?: string
}

// Small reusable dropdown component
const InlineDropdown: React.FC<InlineDropdownProps> = ({ options, value, onChange, className = '' }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selected: DropdownOption | undefined = options.find(o => o.key === value) || options[0]

  return (
    <div ref={ref} className={`fibery-dropdown ${className}`}>
      <button className="fibery-dropdown-trigger" onClick={() => setOpen(!open)}>
        {selected?.label}
        <ChevronDown size={10} />
      </button>
      {open && (
        <div className="fibery-dropdown-menu">
          {options.map(opt => (
            <div
              key={opt.key}
              className={`fibery-dropdown-item ${opt.key === value ? 'active' : ''}`}
              onClick={() => { onChange(opt.key); setOpen(false) }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ValuePickerProps {
  fieldKey: string
  transactions: Array<Record<string, unknown>>
  onSelect: (val: string) => void
  onClose: () => void
}

// Value picker dropdown — shows searchable list from transaction data
const ValuePicker: React.FC<ValuePickerProps> = ({ fieldKey, transactions, onSelect, onClose }) => {
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const values = useMemo(() => {
    const vals = new Set<string>()
    transactions.forEach((t: Record<string, unknown>) => {
      const v = t[fieldKey]
      if (v && String(v).trim()) vals.add(String(v).trim())
    })
    return Array.from(vals).sort()
  }, [fieldKey, transactions])

  const filtered = useMemo(() => {
    if (!search) return values
    const lower = search.toLowerCase()
    return values.filter(v => v.toLowerCase().includes(lower))
  }, [values, search])

  return (
    <div ref={ref} className="fibery-value-picker">
      <div className="fibery-value-picker-search">
        <input
          type="text"
          placeholder="Search values..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
      </div>
      <div className="fibery-value-picker-list">
        {filtered.slice(0, 80).map(val => (
          <div
            key={val}
            className="fibery-value-picker-item"
            onClick={() => { onSelect(val); onClose() }}
          >
            <span title={val}>{val}</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="fibery-value-picker-empty">No matching values</div>
        )}
      </div>
    </div>
  )
}


interface CurrentFiltersPanelProps {
  activeFilters?: Record<string, unknown>
  filterState?: Record<string, unknown>
  tables?: ReviewTableConfig[]
  filterCombinator?: string
  filterConnectors?: Record<string, 'AND' | 'OR'>
  filterGroupOperators?: Record<string, string>
  onSetFilterCombinator?: (val: 'AND' | 'OR') => void
  onSetFilterConnector?: (key: string, val: 'AND' | 'OR') => void
  onSetFilterOperator?: (key: string, val: string) => void
  onRemoveFilter: (key: string, value: string | null) => void
  onClearAll: () => void
  onAddFilter: (key: string, values: string[]) => void
  transactions?: Array<Record<string, unknown>>
}

const CurrentFiltersPanel: React.FC<CurrentFiltersPanelProps> = ({
  activeFilters = {},
  filterState = {},
  tables = [] as ReviewTableConfig[],
  filterCombinator = 'AND',
  filterConnectors = {} as Record<string, 'AND' | 'OR'>,
  filterGroupOperators = {} as Record<string, string>,
  onSetFilterCombinator,
  onSetFilterConnector,
  onSetFilterOperator,
  onRemoveFilter,
  onClearAll,
  onAddFilter,
  transactions = [],
}) => {
  // Track which value picker is open (by group key)
  const [activeValuePicker, setActiveValuePicker] = useState<string | null>(null)

  // Drop target: accept dragged rows from tables and add as global filter chips
  const [{ isOver: isDropOver }, dropRef] = useDrop({
    accept: ITEM_TYPE,
    drop: (item: any) => {
      if (item.type === 'filter' && item.column && onAddFilter) {
        const values = item.selectedValues && item.selectedValues.length > 1
          ? item.selectedValues
          : [item.value]
        onAddFilter(item.column, values)
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  })

  // Group filters by column — one row per unique column with all values collected
  const groupedFilters = useMemo(() => {
    const groups: Array<{
      key: string            // canonical column key (e.g. supplier_name)
      label: string          // human-readable (e.g. Supplier Name)
      values: Array<{
        value: string
        source: 'filterState' | 'activeFilters'
        isArrayItem: boolean
      }>
    }> = []
    const groupMap = new Map<string, typeof groups[0]>()
    const seen = new Set<string>()

    const getOrCreateGroup = (key: string, label: string) => {
      let group = groupMap.get(key)
      if (!group) {
        group = { key, label, values: [] }
        groupMap.set(key, group)
        groups.push(group)
      }
      return group
    }

    // 1. filterState (UI panel filters) — normalize key to backend key
    Object.entries(filterState)
      .filter(([, value]) => Array.isArray(value) ? value.length > 0 : value && String(value).trim() !== '')
      .forEach(([key, value]: [string, unknown]) => {
        const values: unknown[] = Array.isArray(value) ? value : [value]
        const label = allFilterLabels[key] || key
        const backendKey = fsKeyToBackendKey[key] || key
        const group = getOrCreateGroup(backendKey, label)
        values.forEach((v: unknown) => {
          const id = `${backendKey}:${v}`
          if (!seen.has(id)) {
            seen.add(id)
            group.values.push({ value: String(v), source: 'filterState' as const, isArrayItem: Array.isArray(value) })
          }
        })
      })

    // 2. activeFilters (backend keys — skip duplicates from filterState)
    Object.entries(activeFilters)
      .filter(([key, value]: [string, unknown]) => {
        const uiKey = keyMapping[key] || key
        const fsVal = (filterState as Record<string, unknown>)[uiKey]
        if (fsVal !== undefined && fsVal !== null && fsVal !== '') {
          if (Array.isArray(fsVal) && fsVal.length > 0) return false
          if (!Array.isArray(fsVal)) return false
        }
        return Array.isArray(value) ? value.length > 0 : value && String(value).trim() !== ''
      })
      .forEach(([key, value]: [string, unknown]) => {
        const values: unknown[] = Array.isArray(value) ? value : [value]
        const label = allFilterLabels[key] || key
        const group = getOrCreateGroup(key, label)
        values.forEach((v: unknown) => {
          const id = `${key}:${v}`
          if (!seen.has(id)) {
            seen.add(id)
            group.values.push({ value: String(v), source: 'activeFilters' as const, isArrayItem: Array.isArray(value) })
          }
        })
      })

    return groups
  }, [activeFilters, filterState, tables])

  const totalFilterCount = groupedFilters.reduce((sum, g) => sum + g.values.length, 0)

  // Compute AND group indices for visual grouping (AND-connected rows share a group)
  const andGroupIndices = useMemo(() => {
    const keys = groupedFilters.map(g => g.key)
    return computeAndGroupIndices(keys, filterConnectors)
  }, [groupedFilters, filterConnectors])

  // Build expression preview — only shown when there's mixed AND/OR
  const expressionPreview = useMemo(() => {
    const labels = groupedFilters.map(g => g.label)
    const keys = groupedFilters.map(g => g.key)
    return buildExpressionPreview(labels, keys, filterConnectors)
  }, [groupedFilters, filterConnectors])

  const handleRemoveValue = (group: typeof groupedFilters[0], valueEntry: typeof groupedFilters[0]['values'][0]) => {
    // For filterState entries, group.key is a backend key (e.g. supplier_name).
    // Dashboard's removeFilter needs the UI key for filterState entries.
    const removeKey = valueEntry.source === 'filterState'
      ? (keyMapping[group.key] || group.key)
      : group.key
    onRemoveFilter(removeKey, valueEntry.isArrayItem ? valueEntry.value : null)
  }

  // Add a new filter row
  const [showAddRow, setShowAddRow] = useState(false)
  const [newRowField, setNewRowField] = useState<string | null>(null)

  const handleAddNewFilter = (fieldKey: string, value: string) => {
    onAddFilter(fieldKey, [value])
    setShowAddRow(false)
    setNewRowField(null)
  }

  // Helper to toggle a per-row connector
  const toggleConnector = (groupKey: string) => {
    if (onSetFilterConnector) {
      const current = filterConnectors[groupKey] || 'AND'
      onSetFilterConnector(groupKey, current === 'AND' ? 'OR' : 'AND')
    }
  }

  return (
    <div ref={dropRef} className={`current-filters-panel ${isDropOver ? 'drop-target-active' : ''}`}>
      {/* Header */}
      <div className="current-filters-header">
        <span className="current-filters-title">Filter</span>
        {totalFilterCount > 0 && (
          <button className="fibery-filters-on-views" onClick={onClearAll}>
            Clear all
          </button>
        )}
      </div>

      {/* Expression preview — shows how conditions are grouped when mixed AND/OR */}
      {expressionPreview && (
        <div className="fibery-expression-preview" title="Shows how your filter conditions are grouped">
          <span className="fibery-expression-label">Logic:</span>
          <span className="fibery-expression-text" title={expressionPreview}>{expressionPreview}</span>
        </div>
      )}

      {/* Filter rows area */}
      <div className="fibery-filter-rows">
        {groupedFilters.length === 0 && !showAddRow ? (
          <div className="fibery-filter-empty">
            No filters applied.
            <br />
            Double-click or drag a row here to filter.
          </div>
        ) : (
          <>
            {groupedFilters.map((group, idx) => {
              // AND group membership for visual grouping
              const groupIdx = andGroupIndices[idx]
              const prevGroupIdx = idx > 0 ? andGroupIndices[idx - 1] : -1
              const nextGroupIdx = idx < groupedFilters.length - 1 ? andGroupIndices[idx + 1] : -1
              const isInAndGroup = groupIdx === prevGroupIdx || groupIdx === nextGroupIdx
              const isFirstInGroup = groupIdx !== prevGroupIdx && groupIdx === nextGroupIdx
              const isLastInGroup = groupIdx === prevGroupIdx && groupIdx !== nextGroupIdx

              return (
              <React.Fragment key={group.key}>
                <div className={`fibery-filter-row ${isInAndGroup ? 'and-grouped' : ''} ${isFirstInGroup ? 'and-group-first' : ''} ${isLastInGroup ? 'and-group-last' : ''}`}>
                  <span className="fibery-field-label">{group.label}</span>
                  <InlineDropdown
                    options={filterOperators}
                    value={filterGroupOperators[group.key] || 'is'}
                    onChange={(val) => onSetFilterOperator && onSetFilterOperator(group.key, val)}
                    className="fibery-operator-dropdown"
                  />
                  <div className="fibery-row-chips">
                    {group.values.map((entry) => {
                      const chipText = group.key === 'classification_path' && entry.value.includes('|')
                        ? entry.value.split('|').map(p => p.trim()).filter(Boolean).pop() || entry.value
                        : entry.value
                      return (
                        <span key={entry.value} className="fibery-value-chip" title={entry.value}>
                          <span className="fibery-value-chip-text">{chipText}</span>
                          <button
                            className="fibery-value-chip-x"
                            onClick={() => handleRemoveValue(group, entry)}
                          >
                            <X size={10} />
                          </button>
                        </span>
                      )
                    })}
                  </div>
                </div>
                {/* AND/OR connector pill between rows */}
                {idx < groupedFilters.length - 1 && (
                  <div className="fibery-connector-row">
                    <button
                      className={`fibery-connector-pill ${(filterConnectors[group.key] || 'AND') === 'OR' ? 'or' : 'and'}`}
                      onClick={() => toggleConnector(group.key)}
                    >
                      {filterConnectors[group.key] || 'AND'}
                    </button>
                  </div>
                )}
              </React.Fragment>
              )
            })}

            {/* New filter row being added */}
            {showAddRow && (
              <div className="fibery-filter-row fibery-filter-row-new">
                <InlineDropdown
                  options={filterableFields.map(f => ({ key: f.key, label: f.label }))}
                  value={newRowField || filterableFields[0].key}
                  onChange={(val) => setNewRowField(val)}
                />
                <InlineDropdown
                  options={filterOperators}
                  value="is"
                  onChange={() => {}}
                  className="fibery-operator-dropdown"
                />
                <div className="fibery-row-chips">
                  <button
                    className="fibery-value-trigger"
                    onClick={() => setActiveValuePicker(activeValuePicker === '_new' ? null : '_new')}
                  >
                    Select value...
                  </button>
                </div>
                <button
                  className="fibery-row-cancel-btn"
                  onClick={() => { setShowAddRow(false); setNewRowField(null); setActiveValuePicker(null) }}
                  title="Cancel"
                >
                  <X size={10} />
                </button>
                {activeValuePicker === '_new' && (
                  <div className="fibery-picker-overlay">
                    <ValuePicker
                      fieldKey={newRowField || filterableFields[0].key}
                      transactions={transactions}
                      onSelect={(val) => handleAddNewFilter(newRowField || filterableFields[0].key, val)}
                      onClose={() => setActiveValuePicker(null)}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Add button */}
      <div className="fibery-filter-footer">
        <button
          className="fibery-add-btn"
          onClick={() => { setShowAddRow(true); setNewRowField(null) }}
        >
          <Plus size={12} />
          Add
        </button>
      </div>
    </div>
  )
}

export default CurrentFiltersPanel
