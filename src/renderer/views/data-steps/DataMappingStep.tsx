import { useState, useEffect } from 'react'
import CSVPreviewTable from '../../components/upload/CSVPreviewTable'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import type { CSVPreviewWithMappings, ColumnMappingResult } from '../../../shared/types/column-mapping'

export interface MappingRow {
  canonical: string
  csvColumn: string
}

interface Props {
  preview: CSVPreviewWithMappings
  initialMappings?: MappingRow[]
  onApply: (mappings: MappingRow[]) => void
  onBack: () => void
}

const REQUIRED = new Set(REQUIRED_CANONICAL_COLUMNS as readonly string[])

const REQUIRED_LABELS: Record<string, string> = {
  supplier_name: 'Supplier Name',
  spend_amount: 'Spend Amount',
  invoice_date: 'Invoice Date',
}

function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function deriveInitialMappings(suggestion: ColumnMappingResult, csvColumns: string[]): MappingRow[] {
  const rows: MappingRow[] = []
  // Required first
  for (const canonical of REQUIRED_CANONICAL_COLUMNS) {
    rows.push({ canonical, csvColumn: suggestion.mappings[canonical] ?? '' })
  }
  // Then non-required LLM suggestions
  const usedRequired = new Set(rows.map((r) => r.csvColumn).filter(Boolean))
  for (const [canonical, csv] of Object.entries(suggestion.mappings)) {
    if (!REQUIRED.has(canonical) && csv && !usedRequired.has(csv)) {
      rows.push({ canonical, csvColumn: csv })
    }
  }
  return rows
}

export default function DataMappingStep({ preview, initialMappings, onApply, onBack }: Props) {
  const [mappings, setMappings] = useState<MappingRow[]>(
    () => initialMappings ?? deriveInitialMappings(preview.mappingSuggestion, preview.columns)
  )

  // Track used CSV columns
  const usedCsvCols = new Set(mappings.map((m) => m.csvColumn).filter(Boolean))
  const usedCanonicals = new Set(mappings.map((m) => m.canonical))

  const handleCsvChange = (index: number, csvColumn: string) => {
    setMappings((prev) => prev.map((m, i) => i === index ? { ...m, csvColumn } : m))
  }

  const handleCanonicalChange = (index: number, canonical: string) => {
    setMappings((prev) => prev.map((m, i) => i === index ? { ...m, canonical } : m))
  }

  const handleRemove = (index: number) => {
    const row = mappings[index]
    if (REQUIRED.has(row.canonical)) return
    setMappings((prev) => prev.filter((_, i) => i !== index))
  }

  const handleAdd = () => {
    // Find first unused CSV column as default
    const availableCsv = preview.columns.find((c) => !usedCsvCols.has(c)) ?? ''
    const canonical = toSnakeCase(availableCsv || 'column')
    setMappings((prev) => [...prev, { canonical, csvColumn: availableCsv }])
  }

  const canApply = REQUIRED_CANONICAL_COLUMNS.every((req) =>
    mappings.some((m) => m.canonical === req && m.csvColumn)
  )

  return (
    <div className="flex gap-6 h-full">
      {/* Left: CSV preview */}
      <div className="flex-1 min-w-0">
        <CSVPreviewTable preview={preview} />
      </div>

      {/* Right: Mapping config */}
      <div className="w-80 flex-shrink-0 space-y-4 overflow-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-700">Column Mappings</h3>
          <button
            onClick={handleAdd}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            + Add Column
          </button>
        </div>

        <div className="space-y-3">
          {mappings.map((row, index) => {
            const isRequired = REQUIRED.has(row.canonical)
            return (
              <div key={index} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between mb-1.5">
                  {isRequired ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-700">
                        {REQUIRED_LABELS[row.canonical] ?? row.canonical}
                      </span>
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-700">
                        required
                      </span>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={row.canonical}
                      onChange={(e) => handleCanonicalChange(index, e.target.value)}
                      onBlur={(e) => handleCanonicalChange(index, toSnakeCase(e.target.value))}
                      className="text-sm font-medium text-gray-700 border-b border-transparent focus:border-gray-300 outline-none bg-transparent"
                      placeholder="canonical_name"
                    />
                  )}
                  {!isRequired && (
                    <button
                      onClick={() => handleRemove(index)}
                      className="text-gray-400 hover:text-red-500 text-sm"
                      title="Remove mapping"
                    >
                      &times;
                    </button>
                  )}
                </div>
                <select
                  value={row.csvColumn}
                  onChange={(e) => handleCsvChange(index, e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">-- Not mapped --</option>
                  {preview.columns.map((col) => (
                    <option key={col} value={col} disabled={usedCsvCols.has(col) && col !== row.csvColumn}>
                      {col}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onBack}
            className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <button
            onClick={() => onApply(mappings)}
            disabled={!canApply}
            className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
          >
            Apply Mappings &rarr;
          </button>
        </div>
      </div>
    </div>
  )
}
