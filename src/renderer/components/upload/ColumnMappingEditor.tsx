import { useState, useEffect, useRef } from 'react'
import type { ColumnMappingResult, ColumnMappingWithPriority } from '../../../shared/types/column-mapping'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'

interface ColSettings {
  action: 'include' | 'drop'
  priority: number
}

interface Props {
  suggestion: ColumnMappingResult
  csvColumns: string[]
  onMappingChange: (mapping: ColumnMappingWithPriority) => void
}

function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function buildMapping(
  requiredMappings: Record<string, string>,
  csvColumns: string[],
  optionalSettings: Record<string, ColSettings>
): ColumnMappingWithPriority {
  const result: ColumnMappingWithPriority = {}
  for (const [canonical, csv] of Object.entries(requiredMappings)) {
    if (csv) result[canonical] = { csvColumn: csv }
  }
  const usedRequired = new Set(Object.values(requiredMappings).filter(Boolean))
  const included = csvColumns
    .filter((col) => !usedRequired.has(col))
    .map((col) => ({ col, s: optionalSettings[col] ?? { action: 'drop' as const, priority: 1 } }))
    .filter(({ s }) => s.action === 'include')
    .sort((a, b) => a.s.priority - b.s.priority)
  for (const { col, s } of included) {
    result[toSnakeCase(col)] = { csvColumn: col, classificationPriority: s.priority }
  }
  return result
}

function deriveInitialState(
  suggestion: ColumnMappingResult,
  csvColumns: string[]
): { requiredMappings: Record<string, string>; optionalSettings: Record<string, ColSettings> } {
  const REQUIRED = REQUIRED_CANONICAL_COLUMNS as readonly string[]

  const requiredMappings: Record<string, string> = {}
  for (const canonical of REQUIRED) {
    requiredMappings[canonical] = suggestion.mappings[canonical] ?? ''
  }

  const usedRequired = new Set(Object.values(requiredMappings).filter(Boolean))

  // CSV cols the LLM mapped to non-required canonicals → default to Include
  const llmNonRequired = new Set<string>()
  for (const [canonical, csv] of Object.entries(suggestion.mappings)) {
    if (!REQUIRED.includes(canonical) && csv && !usedRequired.has(csv)) {
      llmNonRequired.add(csv)
    }
  }

  const optionalSettings: Record<string, ColSettings> = {}
  let autoPriority = 1
  for (const col of csvColumns) {
    if (usedRequired.has(col)) continue
    optionalSettings[col] = llmNonRequired.has(col)
      ? { action: 'include', priority: autoPriority++ }
      : { action: 'drop', priority: 1 }
  }

  return { requiredMappings, optionalSettings }
}

const REQUIRED_LABELS: Record<string, string> = {
  supplier_name: 'Supplier Name',
  spend_amount: 'Spend Amount',
  invoice_date: 'Invoice Date',
}

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-red-100 text-red-700',
}

export default function ColumnMappingEditor({ suggestion, csvColumns, onMappingChange }: Props) {
  const { requiredMappings: initReq, optionalSettings: initOpt } = deriveInitialState(suggestion, csvColumns)

  const [requiredMappings, setRequiredMappings] = useState<Record<string, string>>(initReq)
  const [optionalSettings, setOptionalSettings] = useState<Record<string, ColSettings>>(initOpt)

  const prevKey = useRef('')
  useEffect(() => {
    const key = JSON.stringify(suggestion.mappings)
    if (key === prevKey.current) return
    prevKey.current = key
    const { requiredMappings: req, optionalSettings: opt } = deriveInitialState(suggestion, csvColumns)
    setRequiredMappings(req)
    setOptionalSettings(opt)
    onMappingChange(buildMapping(req, csvColumns, opt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion])

  const usedRequired = new Set(Object.values(requiredMappings).filter(Boolean))
  const optionalCols = csvColumns.filter((col) => !usedRequired.has(col))

  const handleRequiredChange = (canonical: string, csvCol: string) => {
    const updated = { ...requiredMappings, [canonical]: csvCol }
    setRequiredMappings(updated)
    onMappingChange(buildMapping(updated, csvColumns, optionalSettings))
  }

  const handleAction = (col: string, action: 'include' | 'drop') => {
    const updated = { ...optionalSettings, [col]: { ...optionalSettings[col], action } }
    setOptionalSettings(updated)
    onMappingChange(buildMapping(requiredMappings, csvColumns, updated))
  }

  const handlePriority = (col: string, priority: number) => {
    const updated = { ...optionalSettings, [col]: { ...optionalSettings[col], priority } }
    setOptionalSettings(updated)
    onMappingChange(buildMapping(requiredMappings, csvColumns, updated))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-gray-700">Column Mappings</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[suggestion.confidence] ?? ''}`}>
          {suggestion.confidence} confidence
        </span>
      </div>
      {suggestion.reasoning && <p className="text-xs text-gray-500">{suggestion.reasoning}</p>}

      {/* Required section */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Required</h4>
        <div className="space-y-2">
          {(REQUIRED_CANONICAL_COLUMNS as readonly string[]).map((canonical) => (
            <div key={canonical} className="flex items-center gap-3">
              <div className="w-44 flex-shrink-0 flex items-center gap-1.5">
                <span className="text-sm font-medium text-gray-700">{REQUIRED_LABELS[canonical]}</span>
                <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-700">required</span>
              </div>
              <span className="text-gray-400">&rarr;</span>
              <select
                value={requiredMappings[canonical] ?? ''}
                onChange={(e) => handleRequiredChange(canonical, e.target.value)}
                className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">-- Not mapped --</option>
                {csvColumns.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Optional section */}
      {optionalCols.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Other Columns</h4>
          <p className="mb-2 text-xs text-gray-400">
            Included columns are sent to the classifier. Set priority (1 = highest) to control ordering.
          </p>
          <div className="space-y-1.5">
            {optionalCols.map((col) => {
              const s = optionalSettings[col] ?? { action: 'drop' as const, priority: 1 }
              return (
                <div key={col} className="flex items-center gap-3">
                  <span className="flex-1 text-sm text-gray-700 truncate">{col}</span>
                  <select
                    value={s.action}
                    onChange={(e) => handleAction(col, e.target.value as 'include' | 'drop')}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                  >
                    <option value="include">Include</option>
                    <option value="drop">Drop</option>
                  </select>
                  {s.action === 'include' ? (
                    <input
                      type="number"
                      min={1}
                      value={s.priority}
                      onChange={(e) => handlePriority(col, Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-16 rounded-md border border-gray-300 px-2 py-1.5 text-sm text-center"
                      title="Priority (1 = highest)"
                    />
                  ) : (
                    <div className="w-16" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
