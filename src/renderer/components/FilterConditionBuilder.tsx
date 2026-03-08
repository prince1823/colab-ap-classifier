import type { FilterCondition, FilterOperator } from '../../shared/types/transactions'

const OPERATORS: FilterOperator[] = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'regex', 'in_list', 'is_null',
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
  greater_than: '>',
  less_than: '<',
  greater_than_or_equal: '≥',
  less_than_or_equal: '≤',
}

interface FilterConditionBuilderProps {
  conditions: FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  availableFields: string[]
  compact?: boolean
}

export default function FilterConditionBuilder({
  conditions,
  onChange,
  availableFields,
  compact = false,
}: FilterConditionBuilderProps) {
  const updateCondition = (index: number, field: keyof FilterCondition, value: string) => {
    onChange(conditions.map((c, i) => (i === index ? { ...c, [field]: value } : c)))
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
        {conditions.map((c, i) => (
          <div key={i}>
            <div className={`flex items-center gap-0 rounded-lg border border-gray-200 bg-gray-50 px-1 py-1`}>
              <select
                value={c.field as string}
                onChange={(e) => updateCondition(i, 'field', e.target.value)}
                className={`rounded-md border-0 bg-white ${padSize} ${textSize} font-medium text-gray-800 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
              >
                <option value="">field...</option>
                {availableFields.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
              <span className={`px-1.5 text-[10px] text-gray-400 select-none`}>&rarr;</span>
              <select
                value={c.operator}
                onChange={(e) => updateCondition(i, 'operator', e.target.value)}
                className={`rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-600 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400`}
              >
                {OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
              </select>
              {c.operator !== 'is_null' && (
                <>
                  <span className={`px-1.5 text-[10px] text-gray-400 select-none`}>&rarr;</span>
                  <input
                    value={String(c.value)}
                    onChange={(e) => updateCondition(i, 'value', e.target.value)}
                    placeholder="value"
                    className={`min-w-0 flex-1 rounded-md border-0 bg-white ${padSize} ${textSize} text-gray-800 shadow-sm ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400`}
                  />
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
        ))}
      </div>
    </div>
  )
}

export { OPERATOR_LABELS }
