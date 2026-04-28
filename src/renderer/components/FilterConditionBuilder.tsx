import { useMemo, useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import type { FilterCondition, FilterOperator, FieldType, FieldDefinition, ConditionGroup, GroupedFilter } from '../../shared/types/transactions'
import { groupedToConditions } from '../../shared/filter-utils'

/* ---------- Stable key helper ---------- */
// React needs stable keys that survive add/remove operations.
// Index-based keys cause focus loss and DOM jumbling.
let _nextKey = 1
function nextKey(): string { return `fk-${_nextKey++}` }

const _keyMap = new WeakMap<object, string>()
/** Get or assign a stable React key for any object (condition or group). */
function stableKey(obj: object): string {
  let k = _keyMap.get(obj)
  if (!k) {
    k = nextKey()
    _keyMap.set(obj, k)
  }
  return k
}

const ALL_OPERATORS: FilterOperator[] = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'regex', 'in_list', 'is_null', 'is_true', 'is_false',
  'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal',
]

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'equals',
  not_equals: 'not equals',
  contains: 'contains',
  not_contains: 'not contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  regex: 'matches regex',
  in_list: 'in list',
  is_null: 'is null',
  is_true: 'is true',
  is_false: 'is false',
  greater_than: '>',
  less_than: '<',
  greater_than_or_equal: '≥',
  less_than_or_equal: '≤',
}

/** No-value operators — hide the value input for these */
const NO_VALUE_OPERATORS = new Set<FilterOperator>(['is_null', 'is_true', 'is_false'])

/** Operators available per field type */
const OPERATORS_BY_TYPE: Record<FieldType, FilterOperator[]> = {
  string: ['equals', 'not_equals', 'contains', 'not_contains'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal', 'is_null'],
  boolean: ['is_true', 'is_false'],
  enum: ['equals', 'not_equals', 'in_list'],
}

/* ---------- SuggestInput: inline autocomplete dropdown ---------- */

interface SuggestInputProps {
  value: string
  onChange: (val: string) => void
  suggestions: string[]
  placeholder?: string
  className?: string
}

function SuggestInput({ value, onChange, suggestions, placeholder, className }: SuggestInputProps) {
  const [open, setOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const dropdownRef = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 200 })

  const filtered = useMemo(() => {
    if (!value) return suggestions
    const q = value.toLowerCase()
    return suggestions.filter(s => s.toLowerCase().includes(q))
  }, [value, suggestions])

  // Position the dropdown relative to the input, rendered via portal
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return
    const rect = inputRef.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }, [open, filtered])

  // Close dropdown when clicking outside — use 'pointerdown' on capture phase
  // so it doesn't interfere with button click handlers
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const target = e.target as Node
      if (
        wrapRef.current && !wrapRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [])

  useEffect(() => { setFocusIdx(-1) }, [filtered])

  useEffect(() => {
    if (focusIdx >= 0 && listRef.current) {
      const item = listRef.current.children[focusIdx] as HTMLElement | undefined
      item?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusIdx])

  const select = useCallback((val: string) => {
    onChange(val)
    setOpen(false)
  }, [onChange])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx(prev => (prev + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx(prev => (prev <= 0 ? filtered.length - 1 : prev - 1))
    } else if (e.key === 'Enter' && focusIdx >= 0) {
      e.preventDefault()
      select(filtered[focusIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="min-w-0 flex-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        type="text"
        className={className}
      />
      {open && filtered.length > 0 && createPortal(
        <ul
          ref={(el) => { (listRef as React.MutableRefObject<HTMLUListElement | null>).current = el; (dropdownRef as React.MutableRefObject<HTMLUListElement | null>).current = el }}
          className="fixed z-[9999] max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {filtered.slice(0, 50).map((s, idx) => (
            <li
              key={s}
              onMouseDown={(e) => { e.preventDefault(); select(s) }}
              onMouseEnter={() => setFocusIdx(idx)}
              className={`cursor-pointer break-words px-2.5 py-1.5 text-xs leading-snug ${
                idx === focusIdx ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {s}
            </li>
          ))}
          {filtered.length > 50 && (
            <li className="px-2.5 py-1 text-[10px] text-gray-400 italic">
              +{filtered.length - 50} more — type to narrow
            </li>
          )}
        </ul>,
        document.body
      )}
    </div>
  )
}

/* ---------- SearchableSelect: custom dropdown replacement for <select> ---------- */

interface SelectOption {
  value: string
  label: string
  group?: string
}

interface SearchableSelectProps {
  value: string
  onChange: (val: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  searchable?: boolean
}

function SearchableSelect({ value, onChange, options, placeholder = 'Select...', className, searchable = true }: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 224 })

  const selectedLabel = options.find(o => o.value === value)?.label ?? ''

  const filtered = useMemo(() => {
    if (!query) return options
    const q = query.toLowerCase()
    return options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [query, options])

  // Group filtered options
  const grouped = useMemo(() => {
    const hasGroups = filtered.some(o => o.group)
    if (!hasGroups) return null
    const map = new Map<string, SelectOption[]>()
    for (const o of filtered) {
      const g = o.group ?? ''
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(o)
    }
    return map
  }, [filtered])

  // Flat list for keyboard nav
  const flatFiltered = filtered

  // Position the dropdown relative to the button, rendered via portal
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 224) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: PointerEvent) => {
      const target = e.target as Node
      if (
        wrapRef.current && !wrapRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [open])

  useEffect(() => { setFocusIdx(-1) }, [filtered])

  useEffect(() => {
    if (open && searchable && inputRef.current) inputRef.current.focus()
  }, [open, searchable])

  useEffect(() => {
    if (focusIdx >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-option]')
      const item = items[focusIdx] as HTMLElement | undefined
      item?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusIdx])

  const select = (val: string) => {
    onChange(val)
    setOpen(false)
    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx(prev => (prev + 1) % flatFiltered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx(prev => (prev <= 0 ? flatFiltered.length - 1 : prev - 1))
    } else if (e.key === 'Enter' && focusIdx >= 0) {
      e.preventDefault()
      select(flatFiltered[focusIdx].value)
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  const renderOptions = () => {
    if (flatFiltered.length === 0) {
      return <div className="px-2.5 py-2 text-xs text-gray-400 italic">No matches</div>
    }

    if (grouped) {
      return Array.from(grouped.entries()).map(([group, opts]) => (
        <div key={group || '__ungrouped'}>
          {group && (
            <div className="sticky top-0 bg-gray-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              {group}
            </div>
          )}
          {opts.map((o) => {
            const idx = flatFiltered.indexOf(o)
            return (
              <div
                key={o.value}
                data-option
                onMouseDown={(e) => { e.preventDefault(); select(o.value) }}
                onMouseEnter={() => setFocusIdx(idx)}
                className={`cursor-pointer px-2.5 py-1.5 text-xs ${
                  idx === focusIdx ? 'bg-blue-50 text-blue-700' : o.value === value ? 'bg-gray-50 text-gray-800 font-medium' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {o.label}
              </div>
            )
          })}
        </div>
      ))
    }

    return flatFiltered.map((o, idx) => (
      <div
        key={o.value}
        data-option
        onMouseDown={(e) => { e.preventDefault(); select(o.value) }}
        onMouseEnter={() => setFocusIdx(idx)}
        className={`cursor-pointer px-2.5 py-1.5 text-xs ${
          idx === focusIdx ? 'bg-blue-50 text-blue-700' : o.value === value ? 'bg-gray-50 text-gray-800 font-medium' : 'text-gray-700 hover:bg-gray-50'
        }`}
      >
        {o.label}
      </div>
    ))
  }

  return (
    <div ref={wrapRef} className={className ?? ''}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-1 rounded-md bg-gray-50 px-2 py-1 text-xs ring-1 ring-gray-200 hover:ring-gray-300 focus:ring-blue-400 transition-colors"
      >
        <span className={`truncate ${value ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>
          {selectedLabel || placeholder}
        </span>
        <svg className="h-3 w-3 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] rounded-lg border border-gray-200 bg-white shadow-lg"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          onKeyDown={handleKeyDown}
        >
          {searchable && (
            <div className="border-b border-gray-100 p-1.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search..."
                className="w-full rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-800 ring-1 ring-gray-200 placeholder:text-gray-400 focus:outline-none focus:ring-blue-400"
                onKeyDown={handleKeyDown}
              />
            </div>
          )}
          <div ref={listRef} className="max-h-48 overflow-y-auto py-1">
            {renderOptions()}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/* ---------- Helpers ---------- */

function normalizeFields(fields: string[] | FieldDefinition[]): FieldDefinition[] {
  if (fields.length === 0) return []
  if (typeof fields[0] === 'string') {
    return (fields as string[]).map(name => ({ name, label: name, type: 'string' as const }))
  }
  return fields as FieldDefinition[]
}

function makeEmptyCondition(): FilterCondition {
  // Per-condition `connector` is no longer authored — the group-level
  // connector is the single source of truth within a group.
  const c: FilterCondition = { field: '', operator: 'contains' as FilterOperator, value: '' }
  stableKey(c) // pre-assign a stable key
  return c
}

function makeEmptyGroup(connector: 'AND' | 'OR' = 'AND'): ConditionGroup {
  const g: ConditionGroup = { connector, conditions: [makeEmptyCondition()] }
  stableKey(g) // pre-assign a stable key
  return g
}

/* ---------- ConditionRow ---------- */

interface ConditionRowProps {
  condition: FilterCondition
  fields: FieldDefinition[]
  groupedFields: Map<string, FieldDefinition[]> | null
  fieldMap: Map<string, FieldDefinition>
  onChange: (c: FilterCondition) => void
  onRemove: () => void
  canRemove: boolean
  /** Whether this row has a connector slot above it (true for every row after the first). */
  showConnector: boolean
  /** The group's connector — displayed in every within-group connector slot. */
  connectorValue: 'AND' | 'OR'
  /**
   * Only the FIRST connector slot in a group is settable; the rest echo the
   * group's value as a read-only label. Guarantees within-group homogeneity.
   */
  editable: boolean
  /** Toggle the group's connector. Only invoked on the editable slot. */
  onToggleGroupConnector: () => void
}

function ConditionRow({
  condition: c,
  fields,
  groupedFields,
  fieldMap,
  onChange,
  onRemove,
  canRemove,
  showConnector,
  connectorValue,
  editable,
  onToggleGroupConnector,
}: ConditionRowProps) {
  const getFieldDef = (name: string): FieldDefinition =>
    fieldMap.get(name) ?? { name, label: name, type: 'string' }

  const fieldDef = getFieldDef(c.field)
  const operators = c.field ? (OPERATORS_BY_TYPE[fieldDef.type] ?? ALL_OPERATORS) : OPERATORS_BY_TYPE.string
  const needsValue = !NO_VALUE_OPERATORS.has(c.operator)
  const isEnum = fieldDef.type === 'enum' && fieldDef.enumValues
  const hasSuggestions = fieldDef.type === 'string' && fieldDef.suggestions && fieldDef.suggestions.length > 0 && (c.operator === 'equals' || c.operator === 'not_equals')

  const fieldOptions: SelectOption[] = useMemo(() => {
    if (groupedFields) {
      const opts: SelectOption[] = []
      for (const [group, gFields] of groupedFields.entries()) {
        for (const f of gFields) opts.push({ value: f.name, label: f.label, group: group || undefined })
      }
      return opts
    }
    return fields.map(f => ({ value: f.name, label: f.label }))
  }, [fields, groupedFields])

  const updateField = (newField: string) => {
    const def = getFieldDef(newField)
    const validOps = OPERATORS_BY_TYPE[def.type] ?? ALL_OPERATORS
    const operator = validOps.includes(c.operator) ? c.operator : validOps[0]
    onChange({ ...c, field: newField, operator, value: '' })
  }

  return (
    <div>
      {showConnector && (
        <div className="flex items-center py-0.5 pl-1">
          {editable ? (
            <button
              type="button"
              onClick={onToggleGroupConnector}
              title="Toggle AND/OR for this group"
              className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                connectorValue === 'OR'
                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                  : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
              }`}
            >
              {connectorValue}
            </button>
          ) : (
            <span
              title="Within-group connector is set by the first slot"
              className={`select-none rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider opacity-60 ${
                connectorValue === 'OR' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {connectorValue}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-1.5 py-1">
        <SearchableSelect
          value={c.field}
          onChange={updateField}
          options={fieldOptions}
          placeholder="field..."
          className="max-w-[150px] shrink-0"
        />
        <SearchableSelect
          value={c.operator}
          onChange={(val) => onChange({ ...c, operator: val as FilterOperator })}
          options={operators.map(op => ({ value: op, label: OPERATOR_LABELS[op] }))}
          placeholder="operator..."
          className="max-w-[120px] shrink-0"
          searchable={false}
        />
        {needsValue && (
          <>
            {isEnum ? (
              <SearchableSelect
                value={String(c.value)}
                onChange={(val) => onChange({ ...c, value: val })}
                options={fieldDef.enumValues!.map(v => ({ value: v, label: v }))}
                placeholder="select..."
                className="min-w-0 flex-1"
              />
            ) : hasSuggestions ? (
              <SuggestInput
                value={String(c.value)}
                onChange={(val) => onChange({ ...c, value: val })}
                suggestions={fieldDef.suggestions!}
                placeholder="value"
                className="w-full rounded-md border-0 bg-gray-50 px-2 py-1 text-xs text-gray-800 ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400"
              />
            ) : (
              <input
                value={String(c.value)}
                onChange={(e) => onChange({ ...c, value: e.target.value })}
                placeholder="value"
                type={fieldDef.type === 'number' ? 'number' : 'text'}
                className="min-w-0 flex-1 rounded-md border-0 bg-gray-50 px-2 py-1 text-xs text-gray-800 ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400"
              />
            )}
          </>
        )}
        {canRemove && (
          <button type="button" onClick={onRemove} className="ml-0.5 rounded p-0.5 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors" title="Remove condition">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------- GroupBlock ---------- */

interface GroupBlockProps {
  group: ConditionGroup
  groupIndex: number
  fields: FieldDefinition[]
  groupedFields: Map<string, FieldDefinition[]> | null
  fieldMap: Map<string, FieldDefinition>
  onChange: (g: ConditionGroup) => void
  onRemove: () => void
  canRemove: boolean
  /** True when this group has a connector slot above it (every group after the first). */
  showGroupConnector: boolean
  /** The top-level connector used to join every group. */
  topConnector: 'AND' | 'OR'
  /**
   * Only the FIRST between-group slot is settable; the rest echo the top-level
   * value as read-only. Guarantees between-group homogeneity.
   */
  topConnectorEditable: boolean
  onToggleTopConnector: () => void
}

function GroupBlock({
  group,
  fields,
  groupedFields,
  fieldMap,
  onChange,
  onRemove,
  canRemove,
  showGroupConnector,
  topConnector,
  topConnectorEditable,
  onToggleTopConnector,
}: GroupBlockProps) {
  const updateCondition = (idx: number, c: FilterCondition) => {
    // Transfer the stable key from the old condition to the updated one
    const oldKey = _keyMap.get(group.conditions[idx])
    if (oldKey) _keyMap.set(c, oldKey)
    const newGroup = { ...group, conditions: group.conditions.map((cc, i) => i === idx ? c : cc) }
    // Transfer group key
    const gk = _keyMap.get(group)
    if (gk) _keyMap.set(newGroup, gk)
    onChange(newGroup)
  }
  const removeCondition = (idx: number) => {
    const next = group.conditions.filter((_, i) => i !== idx)
    const newGroup = { ...group, conditions: next.length > 0 ? next : [makeEmptyCondition()] }
    const gk = _keyMap.get(group)
    if (gk) _keyMap.set(newGroup, gk)
    onChange(newGroup)
  }
  const addCondition = () => {
    const newGroup = { ...group, conditions: [...group.conditions, makeEmptyCondition()] }
    const gk = _keyMap.get(group)
    if (gk) _keyMap.set(newGroup, gk)
    onChange(newGroup)
  }
  const toggleGroupConnector = () => {
    const current = group.connector ?? 'AND'
    const newGroup: ConditionGroup = { ...group, connector: current === 'AND' ? 'OR' : 'AND' }
    const gk = _keyMap.get(group)
    if (gk) _keyMap.set(newGroup, gk)
    onChange(newGroup)
  }
  const totalConditions = group.conditions.length

  return (
    <div>
      {/* Between-group connector slot. Only the first slot (group index 1) is
          editable; subsequent slots echo the top-level value as read-only. */}
      {showGroupConnector && (
        <div className="flex items-center py-1.5 pl-1">
          {topConnectorEditable ? (
            <button
              type="button"
              onClick={onToggleTopConnector}
              title="Toggle AND/OR between all groups"
              className={`rounded px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                topConnector === 'OR'
                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                  : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
              }`}
            >
              {topConnector}
            </button>
          ) : (
            <span
              title="Between-group connector is set by the first slot"
              className={`select-none rounded px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider opacity-60 ${
                topConnector === 'OR' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {topConnector}
            </span>
          )}
        </div>
      )}

      {/* Group container */}
      <div className="rounded-lg border border-gray-200 bg-gray-50/70 p-2.5">
        {/* Group header: Where + remove */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Where</span>
          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
              title="Remove group"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {/* Conditions */}
        <div className="space-y-0">
          {group.conditions.map((c, ci) => (
            <ConditionRow
              key={stableKey(c)}
              condition={c}
              fields={fields}
              groupedFields={groupedFields}
              fieldMap={fieldMap}
              onChange={(updated) => updateCondition(ci, updated)}
              onRemove={() => removeCondition(ci)}
              canRemove={totalConditions > 1}
              showConnector={ci > 0}
              connectorValue={group.connector ?? 'AND'}
              editable={ci === 1}
              onToggleGroupConnector={toggleGroupConnector}
            />
          ))}
        </div>

        {/* Add filter */}
        <button
          type="button"
          onClick={addCondition}
          className="mt-1.5 flex items-center gap-1 text-[10px] text-gray-400 hover:text-blue-600 transition-colors"
        >
          <span className="text-sm leading-none">+</span> Add filter
        </button>
      </div>
    </div>
  )
}

/* ---------- Main: GroupedFilterBuilder ---------- */

interface GroupedFilterBuilderProps {
  value: GroupedFilter
  onChange: (value: GroupedFilter) => void
  availableFields: string[] | FieldDefinition[]
}

export function GroupedFilterBuilder({
  value,
  onChange,
  availableFields,
}: GroupedFilterBuilderProps) {
  const fields = normalizeFields(availableFields)
  const fieldMap = useMemo(() => new Map(fields.map(f => [f.name, f])), [fields])

  const groupedFields = useMemo(() => {
    const hasGroups = fields.some(f => f.group)
    if (!hasGroups) return null
    const groups = new Map<string, FieldDefinition[]>()
    for (const f of fields) {
      const g = f.group ?? ''
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(f)
    }
    return groups
  }, [fields])

  const updateGroup = (idx: number, g: ConditionGroup) => {
    // g already has the key transferred from GroupBlock handlers
    onChange({ ...value, groups: value.groups.map((gg, i) => i === idx ? g : gg) })
  }
  const removeGroup = (idx: number) => {
    const next = value.groups.filter((_, i) => i !== idx)
    onChange({ ...value, groups: next.length > 0 ? next : [makeEmptyGroup()] })
  }
  const addGroup = () => {
    onChange({ ...value, groups: [...value.groups, makeEmptyGroup()] })
  }
  const addFilter = () => {
    // Add a filter to the last group
    const lastIdx = value.groups.length - 1
    const lastGroup = value.groups[lastIdx]
    const updatedLast = { ...lastGroup, conditions: [...lastGroup.conditions, makeEmptyCondition()] }
    // Transfer group key
    const gk = _keyMap.get(lastGroup)
    if (gk) _keyMap.set(updatedLast, gk)
    onChange({ ...value, groups: value.groups.map((g, i) => i === lastIdx ? updatedLast : g) })
  }
  const toggleTopConnector = () => {
    // Between-group connector is top-level only; strip any per-group
    // groupConnector values so the invariant is visibly enforced in the data.
    const current = value.groupConnector ?? 'AND'
    const newConnector: 'AND' | 'OR' = current === 'AND' ? 'OR' : 'AND'
    onChange({
      ...value,
      groupConnector: newConnector,
      groups: value.groups.map(g => {
        if (g.groupConnector === undefined) return g
        const { groupConnector: _dropped, ...rest } = g
        const newG: ConditionGroup = { ...rest }
        const gk = _keyMap.get(g)
        if (gk) _keyMap.set(newG, gk)
        return newG
      }),
    })
  }

  return (
    <div>
      {/* Groups */}
      <div className="space-y-0">
        {value.groups.map((group, gi) => (
          <GroupBlock
            key={stableKey(group)}
            group={group}
            groupIndex={gi}
            fields={fields}
            groupedFields={groupedFields}
            fieldMap={fieldMap}
            onChange={(g) => updateGroup(gi, g)}
            onRemove={() => removeGroup(gi)}
            canRemove={value.groups.length > 1}
            showGroupConnector={gi > 0}
            topConnector={value.groupConnector ?? 'AND'}
            topConnectorEditable={gi === 1}
            onToggleTopConnector={toggleTopConnector}
          />
        ))}
      </div>

      {/* Bottom actions */}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={addFilter}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
        >
          <span className="text-sm leading-none">+</span> Add Filter
        </button>
        <button
          type="button"
          onClick={addGroup}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
        >
          <span className="text-sm leading-none">⊞</span> Add Group
        </button>
      </div>

      {/* Formula preview — compiled WHERE clause for the current filter. */}
      <FormulaPreview value={value} fieldMap={fieldMap} />
    </div>
  )
}

/* ---------- Formula preview ---------- */

function formatValue(v: string | number | string[] | undefined): string {
  if (v === undefined || v === '') return '""'
  if (Array.isArray(v)) return `[${v.map(x => `"${x}"`).join(', ')}]`
  return typeof v === 'number' ? String(v) : `"${v}"`
}

/**
 * Render a GroupedFilter as a compact logical formula using the group-level
 * and top-level connectors only — mirrors what the backend now evaluates.
 */
export function formatGroupedFilter(
  value: GroupedFilter,
  fieldMap?: Map<string, FieldDefinition>,
): string {
  if (!value?.groups?.length) return ''
  const labelFor = (field: string) => fieldMap?.get(field)?.label ?? field
  const groupStrs = value.groups
    .map(g => {
      const parts = g.conditions
        .filter(c => c.field)
        .map(c => {
          const label = labelFor(c.field)
          const op = OPERATOR_LABELS[c.operator] ?? c.operator
          return NO_VALUE_OPERATORS.has(c.operator)
            ? `${label} ${op}`
            : `${label} ${op} ${formatValue(c.value)}`
        })
      if (parts.length === 0) return ''
      if (parts.length === 1) return parts[0]
      return `(${parts.join(` ${g.connector ?? 'AND'} `)})`
    })
    .filter(s => s.length > 0)
  if (groupStrs.length === 0) return ''
  if (groupStrs.length === 1) return groupStrs[0]
  return groupStrs.join(` ${value.groupConnector ?? 'AND'} `)
}

function FormulaPreview({
  value,
  fieldMap,
}: {
  value: GroupedFilter
  fieldMap: Map<string, FieldDefinition>
}) {
  const text = formatGroupedFilter(value, fieldMap)
  if (!text) return null
  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/70 px-3 py-2">
      <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400">
        Preview
      </div>
      <code className="block break-words font-mono text-[11px] text-gray-700">
        {text}
      </code>
    </div>
  )
}

/* ---------- Utility exports ---------- */

/**
 * Normalize a GroupedFilter to the UI's homogeneity invariants:
 *   - Within each group, conditions use a single `group.connector` —
 *     any per-condition `connector` is dropped on load.
 *   - Between groups, a single top-level `groupConnector` is used —
 *     per-group `groupConnector` values are dropped on load.
 *
 * When legacy data conflicts (e.g. groups with differing groupConnector),
 * the first non-default per-group value wins so the most specific existing
 * choice survives; otherwise the top-level value is kept.
 */
export function normalizeGroupedFilter(
  g: GroupedFilter | null | undefined,
): GroupedFilter {
  if (!g || !g.groups || g.groups.length === 0) {
    return { groupConnector: 'AND', groups: [makeEmptyGroup()] }
  }
  const explicitPerGroup = g.groups
    .slice(1)
    .map(grp => grp.groupConnector)
    .filter((c): c is 'AND' | 'OR' => c === 'AND' || c === 'OR')
  const topLevel: 'AND' | 'OR' =
    explicitPerGroup[0] ?? g.groupConnector ?? 'AND'
  return {
    groupConnector: topLevel,
    groups: g.groups.map(grp => ({
      connector: grp.connector ?? 'AND',
      conditions: (grp.conditions ?? []).map(c => {
        // Drop any per-condition connector; group.connector is source of truth.
        const { connector: _ignored, ...rest } = c
        return rest as FilterCondition
      }),
      // grp.groupConnector is intentionally not copied — only top-level is used.
    })),
  }
}

/** Convert a flat FilterCondition[] to GroupedFilter (single group, all AND). */
export function conditionsToGrouped(conditions: FilterCondition[]): GroupedFilter {
  if (conditions.length === 0) return { groupConnector: 'AND', groups: [makeEmptyGroup()] }

  // Try to detect groups from connector boundaries:
  // Consecutive conditions connected by the same connector form a group.
  // When the connector changes, a new group starts.
  const groups: ConditionGroup[] = []
  let currentGroup: FilterCondition[] = [conditions[0]]
  let currentConnector: 'AND' | 'OR' = conditions[0].connector || 'AND'

  for (let i = 1; i < conditions.length; i++) {
    const prevConnector = conditions[i - 1].connector || 'AND'
    if (prevConnector === currentConnector) {
      currentGroup.push(conditions[i])
    } else {
      groups.push({ connector: currentConnector, conditions: currentGroup })
      currentGroup = [conditions[i]]
      currentConnector = prevConnector
    }
  }
  groups.push({ connector: currentConnector, conditions: currentGroup })

  // Infer top-level connector: if all groups have the same internal connector, use the opposite
  const groupConnector = groups.length > 1 ? (currentConnector === 'AND' ? 'OR' : 'AND') : 'AND'

  return { groupConnector, groups }
}

/* ---------- Backward-compatible flat FilterConditionBuilder ---------- */

/**
 * Legacy wrapper: accepts flat FilterCondition[] and renders via GroupedFilterBuilder.
 * Used by ClassificationPage, OverrideRulesPage, SuppliersPage.
 */
interface FlatFilterConditionBuilderProps {
  conditions: FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  availableFields: string[] | FieldDefinition[]
  compact?: boolean
}

export default function FilterConditionBuilder({
  conditions,
  onChange,
  availableFields,
}: FlatFilterConditionBuilderProps) {
  const grouped = useMemo(() => conditionsToGrouped(conditions), [conditions])

  const handleChange = useCallback((g: GroupedFilter) => {
    onChange(groupedToConditions(g))
  }, [onChange])

  return (
    <GroupedFilterBuilder
      value={grouped}
      onChange={handleChange}
      availableFields={availableFields}
    />
  )
}

export { OPERATOR_LABELS, ALL_OPERATORS as OPERATORS, NO_VALUE_OPERATORS, makeEmptyGroup }
// normalizeGroupedFilter and formatGroupedFilter are already exported above at their definitions.
export type { FieldDefinition, FieldType } from '../../shared/types/transactions'
export type { GroupedFilter, ConditionGroup } from '../../shared/types/transactions'
