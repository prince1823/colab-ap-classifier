import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import { ipc } from '../../lib/ipc'
import type { CSVPreview, DerivedMappings, MappingRow } from '../../../shared/types/column-mapping'

/* ── Constants ── */

const REQUIRED = new Set(REQUIRED_CANONICAL_COLUMNS as readonly string[])
const ADDRESS_HINTS = ['address', 'supplier_address', 'vendor_address', 'street', 'city', 'state', 'zip', 'postal']
const MAX_PREVIEW_ROWS = 8
const MERGE_ROWS_LIMIT = 5

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
  onApply: (mappings: MappingRow[], columnStates?: ColumnState[]) => void
  onBack: () => void
  fromPreviousMapping?: boolean
  preservedColumnStates?: ColumnState[] | null
  importing?: boolean
  isFirstUpload?: boolean
}

export interface ColumnState {
  csvColumn: string
  canonical: string
  included: boolean
  locked: boolean
}

interface FlatRow {
  [canonical: string]: string
}

type ActiveTab = 'mapping' | 'preview'

/* ── Initial state builders ── */

function buildCanonicalPool(
  derivedMappings: DerivedMappings,
  columns: ColumnState[],
): string[] {
  const pool = new Set<string>()
  for (const req of REQUIRED_CANONICAL_COLUMNS) pool.add(req)
  for (const ec of derivedMappings.existingCanonicals) pool.add(ec)
  for (const row of derivedMappings.rows) {
    if (row.canonical) pool.add(row.canonical)
  }
  for (const col of columns) {
    if (col.canonical) pool.add(col.canonical)
  }
  return Array.from(pool)
}

function buildInitialState(
  preview: CSVPreview,
  derivedMappings: DerivedMappings,
  fromPrevious: boolean,
): ColumnState[] {
  const csvToCanonical = new Map<string, string>()
  for (const row of derivedMappings.rows) {
    if (row.csvColumn) csvToCanonical.set(row.csvColumn, row.canonical)
  }

  return preview.columns.map((col) => {
    if (csvToCanonical.has(col)) {
      return {
        csvColumn: col,
        canonical: csvToCanonical.get(col)!,
        included: true,
        locked: fromPrevious,
      }
    }
    const snaked = toSnakeCase(col)
    return {
      csvColumn: col,
      canonical: snaked,
      included: fromPrevious ? false : true,
      locked: false,
    }
  })
}

/* ── Searchable Column Picker (custom dropdown) ── */

function ColumnPicker({
  value,
  allCsvColumns,
  csvToCanonicalMap,
  thisCanonical,
  onChange,
}: {
  value: string | null
  allCsvColumns: string[]
  csvToCanonicalMap: Map<string, string>
  thisCanonical: string
  onChange: (csvColumn: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return allCsvColumns.filter((csv) => csv.toLowerCase().includes(q))
  }, [allCsvColumns, search])

  const { unmapped, mapped } = useMemo(() => {
    const u: string[] = []
    const m: string[] = []
    for (const csv of filtered) {
      const usedBy = csvToCanonicalMap.get(csv)
      if (!usedBy || usedBy === thisCanonical) u.push(csv)
      else m.push(csv)
    }
    return { unmapped: u, mapped: m }
  }, [filtered, csvToCanonicalMap, thisCanonical])

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full text-left text-[11px] rounded border px-2 py-1 truncate flex items-center gap-1 transition-colors ${
          value
            ? 'border-green-300 bg-white text-gray-700 hover:border-green-400'
            : 'border-gray-300 bg-gray-50 text-gray-400 hover:border-gray-400'
        }`}
      >
        <span className="truncate flex-1">{value ?? '-- unmapped --'}</span>
        <svg className="w-3 h-3 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden"
          style={{ minWidth: '220px' }}
        >
          <div className="p-1.5 border-b border-gray-100">
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search columns..."
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {value && (
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); setSearch('') }}
                className="w-full text-left px-3 py-1.5 text-[11px] text-red-500 hover:bg-red-50 border-b border-gray-50"
              >
                &#10005; Remove mapping
              </button>
            )}
            {unmapped.map((csv) => (
              <button
                key={csv}
                type="button"
                onClick={() => { onChange(csv); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-blue-50 flex items-center gap-1.5 ${
                  csv === value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                }`}
              >
                {csv === value && <span className="text-blue-500 flex-shrink-0">&#10003;</span>}
                <span className="truncate">{csv}</span>
              </button>
            ))}
            {mapped.length > 0 && (
              <>
                <div className="px-3 py-1 text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-50 border-t border-gray-100">
                  Used by other mappings
                </div>
                {mapped.map((csv) => {
                  const usedBy = csvToCanonicalMap.get(csv)!
                  return (
                    <button
                      key={csv}
                      type="button"
                      onClick={() => { onChange(csv); setOpen(false); setSearch('') }}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-gray-400 hover:bg-amber-50 hover:text-gray-600 flex items-center justify-between"
                    >
                      <span className="truncate">{csv}</span>
                      <span className="text-[9px] text-gray-300 flex-shrink-0 ml-1">{usedBy}</span>
                    </button>
                  )
                })}
              </>
            )}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-gray-400 text-center">No columns match</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Canonical Column Card (Right Panel) ── */

function CanonicalCard({
  canonical,
  isRequired,
  isAddress,
  mappedCsvColumn,
  allCsvColumns,
  csvToCanonicalMap,
  onChangeMapping,
}: {
  canonical: string
  isRequired: boolean
  isAddress: boolean
  mappedCsvColumn: string | null
  allCsvColumns: string[]
  csvToCanonicalMap: Map<string, string>
  onChangeMapping: (canonical: string, csvColumn: string | null) => void
}) {
  const isMapped = mappedCsvColumn !== null

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 transition-all ${
        isMapped
          ? 'border-green-200 bg-green-50/50'
          : isRequired
            ? 'border-red-200 bg-red-50/30'
            : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-xs font-mono font-semibold text-gray-800 truncate" title={canonical}>
          {canonical}
        </span>
        {isRequired && (
          <span className="rounded px-1 py-0.5 text-[8px] font-bold bg-red-100 text-red-600 flex-shrink-0">REQ</span>
        )}
        {isAddress && !isRequired && (
          <span className="rounded px-1 py-0.5 text-[8px] font-bold bg-amber-100 text-amber-600 flex-shrink-0">REC</span>
        )}
        {isMapped && (
          <span className="text-green-500 text-[10px] flex-shrink-0 ml-auto" title="Mapped">&#10003;</span>
        )}
      </div>
      <ColumnPicker
        value={mappedCsvColumn}
        allCsvColumns={allCsvColumns}
        csvToCanonicalMap={csvToCanonicalMap}
        thisCanonical={canonical}
        onChange={(csv) => onChangeMapping(canonical, csv)}
      />
    </div>
  )
}

/* ── Merge Preview Table (inline in left panel) ── */

function MergePreviewContent({
  columns,
  preview,
  isFirstUpload,
}: {
  columns: ColumnState[]
  preview: CSVPreview
  isFirstUpload: boolean
}) {
  const [existingRows, setExistingRows] = useState<FlatRow[]>([])
  const [existingTotalCount, setExistingTotalCount] = useState(0)
  const [loading, setLoading] = useState(!isFirstUpload)

  const includedColumns = useMemo(() => columns.filter((c) => c.included), [columns])
  const canonicalNames = useMemo(() => includedColumns.map((c) => c.canonical), [includedColumns])

  // Build new rows mapped through current column assignments
  const newRows = useMemo(() => {
    return preview.sampleRows.slice(0, MERGE_ROWS_LIMIT).map((csvRow) => {
      const flat: FlatRow = {}
      for (const col of includedColumns) {
        flat[col.canonical] = String(csvRow[col.csvColumn] ?? '\u2014')
      }
      return flat
    })
  }, [preview.sampleRows, includedColumns])

  // Fetch existing data
  useEffect(() => {
    if (isFirstUpload) { setLoading(false); return }
    setLoading(true)
    ipc.transactions
      .query()
      .then((result) => {
        setExistingTotalCount(result.totalCount)
        const tail = result.rows.slice(-MERGE_ROWS_LIMIT)
        const flattened: FlatRow[] = tail.map((tx) => {
          const flat: FlatRow = {}
          for (const col of canonicalNames) {
            const val = (tx.canonicalFields as Record<string, unknown>)?.[col]
            flat[col] = val !== undefined && val !== null ? String(val) : '\u2014'
          }
          return flat
        })
        setExistingRows(flattened)
      })
      .catch(() => { setExistingRows([]); setExistingTotalCount(0) })
      .finally(() => setLoading(false))
  }, [isFirstUpload, canonicalNames])

  // Detect mismatch warnings
  const warnings = useMemo(() => {
    if (isFirstUpload || existingRows.length === 0 || newRows.length === 0) return []
    const w: string[] = []
    for (const col of canonicalNames) {
      const existingHasData = existingRows.some((r) => r[col] && r[col] !== '\u2014')
      const newHasData = newRows.some((r) => r[col] && r[col] !== '\u2014')
      if (existingHasData && !newHasData) {
        w.push(`"${col}" has data in existing rows but is empty in the new dataset`)
      }
      if (!existingHasData && newHasData) {
        w.push(`"${col}" has data in new rows but is empty in existing dataset`)
      }
    }
    return w
  }, [canonicalNames, existingRows, newRows, isFirstUpload])

  const totalAfterImport = existingTotalCount + preview.totalRows

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading existing data...
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* First upload notice */}
      {isFirstUpload && (
        <div className="flex-shrink-0 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700 mb-2 mx-1 mt-1">
          This will be the first dataset imported into this project.
        </div>
      )}

      {/* Mismatch warnings */}
      {warnings.length > 0 && (
        <div className="flex-shrink-0 mx-1 mt-1 mb-2 space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-[11px] text-amber-700 flex items-start gap-1.5">
              <span className="flex-shrink-0 mt-0.5">&#9888;</span>
              <span>{w} &mdash; check your column mapping</span>
            </div>
          ))}
        </div>
      )}

      {/* Merge table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="w-20 px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-400 border-r border-gray-200">
                Source
              </th>
              {canonicalNames.map((col) => (
                <th key={col} className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500 min-w-[120px]">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {/* Existing rows (white) */}
            {existingRows.map((row, i) => (
              <tr key={`existing-${i}`} className="bg-white">
                {i === 0 ? (
                  <td
                    rowSpan={existingRows.length}
                    className="px-3 py-2 text-[10px] font-medium text-gray-400 uppercase tracking-wider align-top border-r border-gray-100 bg-gray-50/50"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-gray-300"></span>
                      Existing
                    </div>
                  </td>
                ) : null}
                {canonicalNames.map((col) => (
                  <td key={col} className="px-3 py-2 text-xs text-gray-500 truncate max-w-[150px]" title={row[col]}>
                    {row[col]}
                  </td>
                ))}
              </tr>
            ))}

            {/* Divider */}
            {existingRows.length > 0 && newRows.length > 0 && (
              <tr>
                <td colSpan={canonicalNames.length + 1} className="px-3 py-1 bg-gray-100 border-y-2 border-gray-200">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-gray-300"></div>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                      New data below
                    </span>
                    <div className="flex-1 h-px bg-gray-300"></div>
                  </div>
                </td>
              </tr>
            )}

            {/* New rows (yellow) */}
            {newRows.map((row, i) => (
              <tr key={`new-${i}`} className="bg-yellow-50 hover:bg-yellow-100/70">
                {i === 0 ? (
                  <td
                    rowSpan={newRows.length}
                    className="px-3 py-2 text-[10px] font-medium text-yellow-700 uppercase tracking-wider align-top border-r border-yellow-200 bg-yellow-100/50"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
                      New
                    </div>
                  </td>
                ) : null}
                {canonicalNames.map((col) => (
                  <td key={col} className="px-3 py-2 text-xs text-gray-700 truncate max-w-[150px]" title={row[col]}>
                    {row[col]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Row count summary */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 py-2 bg-gray-50 border-t border-gray-200 text-[11px] text-gray-500">
        {!isFirstUpload && (
          <>
            <span>Existing: <strong className="text-gray-700">{existingTotalCount.toLocaleString()}</strong> rows</span>
            <span className="text-gray-300">|</span>
          </>
        )}
        <span>New: <strong className="text-gray-700">{preview.totalRows.toLocaleString()}</strong> rows</span>
        {!isFirstUpload && (
          <>
            <span className="text-gray-300">|</span>
            <span>Total after import: <strong className="text-gray-700">{totalAfterImport.toLocaleString()}</strong> rows</span>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Main Component ── */

export default function DataMappingStep({
  preview,
  derivedMappings,
  onApply,
  onBack,
  fromPreviousMapping = false,
  preservedColumnStates,
  importing = false,
  isFirstUpload = true,
}: Props) {
  const [columns, setColumns] = useState<ColumnState[]>(() =>
    preservedColumnStates ?? buildInitialState(preview, derivedMappings, fromPreviousMapping)
  )
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [canonicalPool, setCanonicalPool] = useState<string[]>(() =>
    buildCanonicalPool(derivedMappings, preservedColumnStates ?? buildInitialState(preview, derivedMappings, fromPreviousMapping))
  )
  const [newCanonicalInput, setNewCanonicalInput] = useState('')
  const [showAddInput, setShowAddInput] = useState(false)
  const [activeTab, setActiveTab] = useState<ActiveTab>('mapping')

  /* ── Derived data ── */

  const canonicalToCsv = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of columns) {
      if (col.included && col.canonical) map.set(col.canonical, col.csvColumn)
    }
    return map
  }, [columns])

  const csvToCanonicalMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of columns) {
      if (col.included && col.canonical) map.set(col.csvColumn, col.canonical)
    }
    return map
  }, [columns])

  const displayRows = useMemo(
    () => preview.sampleRows.slice(0, MAX_PREVIEW_ROWS),
    [preview.sampleRows]
  )

  /* ── Callbacks ── */

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
    setCanonicalPool((prev) => (prev.includes(snaked) ? prev : [...prev, snaked]))
    setEditingIndex(null)
  }, [editingIndex, editValue, columns])

  const cancelEdit = useCallback(() => setEditingIndex(null), [])

  const handleCanonicalMappingChange = useCallback(
    (canonical: string, csvColumn: string | null) => {
      setColumns((prev) => {
        return prev.map((c) => {
          if (c.canonical === canonical && c.csvColumn !== csvColumn) {
            return { ...c, canonical: toSnakeCase(c.csvColumn), included: false }
          }
          if (csvColumn && c.csvColumn === csvColumn) {
            return { ...c, canonical, included: true }
          }
          return c
        })
      })
    },
    []
  )

  const handleAddCanonical = useCallback(() => {
    const snaked = toSnakeCase(newCanonicalInput)
    if (!snaked || canonicalPool.includes(snaked)) {
      setNewCanonicalInput('')
      setShowAddInput(false)
      return
    }
    setCanonicalPool((prev) => [...prev, snaked])
    setNewCanonicalInput('')
    setShowAddInput(false)
  }, [newCanonicalInput, canonicalPool])

  /* ── Validation ── */

  const canApply = REQUIRED_CANONICAL_COLUMNS.every((req) =>
    columns.some((c) => c.canonical === req && c.included)
  )

  const hasAddressIncluded = columns.some((c) => c.included && isAddressColumn(c.canonical))
  const hasAddressColumn = columns.some((c) => isAddressColumn(c.canonical))
  const includedCount = columns.filter((c) => c.included).length
  const mappedCanonicalCount = canonicalPool.filter((c) => canonicalToCsv.has(c)).length

  const handleApply = () => {
    const rows: MappingRow[] = columns
      .filter((c) => c.included)
      .map((c) => ({ canonical: c.canonical, csvColumn: c.csvColumn }))
    onApply(rows, columns)
  }

  /* ── Render ── */

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Top bar */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Column Mapping</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Map your CSV columns to canonical names. Switch to Merge Preview to see how new data aligns with existing data.
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

      {/* Split panel: Left (tabs: mapping table / merge preview) + Right (canonical panel) */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* ═══ LEFT PANEL ═══ */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar */}
          <div className="flex-shrink-0 flex border-b border-gray-200 mb-0">
            <button
              onClick={() => setActiveTab('mapping')}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === 'mapping'
                  ? 'border-blue-600 text-blue-700 bg-white'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Mapping Table
            </button>
            <button
              onClick={() => setActiveTab('preview')}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === 'preview'
                  ? 'border-blue-600 text-blue-700 bg-white'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Merge Preview
              {!isFirstUpload && (
                <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-yellow-400"></span>
              )}
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-auto rounded-b-md border border-t-0 border-gray-200">
            {activeTab === 'mapping' ? (
              /* ── Mapping Table ── */
              <table className="min-w-max divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 sticky top-0 z-10">
                  <tr className="border-b border-gray-100">
                    <th
                      rowSpan={2}
                      className="w-10 px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-400 align-middle border-r border-gray-200"
                    >
                      #
                    </th>
                    {columns.map((col, index) => (
                      <th
                        key={`csv-${index}`}
                        className={`px-3 py-1.5 text-left min-w-[130px] max-w-[200px] transition-opacity ${
                          !col.included ? 'opacity-40' : ''
                        }`}
                      >
                        <div className="flex items-center gap-1">
                          <span
                            className="text-[10px] font-medium text-gray-500 uppercase tracking-wider truncate"
                            title={col.csvColumn}
                          >
                            {col.csvColumn}
                          </span>
                          {col.locked && (
                            <span className="text-[9px] text-blue-500 flex-shrink-0" title="Set by previous mapping">
                              &#x1f512;
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                  <tr className="border-b border-gray-200 bg-blue-50/30">
                    {columns.map((col, index) => {
                      const isRequired = REQUIRED.has(col.canonical)
                      const isAddress = isAddressColumn(col.canonical)
                      const isEditing = editingIndex === index
                      return (
                        <th
                          key={`canonical-${index}`}
                          className={`px-3 py-1.5 text-left min-w-[130px] max-w-[200px] transition-opacity ${
                            !col.included ? 'opacity-40' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1">
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={commitEditCanonical}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitEditCanonical()
                                  if (e.key === 'Escape') cancelEdit()
                                }}
                                className="flex-1 min-w-0 text-xs font-mono bg-white border border-blue-300 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            ) : (
                              <button
                                onClick={() => startEditCanonical(index)}
                                className={`text-left text-[11px] font-mono truncate rounded px-1 py-0.5 transition-colors ${
                                  col.locked
                                    ? 'text-blue-600 cursor-default'
                                    : 'text-blue-700 hover:bg-blue-100 hover:text-blue-900'
                                }`}
                                title={col.locked ? 'Locked by previous mapping' : `Click to rename — currently: ${col.canonical}`}
                                disabled={col.locked}
                              >
                                {col.canonical}
                              </button>
                            )}
                            {isRequired && (
                              <span className="rounded px-1 py-0.5 text-[7px] font-bold bg-red-100 text-red-600 flex-shrink-0">REQ</span>
                            )}
                            {isAddress && !isRequired && col.included && (
                              <span className="rounded px-1 py-0.5 text-[7px] font-bold bg-amber-100 text-amber-600 flex-shrink-0">REC</span>
                            )}
                            <button
                              onClick={() => toggleInclude(index)}
                              disabled={col.locked}
                              className={`rounded px-1.5 py-0.5 text-[8px] font-medium transition-colors flex-shrink-0 ml-auto ${
                                col.included
                                  ? 'bg-green-100 text-green-700 border border-green-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200'
                                  : 'bg-gray-200 text-gray-500 border border-transparent hover:bg-green-50 hover:text-green-700 hover:border-green-200'
                              } ${col.locked ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
                              title={col.included ? 'Click to exclude' : 'Click to include'}
                            >
                              {col.included ? 'Incl' : 'Excl'}
                            </button>
                          </div>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {displayRows.map((row, ri) => (
                    <tr key={ri} className="hover:bg-gray-50">
                      <td className="px-2 py-2 text-center text-xs text-gray-400 select-none border-r border-gray-100">{ri + 1}</td>
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
                  {preview.totalRows > MAX_PREVIEW_ROWS && (
                    <tr>
                      <td colSpan={columns.length + 1} className="px-3 py-2 text-center text-[11px] text-gray-400 bg-gray-50">
                        Showing {MAX_PREVIEW_ROWS} of {preview.totalRows.toLocaleString()} rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              /* ── Merge Preview ── */
              <MergePreviewContent
                columns={columns}
                preview={preview}
                isFirstUpload={isFirstUpload}
              />
            )}
          </div>
        </div>

        {/* ═══ RIGHT: Canonical Columns Panel ═══ */}
        <div className="w-72 flex-shrink-0 flex flex-col rounded-md border border-gray-200 bg-gray-50/50">
          <div className="px-3 py-2.5 border-b border-gray-200 bg-white rounded-t-md">
            <h4 className="text-xs font-semibold text-gray-700">Canonical Columns</h4>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {mappedCanonicalCount} of {canonicalPool.length} mapped
            </p>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
            {canonicalPool.map((canonical) => (
              <CanonicalCard
                key={canonical}
                canonical={canonical}
                isRequired={REQUIRED.has(canonical)}
                isAddress={isAddressColumn(canonical)}
                mappedCsvColumn={canonicalToCsv.get(canonical) ?? null}
                allCsvColumns={preview.columns}
                csvToCanonicalMap={csvToCanonicalMap}
                onChangeMapping={handleCanonicalMappingChange}
              />
            ))}
          </div>
          <div className="px-2 py-2 border-t border-gray-200 bg-white rounded-b-md">
            {showAddInput ? (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={newCanonicalInput}
                  onChange={(e) => setNewCanonicalInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddCanonical()
                    if (e.key === 'Escape') { setShowAddInput(false); setNewCanonicalInput('') }
                  }}
                  placeholder="new_column_name"
                  className="flex-1 min-w-0 text-xs font-mono border border-gray-300 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-blue-400"
                />
                <button onClick={handleAddCanonical} className="rounded bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-700">
                  Add
                </button>
                <button
                  onClick={() => { setShowAddInput(false); setNewCanonicalInput('') }}
                  className="rounded border border-gray-300 px-2 py-1 text-[10px] font-medium text-gray-500 hover:bg-gray-50"
                >
                  &#10005;
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddInput(true)}
                className="w-full rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50/50 transition-colors"
              >
                + Add Canonical Column
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-gray-200">
        <div className="text-xs text-gray-500">
          {includedCount} of {columns.length} columns included
          {!canApply && (
            <span className="ml-2 text-red-500 font-medium">
              — Missing required: {REQUIRED_CANONICAL_COLUMNS.filter(
                (req) => !columns.some((c) => c.canonical === req && c.included)
              ).join(', ')}
            </span>
          )}
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
                Importing...
              </>
            ) : (
              'Import & Continue \u2192'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
