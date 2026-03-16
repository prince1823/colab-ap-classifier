import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import type { FilterCondition, FilterOperator, FieldType, FieldDefinition, ConditionGroup, GroupedFilter } from '../../shared/types/transactions'

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
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => {
    if (!value) return suggestions
    const q = value.toLowerCase()
    return suggestions.filter(s => s.toLowerCase().includes(q))
  }, [value, suggestions])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
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
          className="absolute left-0 top-full z-50 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
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

/* ---------- Helpers ---------- */

function normalizeFields(fields: string[] | FieldDefinition[]): FieldDefinition[] {
  if (fields.length === 0) return []
  if (typeof fields[0] === 'string') {
    return (fields as string[]).map(name => ({ name, label: name, type: 'string' as const }))
  }
  return fields as FieldDefinition[]
}

function makeEmptyCondition(): FilterCondition {
  return { field: '', operator: 'contains' as FilterOperator, value: '', connector: 'AND' }
}

function makeEmptyGroup(connector: 'AND' | 'OR' = 'AND'): ConditionGroup {
  return { connector, conditions: [makeEmptyCondition()] }
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
  showConnector: boolean
  groupConnector: 'AND' | 'OR'
  onToggleConnector: () => void
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
  groupConnector,
  onToggleConnector,
}: ConditionRowProps) {
  const getFieldDef = (name: string): FieldDefinition =>
    fieldMap.get(name) ?? { name, label: name, type: 'string' }

  const fieldDef = getFieldDef(c.field)
  const operators = c.field ? (OPERATORS_BY_TYPE[fieldDef.type] ?? ALL_OPERATORS) : OPERATORS_BY_TYPE.string
  const needsValue = !NO_VALUE_OPERATORS.has(c.operator)
  const isEnum = fieldDef.type === 'enum' && fieldDef.enumValues
  const hasSuggestions = fieldDef.type === 'string' && fieldDef.suggestions && fieldDef.suggestions.length > 0 && (c.operator === 'equals' || c.operator === 'not_equals')

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
          <button
            onClick={onToggleConnector}
            className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              groupConnector === 'OR'
                ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
            }`}
          >
            {groupConnector}
          </button>
        </div>
      )}
      <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-1.5 py-1">
        <select
          value={c.field as string}
          onChange={(e) => updateField(e.target.value)}
          className="max-w-[130px] shrink-0 rounded-md border-0 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-800 ring-1 ring-gray-200 focus:ring-blue-400"
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
        <select
          value={c.operator}
          onChange={(e) => onChange({ ...c, operator: e.target.value as FilterOperator })}
          className="max-w-[110px] shrink-0 rounded-md border-0 bg-gray-50 px-2 py-1 text-xs text-gray-600 ring-1 ring-gray-200 focus:ring-blue-400"
        >
          {operators.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
        </select>
        {needsValue && (
          <>
            {isEnum ? (
              <select
                value={String(c.value)}
                onChange={(e) => onChange({ ...c, value: e.target.value })}
                className="min-w-0 flex-1 rounded-md border-0 bg-gray-50 px-2 py-1 text-xs text-gray-800 ring-1 ring-gray-200 focus:ring-blue-400"
              >
                <option value="">select...</option>
                {fieldDef.enumValues!.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
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
          <button onClick={onRemove} className="ml-0.5 rounded p-0.5 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors" title="Remove condition">
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
  /** Connector to the PREVIOUS group */
  showGroupConnector: boolean
  /** This group's connector to the previous group */
  topConnector: 'AND' | 'OR'
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
  onToggleTopConnector,
}: GroupBlockProps) {
  const updateCondition = (idx: number, c: FilterCondition) => {
    onChange({ ...group, conditions: group.conditions.map((cc, i) => i === idx ? c : cc) })
  }
  const removeCondition = (idx: number) => {
    const next = group.conditions.filter((_, i) => i !== idx)
    onChange({ ...group, conditions: next.length > 0 ? next : [makeEmptyCondition()] })
  }
  const addCondition = () => {
    onChange({ ...group, conditions: [...group.conditions, makeEmptyCondition()] })
  }
  const toggleGroupConnector = () => {
    onChange({ ...group, connector: group.connector === 'AND' ? 'OR' : 'AND' })
  }
  const totalConditions = group.conditions.length

  return (
    <div>
      {/* Top-level connector between groups — each one toggles independently */}
      {showGroupConnector && (
        <div className="flex items-center py-1.5 pl-1">
          <button
            onClick={onToggleTopConnector}
            className={`rounded px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              topConnector === 'OR'
                ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
            }`}
          >
            {topConnector}
          </button>
        </div>
      )}

      {/* Group container */}
      <div className="rounded-lg border border-gray-200 bg-gray-50/70 p-2.5">
        {/* Group header: Where + remove */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Where</span>
          {canRemove && (
            <button
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
              key={ci}
              condition={c}
              fields={fields}
              groupedFields={groupedFields}
              fieldMap={fieldMap}
              onChange={(updated) => updateCondition(ci, updated)}
              onRemove={() => removeCondition(ci)}
              canRemove={totalConditions > 1}
              showConnector={ci > 0}
              groupConnector={group.connector}
              onToggleConnector={toggleGroupConnector}
            />
          ))}
        </div>

        {/* Add filter */}
        <button
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
    const lastGroup = value.groups[value.groups.length - 1]
    const updatedLast = { ...lastGroup, conditions: [...lastGroup.conditions, makeEmptyCondition()] }
    onChange({ ...value, groups: value.groups.map((g, i) => i === value.groups.length - 1 ? updatedLast : g) })
  }
  const toggleTopConnector = (groupIdx: number) => {
    // Toggle the connector on this specific group (how it connects to the previous group)
    const currentConnector = value.groups[groupIdx]?.groupConnector ?? value.groupConnector
    const newConnector = currentConnector === 'AND' ? 'OR' : 'AND'
    onChange({
      ...value,
      groups: value.groups.map((g, i) => i === groupIdx ? { ...g, groupConnector: newConnector } : g),
    })
  }

  /** Build logic expression preview */
  const logicExpression = useMemo(() => {
    const validGroups = value.groups.filter(g => g.conditions.some(c => c.field))
    if (validGroups.length === 0) return null

    let letterIdx = 0
    const groupExprs: string[] = []
    const groupConnectors: string[] = [] // connector before each group (except first)

    for (let gi = 0; gi < validGroups.length; gi++) {
      const group = validGroups[gi]
      const validConds = group.conditions.filter(c => c.field)
      if (validConds.length === 0) continue
      const letters = validConds.map(() => String.fromCharCode(65 + letterIdx++))
      if (letters.length === 1) {
        groupExprs.push(letters[0])
      } else {
        groupExprs.push(`(${letters.join(` ${group.connector} `)})`)
      }
      if (gi > 0) {
        groupConnectors.push(group.groupConnector ?? value.groupConnector)
      }
    }

    if (groupExprs.length <= 1) return groupExprs[0] || null
    let expr = groupExprs[0]
    for (let i = 1; i < groupExprs.length; i++) {
      expr += ` ${groupConnectors[i - 1]} ${groupExprs[i]}`
    }
    return expr
  }, [value])

  return (
    <div>
      {/* Logic expression preview — removed */}

      {/* Groups */}
      <div className="space-y-0">
        {value.groups.map((group, gi) => (
          <GroupBlock
            key={gi}
            group={group}
            groupIndex={gi}
            fields={fields}
            groupedFields={groupedFields}
            fieldMap={fieldMap}
            onChange={(g) => updateGroup(gi, g)}
            onRemove={() => removeGroup(gi)}
            canRemove={value.groups.length > 1}
            showGroupConnector={gi > 0}
            topConnector={group.groupConnector ?? value.groupConnector}
            onToggleTopConnector={() => toggleTopConnector(gi)}
          />
        ))}
      </div>

      {/* Bottom actions */}
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={addFilter}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
        >
          <span className="text-sm leading-none">+</span> Add Filter
        </button>
        <button
          onClick={addGroup}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
        >
          <span className="text-sm leading-none">⊞</span> Add Group
        </button>
      </div>
    </div>
  )
}

/* ---------- Utility exports ---------- */

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

/** Convert GroupedFilter back to flat FilterCondition[] for backward compat. */
export function groupedToConditions(grouped: GroupedFilter): FilterCondition[] {
  const result: FilterCondition[] = []
  for (let gi = 0; gi < grouped.groups.length; gi++) {
    const group = grouped.groups[gi]
    for (let ci = 0; ci < group.conditions.length; ci++) {
      const c = { ...group.conditions[ci] }
      // Within a group, conditions are connected by the group's connector
      if (ci < group.conditions.length - 1) {
        c.connector = group.connector
      } else if (gi < grouped.groups.length - 1) {
        // Last condition in group — connector to next group
        c.connector = grouped.groupConnector
      }
      result.push(c)
    }
  }
  return result
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
export type { FieldDefinition, FieldType } from '../../shared/types/transactions'
export type { GroupedFilter, ConditionGroup } from '../../shared/types/transactions'
