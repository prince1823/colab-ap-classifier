import { useState, useRef } from 'react'
import CSVPreviewTable from '../../components/upload/CSVPreviewTable'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import type { CSVPreview, DerivedMappings, MappingRow } from '../../../shared/types/column-mapping'

interface Props {
  preview: CSVPreview
  derivedMappings: DerivedMappings
  onApply: (mappings: MappingRow[]) => void
  onBack: () => void
  importing: boolean
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

export default function DataMappingStep({ preview, derivedMappings, onApply, onBack, importing }: Props) {
  const [mappings, setMappings] = useState<MappingRow[]>(() => derivedMappings.rows)
  const mappingListRef = useRef<HTMLDivElement>(null)

  // Track used CSV columns
  const usedCsvCols = new Set(mappings.map((m) => m.csvColumn).filter(Boolean))

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
    const availableCsv = preview.columns.find((c) => !usedCsvCols.has(c)) ?? ''
    const canonical = toSnakeCase(availableCsv || 'column')
    setMappings((prev) => [...prev, { canonical, csvColumn: availableCsv }])
    // Scroll to bottom
    requestAnimationFrame(() => {
      mappingListRef.current?.scrollTo({ top: mappingListRef.current.scrollHeight, behavior: 'smooth' })
    })
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
      <div className="w-80 flex-shrink-0 flex flex-col space-y-4 overflow-hidden">
        <div className="flex items-center justify-between flex-shrink-0">
          <h3 className="text-sm font-medium text-gray-700">Column Mappings</h3>
          <button
            onClick={handleAdd}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            + Add Column
          </button>
        </div>

        <div ref={mappingListRef} className="flex-1 overflow-auto space-y-3">
          {mappings.map((row, index) => {
            const isRequired = REQUIRED.has(row.canonical)
            return (
              <div key={index} className="rounded-lg border border-gray-200 bg-white p-3 transition-shadow">
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

        <div className="flex gap-3 pt-2 flex-shrink-0">
          <button
            onClick={onBack}
            disabled={importing}
            className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            &larr; Back
          </button>
          <button
            onClick={() => onApply(mappings)}
            disabled={!canApply || importing}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
          >
            {importing ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Importing...
              </>
            ) : (
              'Apply & Import \u2192'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
