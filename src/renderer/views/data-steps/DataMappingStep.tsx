import { useState, useCallback, useRef } from 'react'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import type { CSVPreview, DerivedMappings, MappingRow } from '../../../shared/types/column-mapping'
import type { IngestProgress } from '../../../shared/types/classification'

interface Props {
  preview: CSVPreview
  derivedMappings: DerivedMappings
  onApply: (mappings: MappingRow[]) => void
  onBack: () => void
  importing: boolean
  fromPreviousMapping?: boolean
  importProgress?: IngestProgress | null
}

const REQUIRED = new Set(REQUIRED_CANONICAL_COLUMNS as readonly string[])

function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

const ADDRESS_HINTS = ['address', 'supplier_address', 'vendor_address', 'street', 'city', 'state', 'zip', 'postal']

function isAddressColumn(canonical: string): boolean {
  const lower = canonical.toLowerCase()
  return ADDRESS_HINTS.some((h) => lower.includes(h))
}

interface ColumnState {
  csvColumn: string
  canonical: string
  included: boolean
  locked: boolean
}

function buildInitialState(preview: CSVPreview, derivedMappings: DerivedMappings, fromPrevious: boolean): ColumnState[] {
  const csvToCanonical = new Map<string, string>()
  for (const row of derivedMappings.rows) {
    if (row.csvColumn) {
      csvToCanonical.set(row.csvColumn, row.canonical)
    }
  }
  return preview.columns.map((col) => ({
    csvColumn: col,
    canonical: csvToCanonical.get(col) || toSnakeCase(col),
    included: fromPrevious ? csvToCanonical.has(col) : true,
    locked: fromPrevious && csvToCanonical.has(col),
  }))
}

export default function DataMappingStep({ preview, derivedMappings, onApply, onBack, importing, fromPreviousMapping = false, importProgress }: Props) {
  const [columns, setColumns] = useState<ColumnState[]>(() =>
    buildInitialState(preview, derivedMappings, fromPreviousMapping)
  )
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const toggleInclude = useCallback((index: number) => {
    setColumns((prev) => {
      const col = prev[index]
      if (col.locked) return prev
      return prev.map((c, i) => i === index ? { ...c, included: !c.included } : c)
    })
  }, [])

  const startEditCanonical = useCallback((index: number) => {
    if (columns[index].locked) return
    setEditingIndex(index)
    setEditValue(columns[index].canonical)
  }, [columns])

  const commitEditCanonical = useCallback(() => {
    if (editingIndex === null) return
    const snaked = toSnakeCase(editValue) || columns[editingIndex].canonical
    setColumns((prev) => prev.map((c, i) => i === editingIndex ? { ...c, canonical: snaked } : c))
    setEditingIndex(null)
  }, [editingIndex, editValue, columns])

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }, [])

  const handleDrop = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    setColumns((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragIndex, 1)
      next.splice(index, 0, moved)
      return next
    })
    setDragIndex(null)
    setDragOverIndex(null)
  }, [dragIndex])

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setDragOverIndex(null)
  }, [])

  const canApply = REQUIRED_CANONICAL_COLUMNS.every((req) =>
    columns.some((c) => c.canonical === req && c.included)
  )

  const hasAddressIncluded = columns.some((c) => c.included && isAddressColumn(c.canonical))
  const hasAddressColumn = columns.some((c) => isAddressColumn(c.canonical))

  const handleApply = () => {
    const rows: MappingRow[] = columns
      .filter((c) => c.included)
      .map((c) => ({ canonical: c.canonical, csvColumn: c.csvColumn }))
    onApply(rows)
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Top bar */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Column Mapping</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            All columns included by default. Click to exclude. Drag rows to reorder. Click canonical name to edit.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!hasAddressIncluded && hasAddressColumn && (
            <span className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1 text-[11px] text-amber-700 font-medium">
              Supplier address is strongly recommended for web search
            </span>
          )}
        </div>
      </div>

      {!hasAddressIncluded && !hasAddressColumn && (
        <div className="flex-shrink-0 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <span className="font-semibold">Tip:</span> Including a supplier address column is strongly recommended — it significantly improves web search accuracy during supplier research.
        </div>
      )}

      {/* Column rows — vertical scrollable table */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="w-8 px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-400">#</th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">CSV Column</th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">Canonical Name</th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">Preview</th>
              <th className="w-20 px-3 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {columns.map((col, index) => {
              const isRequired = REQUIRED.has(col.canonical)
              const isAddress = isAddressColumn(col.canonical)
              const isDragging = dragIndex === index
              const isDragOver = dragOverIndex === index && dragIndex !== index

              return (
                <tr
                  key={`${col.csvColumn}-${index}`}
                  draggable={!col.locked}
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={handleDragEnd}
                  className={`transition-all ${
                    col.included
                      ? col.locked ? 'bg-blue-50/40' : 'hover:bg-gray-50'
                      : 'bg-gray-50 opacity-50'
                  } ${isDragging ? 'opacity-30' : ''} ${
                    isDragOver ? 'border-t-2 border-t-blue-500' : ''
                  } ${!col.locked ? 'cursor-grab active:cursor-grabbing' : ''}`}
                >
                  <td className="px-2 py-2 text-center text-xs text-gray-400 select-none">{index + 1}</td>

                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-800 truncate max-w-[200px]" title={col.csvColumn}>
                        {col.csvColumn}
                      </span>
                      {isRequired && (
                        <span className="rounded px-1 py-0.5 text-[9px] font-bold bg-red-100 text-red-600 flex-shrink-0">REQ</span>
                      )}
                      {isAddress && !isRequired && col.included && (
                        <span className="rounded px-1 py-0.5 text-[9px] font-bold bg-amber-100 text-amber-600 flex-shrink-0">REC</span>
                      )}
                      {col.locked && (
                        <span className="text-[9px] text-blue-500 flex-shrink-0" title="Set by previous mapping">&#x1f512;</span>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    {editingIndex === index ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEditCanonical}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEditCanonical()
                          if (e.key === 'Escape') setEditingIndex(null)
                        }}
                        className="w-full max-w-[180px] text-xs font-mono bg-white border border-blue-300 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    ) : (
                      <button
                        onClick={() => startEditCanonical(index)}
                        className={`text-left text-xs font-mono truncate max-w-[180px] rounded px-1.5 py-0.5 transition-colors ${
                          col.locked ? 'text-blue-600 cursor-default' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                        }`}
                        title={col.locked ? 'Locked by previous mapping' : 'Click to edit'}
                        disabled={col.locked}
                      >
                        {col.canonical}
                      </button>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-gray-400">
                      {preview.sampleRows.slice(0, 2).map((row, ri) => (
                        <span key={ri} className="truncate max-w-[120px]" title={String(row[col.csvColumn] ?? '')}>
                          {String(row[col.csvColumn] ?? '\u2014')}
                          {ri < 1 && <span className="text-gray-300 ml-2">|</span>}
                        </span>
                      ))}
                    </div>
                  </td>

                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleInclude(index)}
                      disabled={col.locked}
                      className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${
                        col.included
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-gray-200 text-gray-500 border border-transparent'
                      } ${!col.locked && col.included ? 'hover:bg-red-50 hover:text-red-600 hover:border-red-200' : ''}${
                        !col.locked && !col.included ? ' hover:bg-green-50 hover:text-green-700 hover:border-green-200' : ''
                      } ${col.locked ? 'cursor-default' : 'cursor-pointer'}`}
                    >
                      {col.included ? 'Included' : 'Excluded'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-gray-200">
        <div className="text-xs text-gray-500">
          {columns.filter((c) => c.included).length} of {columns.length} columns included
        </div>
        <div className="flex gap-3">
          <button
            onClick={onBack}
            disabled={importing}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            &larr; Back
          </button>
          <button
            onClick={handleApply}
            disabled={!canApply || importing}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
          >
            {importing ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {importProgress
                  ? `Importing... ${importProgress.percentage}%`
                  : 'Starting import...'}
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
