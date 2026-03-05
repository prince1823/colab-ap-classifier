import { useState, useEffect, useRef } from 'react'
import type { ColumnMapping, ColumnMappingResult } from '../../../shared/types/column-mapping'
import { CANONICAL_COLUMNS } from '../../../shared/canonical-columns'

interface Props {
  suggestion: ColumnMappingResult
  csvColumns: string[]
  onMappingChange: (mapping: ColumnMapping) => void
}

const UNMAPPED = '__unmapped__'

// Build aliases map from shared canonical column definitions
const ALIASES: Record<string, string[]> = Object.fromEntries(
  CANONICAL_COLUMNS.map((col) => [
    col.name,
    col.aliases.map((a) => a.toLowerCase()),
  ])
)

// Build a lookup for relevance badges
const RELEVANCE_MAP: Record<string, string> = Object.fromEntries(
  CANONICAL_COLUMNS.map((col) => [col.name, col.relevance])
)

const DESCRIPTION_MAP: Record<string, string> = Object.fromEntries(
  CANONICAL_COLUMNS.map((col) => [col.name, col.description])
)

function autoMap(llmMappings: ColumnMapping, unmappedCanonical: string[], csvColumns: string[]): ColumnMapping {
  const result = { ...llmMappings }
  const usedCsvCols = new Set(Object.values(result).map((v) => v.toLowerCase()))

  for (const canonical of unmappedCanonical) {
    if (result[canonical]) continue
    const aliases = ALIASES[canonical] || []
    const candidates = [canonical, ...aliases]

    for (const candidate of candidates) {
      const match = csvColumns.find(
        (csv) => csv.toLowerCase() === candidate.toLowerCase() && !usedCsvCols.has(csv.toLowerCase())
      )
      if (match) {
        result[canonical] = match
        usedCsvCols.add(match.toLowerCase())
        break
      }
    }
  }

  return result
}

const RELEVANCE_STYLES: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-blue-100 text-blue-700',
  low: 'bg-gray-100 text-gray-500',
}

export default function ColumnMappingEditor({
  suggestion,
  csvColumns,
  onMappingChange,
}: Props) {
  const [mapping, setMapping] = useState<ColumnMapping>(() =>
    autoMap(suggestion.mappings, suggestion.unmappedCanonicalColumns, csvColumns)
  )

  // Track the suggestion identity to avoid re-render loops.
  // Only re-run autoMap when the suggestion's underlying data actually changes.
  const prevSuggestionKey = useRef<string>('')
  useEffect(() => {
    const key = JSON.stringify(suggestion.mappings) + '|' + JSON.stringify(suggestion.unmappedCanonicalColumns)
    if (key === prevSuggestionKey.current) return // No actual change — skip
    prevSuggestionKey.current = key
    const enhanced = autoMap(suggestion.mappings, suggestion.unmappedCanonicalColumns, csvColumns)
    setMapping(enhanced)
    onMappingChange(enhanced)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion])

  const handleChange = (canonicalName: string, csvColumn: string) => {
    const updated = { ...mapping }
    if (csvColumn === UNMAPPED) {
      delete updated[canonicalName]
    } else {
      updated[canonicalName] = csvColumn
    }
    setMapping(updated)
    onMappingChange(updated)
  }

  // Use all 14 canonical columns from shared definition, ordered by relevance
  const allCanonical = CANONICAL_COLUMNS.map((col) => col.name)

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-700">Column Mappings</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              suggestion.confidence === 'high'
                ? 'bg-green-100 text-green-700'
                : suggestion.confidence === 'medium'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-red-100 text-red-700'
            }`}
          >
            {suggestion.confidence} confidence
          </span>
        </div>
        {suggestion.reasoning && (
          <p className="mb-3 text-xs text-gray-500">{suggestion.reasoning}</p>
        )}
        <div className="space-y-2">
          {allCanonical.map((canonicalName) => {
            const relevance = RELEVANCE_MAP[canonicalName]
            const description = DESCRIPTION_MAP[canonicalName]
            return (
              <div key={canonicalName} className="flex items-center gap-3">
                <div className="w-52 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700">{canonicalName}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${RELEVANCE_STYLES[relevance] || ''}`}>
                      {relevance}
                    </span>
                  </div>
                  {description && (
                    <p className="text-[11px] text-gray-400">{description}</p>
                  )}
                </div>
                <span className="text-gray-400">&rarr;</span>
                <select
                  value={mapping[canonicalName] ?? UNMAPPED}
                  onChange={(e) => handleChange(canonicalName, e.target.value)}
                  className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value={UNMAPPED}>-- Not mapped --</option>
                  {csvColumns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </div>

      {suggestion.unmappedClientColumns.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-amber-700">Unmapped CSV columns</h4>
          <div className="flex flex-wrap gap-1">
            {suggestion.unmappedClientColumns.map((col) => (
              <span key={col} className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-600">
                {col}
              </span>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
