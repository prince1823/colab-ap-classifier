import { useState, useCallback, useMemo } from 'react'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import type { CSVPreview, DerivedMappings, MappingRow } from '../../../shared/types/column-mapping'

/* ── Constants ── */

const REQUIRED = new Set(REQUIRED_CANONICAL_COLUMNS as readonly string[])
const ADDRESS_HINTS = ['address', 'supplier_address', 'vendor_address', 'street', 'city', 'state', 'zip', 'postal']
const MAX_PREVIEW_ROWS = 8

function isAddressColumn(canonical: string): boolean {
  return ADDRESS_HINTS.some((h) => canonical.toLowerCase().includes(h))
}

function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/* ── Types ── */

interface Props {
  preview: CSVPreview
  derivedMappings: DerivedMappings
  onApply: (mappings: MappingRow[]) => void
  onBack: () => void
  fromPreviousMapping?: boolean
}

interface ColumnState {
  csvColumn: string
  canonical: string
  included: boolean
  locked: boolean
}

/* ── Initial state builder ── */

function buildInitialState(
  preview: CSVPreview,
  derivedMappings: DerivedMappings,
  fromPrevious: boolean,
): ColumnState[] {
  const csvToCanonical = new Map<string, string>()
  for (const row of derivedMappings.rows) {
    if (row.csvColumn) {
      csvToCanonical.set(row.csvColumn, row.canonical)
    }
  }

  const existingCanonicalSet = new Set(derivedMappings.existingCanonicals)

  return preview.columns.map((col) => {
    // Use LLM / previous mapping suggestion first
    if (csvToCanonical.has(col)) {
      return {
        csvColumn: col,
        canonical: csvToCanonical.get(col)!,
        included: true,
        locked: fromPrevious,
      }
    }
    // Auto-map if snake_case matches an existing canonical from the project
    const snaked = toSnakeCase(col)
    const autoMatched = existingCanonicalSet.has(snaked)
    return {
      csvColumn: col,
      canonical: snaked,
      included: fromPrevious ? false : true,
      locked: false,
    }
  })
}

/* ── Column Header Cell ── */

function ColumnHeader({
  col,
  index,
  editingIndex,
  editValue,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onToggleInclude,
}: {
  col: ColumnState
  index: number
  editingIndex: number | null
  editValue: string
  onStartEdit: (index: number) => void
  onEditChange: (value: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onToggleInclude: (index: number) => void
}) {
  const isRequired = REQUIRED.has(col.canonical)
  const isAddress = isAddressColumn(col.canonical)
  const isEditing = editingIndex === index

  return (
    <th
      className={`px-3 py-0 text-left align-top min-w-[140px] max-w-[200px] transition-opacity ${
        !col.included ? 'opacity-40' : ''
      }`}
    >
      <div className="flex flex-col gap-1 py-2">
        {/* Original CSV column name */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider truncate" title={col.csvColumn}>
            {col.csvColumn}
          </span>
        </div>

        {/* Editable canonical name */}
        <div className="flex items-center gap-1">
          {isEditing ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => onEditChange(e.target.value)}
              onBlur={onCommitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitEdit()
                if (e.key === 'Escape') onCancelEdit()
              }}
              className="w-full text-xs font-mono bg-white border border-blue-300 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-blue-500"
            />
          ) : (
            <button
              onClick={() => onStartEdit(index)}
              className={`text-left text-xs font-mono truncate rounded px-1 py-0.5 transition-colors ${
                col.locked
                  ? 'text-blue-600 cursor-default'
                  : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
              }`}
              title={col.locked ? 'Locked by previous mapping' : `Click to rename \u2014 currently: ${col.canonical}`}
              disabled={col.locked}
            >
              {col.canonical}
            </button>
          )}
        </div>

        {/* Badges + include/exclude */}
        <div className="flex items-center gap-1 flex-wrap">
          {isRequired && (
            <span className="rounded px-1 py-0.5 text-[8px] font-bold bg-red-100 text-red-600">REQ</span>
          )}
          {isAddress && !isRequired && col.included && (
            <span className="rounded px-1 py-0.5 text-[8px] font-bold bg-amber-100 text-amber-600">REC</span>
          )}
          {col.locked && (
            <span className="text-[9px] text-blue-500" title="Set by previous mapping">&#x1f512;</span>
          )}
          <button
            onClick={() => onToggleInclude(index)}
            disabled={col.locked}
            className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ml-auto ${
              col.included
                ? 'bg-green-50 text-green-700 border border-green-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200'
                : 'bg-gray-200 text-gray-500 border border-transparent hover:bg-green-50 hover:text-green-700 hover:border-green-200'
            } ${col.locked ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          >
            {col.included ? 'Incl' : 'Excl'}
          </button>
        </div>
      </div>
    </th>
  )
}

/* ── Main Component ── */

export default function DataMappingStep({
  preview,
  derivedMappings,
  onApply,
  onBack,
  fromPreviousMapping = false,
}: Props) {
  const [columns, setColumns] = useState<ColumnState[]>(() =>
    buildInitialState(preview, derivedMappings, fromPreviousMapping)
  )
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')

  // Callbacks
  const toggleInclude = useCallback((index: number) => {
    setColumns((prev) => {
      if (prev[index].locked) return prev
      return prev.map((c, i) => (i === index ? { ...c, included: !c.included } : c))
    })
  }, [])

  const startEditCanonical = useCallback(
    (index: number) => {
      if (columns[index].locked) return
      setEditingIndex(index)
      setEditValue(columns[index].canonical)
    },
    [columns]
  )

  const commitEditCanonical = useCallback(() => {
    if (editingIndex === null) return
    const snaked = toSnakeCase(editValue) || columns[editingIndex].canonical
    setColumns((prev) => prev.map((c, i) => (i === editingIndex ? { ...c, canonical: snaked } : c)))
    setEditingIndex(null)
  }, [editingIndex, editValue, columns])

  const cancelEdit = useCallback(() => setEditingIndex(null), [])

  // Validation
  const canApply = REQUIRED_CANONICAL_COLUMNS.every((req) =>
    columns.some((c) => c.canonical === req && c.included)
  )

  const hasAddressIncluded = columns.some((c) => c.included && isAddressColumn(c.canonical))
  const hasAddressColumn = columns.some((c) => isAddressColumn(c.canonical))

  const includedCount = columns.filter((c) => c.included).length

  // Sample rows to display
  const displayRows = useMemo(
    () => preview.sampleRows.slice(0, MAX_PREVIEW_ROWS),
    [preview.sampleRows]
  )

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
            Each column shows its CSV name, the canonical name (click to rename), and an include/exclude toggle.
            Excluded columns are dimmed.
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
          <span className="font-semibold">Tip:</span> Including a supplier address column is strongly recommended
          &mdash; it significantly improves web search accuracy during supplier research.
        </div>
      )}

      {/* Data preview table with mapping headers */}
      <div className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
        <table className="min-w-max divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            {/* Row number + column headers with mapping controls */}
            <tr className="border-b border-gray-200">
              <th className="w-10 px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-400 align-top">
                #
              </th>
              {columns.map((col, index) => (
                <ColumnHeader
                  key={`${col.csvColumn}-${index}`}
                  col={col}
                  index={index}
                  editingIndex={editingIndex}
                  editValue={editValue}
                  onStartEdit={startEditCanonical}
                  onEditChange={setEditValue}
                  onCommitEdit={commitEditCanonical}
                  onCancelEdit={cancelEdit}
                  onToggleInclude={toggleInclude}
                />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {displayRows.map((row, ri) => (
              <tr key={ri} className="hover:bg-gray-50">
                <td className="px-2 py-2 text-center text-xs text-gray-400 select-none">{ri + 1}</td>
                {columns.map((col, ci) => (
                  <td
                    key={ci}
                    className={`px-3 py-2 text-xs truncate max-w-[180px] transition-opacity ${
                      col.included ? 'text-gray-700' : 'text-gray-300 opacity-40'
                    }`}
                    title={String(row[col.csvColumn] ?? '')}
                  >
                    {String(row[col.csvColumn] ?? '\u2014')}
                  </td>
                ))}
              </tr>
            ))}
            {/* Show total row count */}
            {preview.totalRows > MAX_PREVIEW_ROWS && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-3 py-2 text-center text-[11px] text-gray-400 bg-gray-50"
                >
                  Showing {MAX_PREVIEW_ROWS} of {preview.totalRows.toLocaleString()} rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-gray-200">
        <div className="text-xs text-gray-500">
          {includedCount} of {columns.length} columns included
        </div>
        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <button
            onClick={handleApply}
            disabled={!canApply}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
          >
            Preview &rarr;
          </button>
        </div>
      </div>
    </div>
  )
}
