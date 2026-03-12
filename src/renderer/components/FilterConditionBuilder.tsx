import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
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

/** Autocomplete input — text input with dropdown suggestions */
function AutocompleteInput({
  value,
  onChange,
  onFetchSuggestions,
  field,
  placeholder = 'value',
  type = 'text',
  className,
}: {
  value: string
  onChange: (val: string) => void
  onFetchSuggestions: (field: string, query: string) => Promise<string[]>
  field: string
  placeholder?: string
  type?: string
  className?: string
}) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Fetch suggestions on input change
  const fetchSuggestions = useCallback(
    (query: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(async () => {
        if (!field) {
          setSuggestions([])
          return
        }
        try {
          const results = await onFetchSuggestions(field, query)
          setSuggestions(results)
          setOpen(results.length > 0)
          setHighlightIdx(-1)
        } catch {
          setSuggestions([])
        }
      }, 150)
    },
    [field, onFetchSuggestions],
  )

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Cleanup debounce on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    onChange(val)
    fetchSuggestions(val)
  }

  const handleFocus = () => {
    // Show suggestions on focus (fetch with current value)
    fetchSuggestions(value)
  }

  const selectSuggestion = (val: string) => {
    onChange(val)
    setOpen(false)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1))
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault()
      selectSuggestion(suggestions[highlightIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="autocomplete-wrap">
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        type={type}
        className={className}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div className="autocomplete-dropdown">
          {suggestions.map((s, idx) => (
            <div
              key={s}
              className={`autocomplete-option ${idx === highlightIdx ? 'highlighted' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s) }}
              onMouseEnter={() => setHighlightIdx(idx)}
            >
              {value ? highlightMatch(s, value) : s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Highlight the matching substring in a suggestion */
function highlightMatch(text: string, query: string) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <strong className="autocomplete-match">{text.slice(idx, idx + query.length)}</strong>
      {text.slice(idx + query.length)}
    </>
  )
}

interface FilterConditionBuilderProps {
  conditions: FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  /** Accept either string[] (backward compat) or FieldDefinition[] for richer UI */
  availableFields: string[] | FieldDefinition[]
  compact?: boolean
  /** Optional callback to fetch autocomplete suggestions for a field. Receives field name and current query string. */
  onFetchSuggestions?: (field: string, query: string) => Promise<string[]>
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
  onFetchSuggestions,
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
    onChange(conditions.map((c, i) => {
      if (i === index) return { ...c, field: newField, operator, value: '' }
      // Auto-set previous condition's connector to OR when same field is selected
      if (i === index - 1 && c.field === newField) return { ...c, connector: 'OR' }
      return c
    }))
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

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className={`${textSize} font-medium text-gray-600`}>Conditions</label>
        <button onClick={addCondition} className={`${textSize} text-blue-600 hover:text-blue-800`}>+ Add condition</button>
      </div>
      <div className="space-y-0">
        {conditions.map((c, i) => {
          const fieldDef = getFieldDef(c.field)
          const operators = c.field ? getOperatorsForField(c.field) : ALL_OPERATORS
          const needsValue = !NO_VALUE_OPERATORS.has(c.operator)
          const isEnum = fieldDef.type === 'enum' && fieldDef.enumValues

          return (
            <div key={i}>
              <div className={`flex items-center gap-0 rounded-lg border border-gray-200 bg-gray-50 px-1 py-1`}>
                <select
                  value={c.field as string}
                  onChange={(e) => updateField(i, e.target.value)}
                  className={`rounded-md border-0 bg-white ${padSize} ${textSize} font-medium text-gray-800 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
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
                <span className={`px-1.5 text-[10px] text-gray-400 select-none`}>&rarr;</span>
                <select
                  value={c.operator}
                  onChange={(e) => updateCondition(i, 'operator', e.target.value)}
                  className={`rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-600 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
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
                    ) : onFetchSuggestions && fieldDef.type === 'string' ? (
                      <AutocompleteInput
                        value={String(c.value)}
                        onChange={(val) => updateCondition(i, 'value', val)}
                        onFetchSuggestions={onFetchSuggestions}
                        field={c.field}
                        placeholder="value"
                        type="text"
                        className={`min-w-0 flex-1 rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-800 shadow-sm ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400`}
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
