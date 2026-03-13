import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import type { FilterCondition, FilterOperator, FieldType, FieldDefinition } from '../../shared/types/transactions'

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
  string: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex', 'in_list', 'is_null'],
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
  const listRef = useRef<HTMLUListElement>(null)

  // Filter suggestions by current value (case-insensitive)
  const filtered = useMemo(() => {
    if (!value) return suggestions
    const q = value.toLowerCase()
    return suggestions.filter(s => s.toLowerCase().includes(q))
  }, [value, suggestions])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Reset focus index when filtered list changes
  useEffect(() => { setFocusIdx(-1) }, [filtered])

  // Scroll focused item into view
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
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        type="text"
        className={className}
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute left-0 top-full z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
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
        </ul>
      )}
    </div>
  )
}

/* ---------- Main component ---------- */

interface FilterConditionBuilderProps {
  conditions: FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  /** Accept either string[] (backward compat) or FieldDefinition[] for richer UI */
  availableFields: string[] | FieldDefinition[]
  compact?: boolean
}

/** Normalize string[] to FieldDefinition[] for internal use */
function normalizeFields(fields: string[] | FieldDefinition[]): FieldDefinition[] {
  if (fields.length === 0) return []
  if (typeof fields[0] === 'string') {
    return (fields as string[]).map(name => ({ name, label: name, type: 'string' as const }))
  }
  return fields as FieldDefinition[]
}

export default function FilterConditionBuilder({
  conditions,
  onChange,
  availableFields,
  compact = false,
}: FilterConditionBuilderProps) {
  const fields = normalizeFields(availableFields)
  const fieldMap = new Map(fields.map(f => [f.name, f]))

  /** Group fields for <optgroup> rendering. Returns null if no groups are used. */
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

  const getFieldDef = (fieldName: string): FieldDefinition =>
    fieldMap.get(fieldName) ?? { name: fieldName, label: fieldName, type: 'string' }

  const getOperatorsForField = (fieldName: string): FilterOperator[] => {
    const def = getFieldDef(fieldName)
    return OPERATORS_BY_TYPE[def.type] ?? ALL_OPERATORS
  }

  const updateCondition = (index: number, key: keyof FilterCondition, value: string) => {
    onChange(conditions.map((c, i) => (i === index ? { ...c, [key]: value } : c)))
  }

  const updateField = (index: number, newField: string) => {
    const def = getFieldDef(newField)
    const validOps = OPERATORS_BY_TYPE[def.type]
    const currentOp = conditions[index].operator
    // Auto-switch operator if current one isn't valid for new field type
    const operator = validOps.includes(currentOp) ? currentOp : validOps[0]
    onChange(conditions.map((c, i) => (i === index ? { ...c, field: newField, operator, value: '' } : c)))
  }

  const addCondition = () => {
    onChange([...conditions, { field: '', operator: 'equals' as FilterOperator, value: '', connector: 'AND' }])
  }

  const toggleConnector = (index: number) => {
    onChange(conditions.map((c, i) => (i === index ? { ...c, connector: c.connector === 'AND' ? 'OR' : 'AND' } : c)))
  }

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index))
  }

  const textSize = compact ? 'text-[10px]' : 'text-xs'
  const padSize = compact ? 'px-2 py-1' : 'px-2.5 py-1.5'

  /** Build a logic expression string like "(A AND B) OR C" with proper grouping */
  const logicExpression = useMemo(() => {
    const validConditions = conditions.filter(c => c.field)
    if (validConditions.length < 2) return null

    // Label each condition as A, B, C, ...
    const labels = validConditions.map((_, i) => String.fromCharCode(65 + i))

    // Group consecutive conditions with the same connector, respecting AND > OR precedence
    // Build tokens: we group AND-connected items in parens when mixed with OR
    const connectors = validConditions.slice(0, -1).map(c => c.connector || 'AND')
    const hasMixed = connectors.includes('AND') && connectors.includes('OR')

    if (!hasMixed) {
      // All same connector — no parens needed
      const parts: string[] = []
      for (let i = 0; i < labels.length; i++) {
        parts.push(labels[i])
        if (i < connectors.length) parts.push(connectors[i])
      }
      return parts.join(' ')
    }

    // Mixed AND/OR — group AND-connected sequences in parens
    const groups: string[][] = [[labels[0]]]
    for (let i = 0; i < connectors.length; i++) {
      if (connectors[i] === 'AND') {
        groups[groups.length - 1].push(labels[i + 1])
      } else {
        groups.push([labels[i + 1]])
      }
    }

    return groups
      .map(g => g.length > 1 ? `(${g.join(' AND ')})` : g[0])
      .join(' OR ')
  }, [conditions])

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className={`${textSize} font-medium text-gray-600`}>Conditions</label>
        <button onClick={addCondition} className={`${textSize} text-blue-600 hover:text-blue-800`}>+ Add condition</button>
      </div>
      {logicExpression && (
        <div className="mb-2 rounded-md bg-gray-100 px-3 py-1.5">
          <span className="text-[10px] text-gray-400 mr-1.5">Logic:</span>
          <span className="text-[11px] font-mono font-medium text-gray-600">{logicExpression}</span>
        </div>
      )}
      <div className="space-y-0">
        {conditions.map((c, i) => {
          const fieldDef = getFieldDef(c.field)
          const operators = c.field ? getOperatorsForField(c.field) : ALL_OPERATORS
          const needsValue = !NO_VALUE_OPERATORS.has(c.operator)
          const isEnum = fieldDef.type === 'enum' && fieldDef.enumValues
          const hasSuggestions = fieldDef.type === 'string' && fieldDef.suggestions && fieldDef.suggestions.length > 0

          const conditionLabel = String.fromCharCode(65 + i)

          return (
            <div key={i}>
              <div className={`flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-1 py-1`}>
                {conditions.filter(cc => cc.field).length >= 2 && (
                  <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[9px] font-bold text-gray-500">{conditionLabel}</span>
                )}
                <select
                  value={c.field as string}
                  onChange={(e) => updateField(i, e.target.value)}
                  className={`max-w-[140px] shrink-0 rounded-md border-0 bg-white ${padSize} ${textSize} font-medium text-gray-800 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
                >
                  <option value="">field...</option>
                  {groupedFields ? (
                    Array.from(groupedFields.entries()).map(([group, gFields]) =>
                      group ? (
                        <optgroup key={group} label={group}>
                          {gFields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                        </optgroup>
                      ) : (
                        gFields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)
                      )
                    )
                  ) : (
                    fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)
                  )}
                </select>
                <span className={`px-1 text-[10px] text-gray-400 select-none`}>&rarr;</span>
                <select
                  value={c.operator}
                  onChange={(e) => updateCondition(i, 'operator', e.target.value)}
                  className={`max-w-[110px] shrink-0 rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-600 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
                >
                  {operators.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
                </select>
                {needsValue && (
                  <>
                    <span className={`px-1.5 text-[10px] text-gray-400 select-none`}>&rarr;</span>
                    {isEnum ? (
                      <select
                        value={String(c.value)}
                        onChange={(e) => updateCondition(i, 'value', e.target.value)}
                        className={`min-w-0 flex-1 rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-800 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
                      >
                        <option value="">select...</option>
                        {fieldDef.enumValues!.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    ) : hasSuggestions ? (
                      <SuggestInput
                        value={String(c.value)}
                        onChange={(val) => updateCondition(i, 'value', val)}
                        suggestions={fieldDef.suggestions!}
                        placeholder="value"
                        className={`w-full rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-800 shadow-sm ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400`}
                      />
                    ) : (
                      <input
                        value={String(c.value)}
                        onChange={(e) => updateCondition(i, 'value', e.target.value)}
                        placeholder="value"
                        type={fieldDef.type === 'number' ? 'number' : 'text'}
                        className={`min-w-0 flex-1 rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-800 shadow-sm ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400`}
                      />
                    )}
                  </>
                )}
                {conditions.length > 1 && (
                  <button onClick={() => removeCondition(i)} className="ml-1 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors" title="Remove condition">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
              {i < conditions.length - 1 && (
                <div className="flex justify-center py-1.5">
                  <button
                    onClick={() => toggleConnector(i)}
                    className={`rounded-full px-4 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                      c.connector === 'OR'
                        ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                        : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
                    }`}
                  >
                    {c.connector || 'AND'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export { OPERATOR_LABELS, ALL_OPERATORS as OPERATORS, NO_VALUE_OPERATORS }
export type { FieldDefinition, FieldType } from '../../shared/types/transactions'
