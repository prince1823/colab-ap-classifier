import { useState, useCallback } from 'react'
import type { QCConfig, FilterConditionQC } from '../../../shared/types/classification'
import { Plus, X, RotateCcw } from 'lucide-react'

interface FieldDef {
  field: string
  label: string
  type: 'boolean' | 'number'
}

const SCOPE_FIELDS: FieldDef[] = [
  { field: 'is_tail_spend', label: 'Is Tail Spend', type: 'boolean' },
  { field: 'is_researched', label: 'Is Researched', type: 'boolean' },
  { field: 'total_spend', label: 'Total Spend', type: 'number' },
  { field: 'transaction_count', label: 'Transaction Count', type: 'number' },
  { field: 'num_categories', label: 'Num Categories', type: 'number' },
]

const GATE_FIELDS: FieldDef[] = [
  { field: 'algorithmic_resolved', label: 'Algorithmic Resolved', type: 'boolean' },
  ...SCOPE_FIELDS,
]

const BOOLEAN_OPERATORS: FilterConditionQC['operator'][] = ['is_true', 'is_false']
const NUMBER_OPERATORS: FilterConditionQC['operator'][] = ['greater_than', 'less_than', 'equals', 'not_equals']

const OPERATOR_LABELS: Record<string, string> = {
  equals: '=',
  not_equals: '!=',
  greater_than: '>',
  less_than: '<',
  is_true: 'is true',
  is_false: 'is false',
  contains: 'contains',
}

function getOperators(fieldType: 'boolean' | 'number'): FilterConditionQC['operator'][] {
  return fieldType === 'boolean' ? BOOLEAN_OPERATORS : NUMBER_OPERATORS
}

interface Props {
  config: QCConfig
  defaults: QCConfig | null
  onChange: (config: QCConfig) => void
  scopeCount: number | null
  scopeCountLoading: boolean
}

function ConditionEditor({
  conditions,
  fields,
  onChange,
}: {
  conditions: FilterConditionQC[]
  fields: FieldDef[]
  onChange: (conditions: FilterConditionQC[]) => void
}) {
  const updateCondition = (index: number, updates: Partial<FilterConditionQC>) => {
    const next = conditions.map((c, i) => (i === index ? { ...c, ...updates } : c))
    // If field changed, reset operator and value to match new field type
    if (updates.field !== undefined) {
      const fieldDef = fields.find(f => f.field === updates.field)
      if (fieldDef) {
        const ops = getOperators(fieldDef.type)
        next[index] = { ...next[index], operator: ops[0], value: fieldDef.type === 'boolean' ? undefined : '' }
      }
    }
    onChange(next)
  }

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index))
  }

  const addCondition = () => {
    const firstField = fields[0]
    const ops = getOperators(firstField.type)
    onChange([...conditions, { field: firstField.field, operator: ops[0], value: firstField.type === 'boolean' ? undefined : '' }])
  }

  return (
    <div className="space-y-2">
      {conditions.map((cond, i) => {
        const fieldDef = fields.find(f => f.field === cond.field) ?? fields[0]
        const operators = getOperators(fieldDef.type)
        const showValue = fieldDef.type !== 'boolean'

        return (
          <div key={i} className="flex items-center gap-2">
            <select
              value={cond.field}
              onChange={e => updateCondition(i, { field: e.target.value })}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 outline-none focus:border-blue-400"
            >
              {fields.map(f => (
                <option key={f.field} value={f.field}>{f.label}</option>
              ))}
            </select>
            <select
              value={cond.operator}
              onChange={e => updateCondition(i, { operator: e.target.value as FilterConditionQC['operator'] })}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 outline-none focus:border-blue-400"
            >
              {operators.map(op => (
                <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
              ))}
            </select>
            {showValue && (
              <input
                type="number"
                value={typeof cond.value === 'boolean' ? '' : (cond.value ?? '')}
                onChange={e => updateCondition(i, { value: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="value"
                className="w-24 rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
              />
            )}
            <button
              onClick={() => removeCondition(i)}
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      <button
        onClick={addCondition}
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
      >
        <Plus size={12} />
        Add condition
      </button>
    </div>
  )
}

export default function QCSettingsForm({ config, defaults, onChange, scopeCount, scopeCountLoading }: Props) {
  const [expandedSections, setExpandedSections] = useState({ scope: true, algorithmic: true, llm: true })

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const updateScope = useCallback((scope: FilterConditionQC[]) => {
    onChange({ ...config, scope })
  }, [config, onChange])

  const updateAlgorithmic = useCallback((updates: Partial<QCConfig['algorithmic']>) => {
    onChange({ ...config, algorithmic: { ...config.algorithmic, ...updates } })
  }, [config, onChange])

  const updateLLM = useCallback((updates: Partial<QCConfig['llm']>) => {
    onChange({ ...config, llm: { ...config.llm, ...updates } })
  }, [config, onChange])

  const resetRules = useCallback(() => {
    if (defaults) {
      onChange({ ...config, llm: { ...config.llm, rules: defaults.llm.rules } })
    }
  }, [config, defaults, onChange])

  return (
    <div className="space-y-4">
      {/* Scope */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          onClick={() => toggleSection('scope')}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">Scope</span>
            {scopeCount !== null && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                scopeCountLoading ? 'bg-gray-100 text-gray-400' : 'bg-violet-100 text-violet-700'
              }`}>
                {scopeCountLoading ? '...' : `${scopeCount} suppliers match`}
              </span>
            )}
          </div>
          <svg className={`h-4 w-4 text-gray-400 transition-transform ${expandedSections.scope ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </button>
        {expandedSections.scope && (
          <div className="border-t border-gray-100 px-4 py-3">
            <p className="text-[11px] text-gray-400 mb-2">Filter which suppliers to include in QC. Leave empty to process all classified suppliers.</p>
            <ConditionEditor conditions={config.scope} fields={SCOPE_FIELDS} onChange={updateScope} />
          </div>
        )}
      </div>

      {/* Algorithmic Pass */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          onClick={() => toggleSection('algorithmic')}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">Algorithmic Pass</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              config.algorithmic.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
            }`}>
              {config.algorithmic.enabled ? 'ON' : 'OFF'}
            </span>
          </div>
          <svg className={`h-4 w-4 text-gray-400 transition-transform ${expandedSections.algorithmic ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </button>
        {expandedSections.algorithmic && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.algorithmic.enabled}
                onChange={e => updateAlgorithmic({ enabled: e.target.checked })}
                className="rounded border-gray-300 text-violet-600 focus:ring-violet-500"
              />
              <span className="text-xs text-gray-700">Enable algorithmic consolidation</span>
            </label>
            {config.algorithmic.enabled && (
              <div className="space-y-3 pl-6">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-gray-600">L3 Threshold</label>
                    <span className="text-xs font-semibold text-gray-800">{Math.round(config.algorithmic.l3Threshold * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0} max={100} step={1}
                    value={Math.round(config.algorithmic.l3Threshold * 100)}
                    onChange={e => updateAlgorithmic({ l3Threshold: Number(e.target.value) / 100 })}
                    className="w-full h-1.5 rounded-full bg-gray-200 accent-violet-600"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">If one L3 category has this % of spend, consolidate all transactions there.</p>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-gray-600">L2 Threshold</label>
                    <span className="text-xs font-semibold text-gray-800">{Math.round(config.algorithmic.l2Threshold * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0} max={100} step={1}
                    value={Math.round(config.algorithmic.l2Threshold * 100)}
                    onChange={e => updateAlgorithmic({ l2Threshold: Number(e.target.value) / 100 })}
                    className="w-full h-1.5 rounded-full bg-gray-200 accent-violet-600"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">If one L2 category has this % of spend, find dominant L3 within it and consolidate.</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* LLM Pass */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          onClick={() => toggleSection('llm')}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">LLM Pass</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              config.llm.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
            }`}>
              {config.llm.enabled ? 'ON' : 'OFF'}
            </span>
          </div>
          <svg className={`h-4 w-4 text-gray-400 transition-transform ${expandedSections.llm ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </button>
        {expandedSections.llm && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.llm.enabled}
                onChange={e => updateLLM({ enabled: e.target.checked })}
                className="rounded border-gray-300 text-violet-600 focus:ring-violet-500"
              />
              <span className="text-xs text-gray-700">Enable LLM review</span>
            </label>
            {config.llm.enabled && (
              <div className="space-y-3 pl-6">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1.5 block">Gate Conditions</label>
                  <p className="text-[10px] text-gray-400 mb-2">Only run LLM on suppliers matching these conditions.</p>
                  <ConditionEditor conditions={config.llm.gateConditions} fields={GATE_FIELDS} onChange={gc => updateLLM({ gateConditions: gc })} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-gray-600">Rules / Prompt</label>
                    {defaults && config.llm.rules !== defaults.llm.rules && (
                      <button
                        onClick={resetRules}
                        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-violet-600 transition-colors"
                      >
                        <RotateCcw size={10} />
                        Reset to default
                      </button>
                    )}
                  </div>
                  <textarea
                    value={config.llm.rules}
                    onChange={e => updateLLM({ rules: e.target.value })}
                    rows={5}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-xs text-gray-700 outline-none focus:border-violet-400 resize-y font-mono"
                    placeholder="QC rules for the LLM..."
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
