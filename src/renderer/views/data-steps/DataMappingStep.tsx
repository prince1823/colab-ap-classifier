import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import { ipc } from '../../lib/ipc'
import type { CSVPreview, DerivedMappings, MappingRow } from '../../../shared/types/column-mapping'
import type { IngestProgress } from '../../../shared/types/classification'

/* ── Constants ── */

const REQUIRED = new Set(REQUIRED_CANONICAL_COLUMNS as readonly string[])
const ADDRESS_HINTS = ['address', 'supplier_address', 'vendor_address', 'street', 'city', 'state', 'zip', 'postal']
const MAX_PREVIEW_ROWS = 100
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
  onBack: () => void | Promise<void>
  fromPreviousMapping?: boolean
  preservedColumnStates?: ColumnState[] | null
  importing?: boolean
  importProgress?: IngestProgress | null
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

  // Track which canonical names are already assigned to LLM-mapped columns so
  // unmapped columns don't silently collide with them at init time.
  const assignedCanonicals = new Set(csvToCanonical.values())

  return preview.columns.map((col) => {
    if (csvToCanonical.has(col)) {
      const canonical = csvToCanonical.get(col)!
      return {
        csvColumn: col,
        canonical,
        included: REQUIRED.has(canonical) || fromPrevious,
        locked: fromPrevious,
      }
    }
    // Always snake_case the canonical name — the backend rejects names with spaces
    const snaked = toSnakeCase(col)
    const defaultCanonical = snaked
    const collides = assignedCanonicals.has(defaultCanonical)
    return {
      csvColumn: col,
      canonical: collides ? '' : defaultCanonical,
      included: false,
      locked: false,
    }
  })
}

/* ── Canonical Picker (dropdown in table header) ── */

function CanonicalPicker({
  value,
  canonicalPool,
  usedCanonicals,
  locked,
  isRequired,
  onChange,
  onAddCanonical,
}: {
  value: string
  canonicalPool: string[]
  usedCanonicals: Map<string, string> // canonical → csvColumn that uses it
  locked: boolean
  isRequired?: boolean
  onChange: (canonical: string) => void
  onAddCanonical: (canonical: string) => void
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
    return canonicalPool.filter((c) => c.toLowerCase().includes(q))
  }, [canonicalPool, search])

  const searchTrimmed = search.trim()
  const isNewCanonical = searchTrimmed && !canonicalPool.includes(searchTrimmed)

  const handleCreateAndSelect = () => {
    if (!isNewCanonical) return
    const snaked = toSnakeCase(searchTrimmed)
    if (!snaked) return
    onAddCanonical(snaked)
    onChange(snaked)
    setOpen(false)
    setSearch('')
  }

  const { available, taken } = useMemo(() => {
    const a: string[] = []
    const t: string[] = []
    for (const c of filtered) {
      const usedBy = usedCanonicals.get(c)
      if (!usedBy || usedBy === value) a.push(c)
      else t.push(c)
    }
    return { available: a, taken: t }
  }, [filtered, usedCanonicals, value])

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => { if (!locked) setOpen(!open) }}
        className={`w-full text-left text-[11px] font-mono rounded px-1.5 py-0.5 flex items-center gap-1 transition-colors ${
          locked
            ? 'text-blue-600 cursor-default'
            : 'text-blue-700 hover:bg-blue-100 hover:text-blue-900 cursor-pointer'
        }`}
        disabled={locked}
        title={value}
      >
        <span className="truncate">{value}{isRequired && <sup className="text-red-500 text-[9px] font-bold ml-0.5">*</sup>}</span>
        {!locked && (
          <svg className="w-3 h-3 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute z-50 left-0 mt-1 bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden"
          style={{ minWidth: '200px' }}
        >
          <div className="p-1.5 border-b border-gray-100">
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isNewCanonical) handleCreateAndSelect()
              }}
              placeholder="Search or create canonical name..."
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {available.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { onChange(c); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-1.5 text-[11px] font-mono hover:bg-blue-50 flex items-center gap-1.5 ${
                  c === value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                }`}
              >
                {c === value && <span className="text-blue-500 flex-shrink-0">&#10003;</span>}
                <span className="truncate">{c}</span>
                {REQUIRED.has(c) && (
                  <span className="text-red-500 text-[10px] font-bold flex-shrink-0 ml-auto" title="Required">*</span>
                )}
              </button>
            ))}
            {taken.length > 0 && (
              <>
                <div className="px-3 py-1 text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-50 border-t border-gray-100">
                  Used by other columns
                </div>
                {taken.map((c) => {
                  const usedBy = usedCanonicals.get(c)!
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => { onChange(c); setOpen(false); setSearch('') }}
                      className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-gray-400 hover:bg-amber-50 hover:text-gray-600 flex items-center justify-between"
                    >
                      <span className="truncate">{c}</span>
                      <span className="text-[9px] text-gray-300 flex-shrink-0 ml-1">{usedBy}</span>
                    </button>
                  )
                })}
              </>
            )}
            {filtered.length === 0 && !isNewCanonical && (
              <div className="px-3 py-2 text-[11px] text-gray-400 text-center">No match</div>
            )}
            {isNewCanonical && (
              <button
                type="button"
                onClick={handleCreateAndSelect}
                className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-blue-600 hover:bg-blue-50 border-t border-gray-100 flex items-center gap-1.5"
              >
                <span className="flex-shrink-0">+</span>
                <span>Create &quot;{toSnakeCase(searchTrimmed)}&quot;</span>
                <span className="text-[9px] text-gray-400 ml-auto">Enter</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Merge Preview Table (inline in left panel) ── */

function MergePreviewContent({
  columns,
  preview,
  isFirstUpload,
  columnSearch = '',
  existingCanonicals = [],
}: {
  columns: ColumnState[]
  preview: CSVPreview
  isFirstUpload: boolean
  columnSearch?: string
  existingCanonicals?: string[]
}) {
  const [existingRows, setExistingRows] = useState<FlatRow[]>([])
  const [existingTotalCount, setExistingTotalCount] = useState(0)
  const [loading, setLoading] = useState(!isFirstUpload)

  const includedColumns = useMemo(() => columns.filter((c) => c.included), [columns])
  const canonicalNames = useMemo(() => [...new Set(includedColumns.map((c) => c.canonical))], [includedColumns])
  const filteredCanonicalNames = useMemo(() => {
    if (!columnSearch.trim()) return canonicalNames
    const q = columnSearch.toLowerCase()
    const matched = new Set(
      includedColumns
        .filter((c) => c.csvColumn.toLowerCase().includes(q) || c.canonical.toLowerCase().includes(q))
        .map((c) => c.canonical)
    )
    return [...matched]
  }, [includedColumns, canonicalNames, columnSearch])

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

  // Schema diff: categorize each column
  type ColDiffStatus = 'matched' | 'new' | 'missing'
  const existingSet = useMemo(() => new Set(existingCanonicals), [existingCanonicals])

  const columnDiffMap = useMemo(() => {
    const map = new Map<string, ColDiffStatus>()
    for (const col of canonicalNames) {
      map.set(col, existingSet.has(col) ? 'matched' : 'new')
    }
    // Columns in existing but not included in new mapping
    for (const col of existingCanonicals) {
      if (!map.has(col)) map.set(col, 'missing')
    }
    return map
  }, [canonicalNames, existingCanonicals, existingSet])

  // All columns for display (included canonicals + missing existing ones)
  const allDiffColumns = useMemo(() => {
    const cols = [...filteredCanonicalNames]
    if (!isFirstUpload) {
      const q = columnSearch.toLowerCase()
      for (const col of existingCanonicals) {
        if (!canonicalNames.includes(col)) {
          if (!q || col.toLowerCase().includes(q)) cols.push(col)
        }
      }
    }
    return cols
  }, [filteredCanonicalNames, existingCanonicals, canonicalNames, isFirstUpload, columnSearch])

  const diffCounts = useMemo(() => {
    let matched = 0, added = 0, missing = 0
    for (const [, status] of columnDiffMap) {
      if (status === 'matched') matched++
      else if (status === 'new') added++
      else if (status === 'missing') missing++
    }
    return { matched, added, missing }
  }, [columnDiffMap])

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

  // Header style helpers based on diff status
  const colHeaderClass = (col: string) => {
    const status = columnDiffMap.get(col)
    if (status === 'new') return 'bg-green-50 border-b-2 border-green-400'
    if (status === 'missing') return 'bg-red-50 border-b-2 border-red-300'
    return ''
  }
  const colHeaderTextClass = (col: string) => {
    const status = columnDiffMap.get(col)
    if (status === 'new') return 'text-green-700'
    if (status === 'missing') return 'text-red-400 line-through'
    return 'text-gray-500'
  }
  const colCellClass = (col: string, source: 'existing' | 'new') => {
    const status = columnDiffMap.get(col)
    if (status === 'new' && source === 'new') return 'bg-green-50/60'
    if (status === 'new' && source === 'existing') return 'bg-green-50/30'
    if (status === 'missing') return 'bg-red-50/40'
    return ''
  }

  return (
    <div className="flex flex-col h-full">
      {/* First upload notice */}
      {isFirstUpload && (
        <div className="flex-shrink-0 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700 mb-2 mx-1 mt-1">
          This will be the first dataset imported into this project.
        </div>
      )}

      {/* Schema diff summary bar */}
      {!isFirstUpload && (
        <div className="flex-shrink-0 mx-1 mt-1 mb-2 rounded-md border border-gray-200 bg-white px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500 mb-1.5">
            <span>Schema Changes</span>
            <div className="flex-1 h-px bg-gray-200"></div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-gray-400"></span>
              <span className="text-[11px] text-gray-600">
                <strong>{diffCounts.matched}</strong> matched
              </span>
            </div>
            {diffCounts.added > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                <span className="text-[11px] text-green-700">
                  <strong>+{diffCounts.added}</strong> new column{diffCounts.added !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            {diffCounts.missing > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-red-400"></span>
                <span className="text-[11px] text-red-600">
                  <strong>-{diffCounts.missing}</strong> not in new file
                </span>
              </div>
            )}
          </div>
          {diffCounts.missing > 0 && (
            <div className="mt-1.5 text-[10px] text-gray-400">
              Missing columns will be empty for the new rows after import.
            </div>
          )}
        </div>
      )}

      {/* Mismatch warnings */}
      {warnings.length > 0 && (
        <div className="flex-shrink-0 mx-1 mb-2 space-y-1">
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
              {allDiffColumns.map((col) => {
                const status = columnDiffMap.get(col)
                const csvCol = includedColumns.find((c) => c.canonical === col)?.csvColumn
                return (
                <th key={col} className={`px-3 py-2 text-left min-w-[120px] ${colHeaderClass(col)}`}>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] font-medium uppercase tracking-wider ${colHeaderTextClass(col)}`}>
                      {col}
                    </span>
                    {status === 'new' && (
                      <span className="rounded px-1 py-0.5 text-[8px] font-bold bg-green-100 text-green-700 border border-green-200 flex-shrink-0">NEW</span>
                    )}
                    {status === 'missing' && (
                      <span className="rounded px-1 py-0.5 text-[8px] font-bold bg-red-100 text-red-500 border border-red-200 flex-shrink-0">MISSING</span>
                    )}
                  </div>
                  {csvCol && csvCol !== col && (
                    <div className="text-[9px] text-gray-400 truncate" title={csvCol}>{csvCol}</div>
                  )}
                  {status === 'missing' && (
                    <div className="text-[9px] text-red-300 italic">not mapped in new file</div>
                  )}
                </th>
                )
              })}
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
                {allDiffColumns.map((col) => (
                  <td key={col} className={`px-3 py-2 text-xs text-gray-500 truncate max-w-[150px] ${colCellClass(col, 'existing')}`} title={row[col]}>
                    {row[col] ?? '\u2014'}
                  </td>
                ))}
              </tr>
            ))}

            {/* Divider */}
            {existingRows.length > 0 && newRows.length > 0 && (
              <tr>
                <td colSpan={allDiffColumns.length + 1} className="px-3 py-1 bg-gray-100 border-y-2 border-gray-200">
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

            {/* New rows (green-tinted for new cols, yellow for rest) */}
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
                {allDiffColumns.map((col) => {
                  const status = columnDiffMap.get(col)
                  const isMissing = status === 'missing'
                  return (
                    <td
                      key={col}
                      className={`px-3 py-2 text-xs truncate max-w-[150px] ${colCellClass(col, 'new')} ${
                        isMissing ? 'text-red-300 italic' : 'text-gray-700'
                      }`}
                      title={isMissing ? 'No data — column not mapped in new file' : row[col]}
                    >
                      {isMissing ? '\u2014' : row[col]}
                    </td>
                  )
                })}
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
  importProgress,
  isFirstUpload = true,
}: Props) {
  const [columns, setColumns] = useState<ColumnState[]>(() =>
    preservedColumnStates ?? buildInitialState(preview, derivedMappings, fromPreviousMapping)
  )
  const [canonicalPool, setCanonicalPool] = useState<string[]>(() =>
    buildCanonicalPool(derivedMappings, preservedColumnStates ?? buildInitialState(preview, derivedMappings, fromPreviousMapping))
  )
  const [newCanonicalInput, setNewCanonicalInput] = useState('')
  const [showAddInput, setShowAddInput] = useState(false)
  const [activeTab, setActiveTab] = useState<ActiveTab>('mapping')
  const [columnSearch, setColumnSearch] = useState('')

  /* ── Derived data ── */

  const canonicalToCsv = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of columns) {
      if (col.included && col.canonical) map.set(col.canonical, col.csvColumn)
    }
    return map
  }, [columns])

  // Map of canonical → csvColumn for all assigned canonicals (to detect which are taken)
  const usedCanonicals = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of columns) {
      if (col.canonical) map.set(col.canonical, col.csvColumn)
    }
    return map
  }, [columns])

  const [shuffleKey, setShuffleKey] = useState(0)
  const displayRows = useMemo(() => {
    const rows = [...preview.sampleRows]
    // Fisher-Yates shuffle
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rows[i], rows[j]] = [rows[j], rows[i]]
    }
    return rows.slice(0, MAX_PREVIEW_ROWS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.sampleRows, shuffleKey])

  // Filter columns by search query (matches CSV column name or canonical name)
  const filteredColumnIndices = useMemo(() => {
    if (!columnSearch.trim()) return columns.map((_, i) => i)
    const q = columnSearch.toLowerCase()
    return columns
      .map((col, i) => ({ col, i }))
      .filter(({ col }) => col.csvColumn.toLowerCase().includes(q) || col.canonical.toLowerCase().includes(q))
      .map(({ i }) => i)
  }, [columns, columnSearch])

  /* ── Callbacks ── */

  const toggleInclude = useCallback((index: number) => {
    setColumns((prev) => {
      if (prev[index].locked) return prev
      return prev.map((c, i) => (i === index ? { ...c, included: !c.included } : c))
    })
  }, [])

  const handleSetCanonical = useCallback((index: number, newCanonical: string) => {
    setColumns((prev) => prev.map((c, i) => {
      if (i === index) return { ...c, canonical: newCanonical }
      // Auto-swap: clear the canonical from whichever other unlocked column currently holds it
      if (newCanonical && c.canonical === newCanonical && !c.locked) return { ...c, canonical: '' }
      return c
    }))
  }, [])

  const handleAddCanonical = useCallback(() => {
    const trimmed = newCanonicalInput.trim()
    if (!trimmed || canonicalPool.includes(trimmed)) {
      setNewCanonicalInput('')
      setShowAddInput(false)
      return
    }
    setCanonicalPool((prev) => [...prev, trimmed])
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
  const assignedCanonicals = canonicalPool.filter((c) => columns.some((col) => col.canonical === c) || REQUIRED.has(c))
  const mappedCanonicalCount = assignedCanonicals.filter((c) => canonicalToCsv.has(c)).length

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
          <h3 className="text-sm font-medium text-gray-700">Review Column Mapping</h3>
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

      {/* Split panel: Left (tabs: mapping table / merge preview) + Right (mapping summary) */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* ═══ LEFT PANEL ═══ */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar */}
          <div className="flex-shrink-0 flex items-center border-b border-gray-200 mb-0">
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
            <div className="ml-auto flex items-center gap-2 px-2 pb-1">
              <button
                onClick={() => setShuffleKey((k) => k + 1)}
                className="rounded border border-blue-300 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                title="Refresh with random rows"
              >
                Refresh
              </button>
              <span className="text-[10px] text-gray-400">
                {displayRows.length} of {preview.totalRows.toLocaleString()} rows
              </span>
              <input
                value={columnSearch}
                onChange={(e) => setColumnSearch(e.target.value)}
                placeholder="Search columns..."
                className="text-xs border border-gray-200 rounded px-2 py-1 w-40 outline-none focus:border-blue-400"
              />
            </div>
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
                    {filteredColumnIndices.map((index) => {
                      const col = columns[index]
                      return (
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
                      )
                    })}
                  </tr>
                  <tr className="border-b border-gray-200 bg-blue-50/30">
                    {filteredColumnIndices.map((index) => {
                      const col = columns[index]
                      const isRequired = REQUIRED.has(col.canonical)
                      const isAddress = isAddressColumn(col.canonical)
                      return (
                        <th
                          key={`canonical-${index}`}
                          className={`px-3 py-1.5 text-left min-w-[130px] max-w-[200px] transition-opacity ${
                            !col.included ? 'opacity-40' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1 min-w-0">
                            <CanonicalPicker
                              value={col.canonical}
                              canonicalPool={canonicalPool}
                              usedCanonicals={usedCanonicals}
                              locked={col.locked}
                              isRequired={isRequired}
                              onChange={(newCanonical) => handleSetCanonical(index, newCanonical)}
                              onAddCanonical={(c) => setCanonicalPool((prev) => prev.includes(c) ? prev : [...prev, c])}
                            />
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
                      {filteredColumnIndices.map((ci) => {
                        const col = columns[ci]
                        return (
                        <td
                          key={ci}
                          className={`px-3 py-2 text-xs truncate max-w-[180px] transition-opacity ${
                            col.included ? 'text-gray-700' : 'text-gray-300 opacity-40'
                          }`}
                          title={String(row[col.csvColumn] ?? '')}
                        >
                          {String(row[col.csvColumn] ?? '\u2014')}
                        </td>
                        )
                      })}
                    </tr>
                  ))}
                  {preview.totalRows > displayRows.length && (
                    <tr>
                      <td colSpan={filteredColumnIndices.length + 1} className="px-3 py-2 text-center text-[11px] text-gray-400 bg-gray-50">
                        Showing {displayRows.length} of {preview.totalRows.toLocaleString()} rows
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
                columnSearch={columnSearch}
                existingCanonicals={derivedMappings.existingCanonicals}
              />
            )}
          </div>
        </div>

        {/* ═══ RIGHT: Mapping Summary Panel ═══ */}
        <div className="w-72 flex-shrink-0 flex flex-col rounded-md border border-gray-200 bg-gray-50/50">
          <div className="px-3 py-2.5 border-b border-gray-200 bg-white rounded-t-md">
            <h4 className="text-xs font-semibold text-gray-700">Mapping Summary</h4>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {mappedCanonicalCount} of {assignedCanonicals.length} mapped
            </p>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
            {canonicalPool.filter((canonical) => {
              // Show only canonicals that are assigned to a column or are required
              const isAssigned = columns.some((c) => c.canonical === canonical)
              return isAssigned || REQUIRED.has(canonical)
            }).map((canonical) => {
              const csvCol = canonicalToCsv.get(canonical)
              const isMapped = !!csvCol
              const isRequired = REQUIRED.has(canonical)
              return (
                <div
                  key={canonical}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    isMapped
                      ? 'border-green-200 bg-green-50/50'
                      : isRequired
                        ? 'border-red-200 bg-red-50/30'
                        : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-semibold text-gray-800 truncate" title={canonical}>
                      {canonical}{isRequired && <sup className="text-red-500 text-[9px] font-bold ml-0.5">*</sup>}
                    </span>
                    {isMapped && (
                      <span className="text-green-500 text-[10px] flex-shrink-0 ml-auto">&#10003;</span>
                    )}
                  </div>
                  {isMapped ? (
                    <p className="mt-0.5 text-[10px] text-green-600 truncate" title={csvCol}>
                      &rarr; {csvCol}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[10px] text-gray-400">Unmapped</p>
                  )}
                </div>
              )
            })}
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
            onClick={() => void onBack()}
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
                  ? `${importProgress.currentStep} (${importProgress.percentage}%)`
                  : 'Starting import...'}
              </>
            ) : (
              'Next \u2192'
            )}
          </button>
        </div>
      </div>

      {/* Import progress bar */}
      {importing && importProgress && (
        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-blue-800">{importProgress.currentStep}</span>
            <span className="text-blue-600">
              {importProgress.processedRows.toLocaleString()} / ~{importProgress.totalRows.toLocaleString()} rows
            </span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-blue-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300 ease-out"
              style={{ width: `${importProgress.percentage}%` }}
            />
          </div>
          <div className="mt-1 text-right text-xs text-blue-500">{importProgress.percentage}%</div>
        </div>
      )}
    </div>
  )
}
