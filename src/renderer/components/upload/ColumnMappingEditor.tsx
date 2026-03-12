import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { Eye, EyeOff, GripHorizontal, RotateCcw } from 'lucide-react'
import type { ColumnMappingWithPriority, DerivedMappings, CompletedUpload, ConfidenceLevel } from '../../../shared/types/column-mapping'
import { REQUIRED_CANONICAL_COLUMNS, KNOWN_CANONICALS } from '../../../shared/canonical-columns'

// ── Types ────────────────────────────────────────────────────────────

const DRAG_TYPE = 'CANONICAL_BADGE'

interface DragItem {
  type: string
  canonical: string
  sourceColumn: string | null
}

interface ColumnState {
  csvColumn: string
  canonical: string | null
  excluded: boolean
}

interface Props {
  /** Derived mappings from backend (rows: MappingRow[], existingCanonicals) */
  derivedMappings: DerivedMappings
  /** CSV column headers */
  csvColumns: string[]
  /** Sample data rows for inline preview */
  sampleRows: Record<string, string>[]
  /** Total row count in the CSV */
  totalRows: number
  /** Confidence level of the mapping suggestion */
  confidence?: ConfidenceLevel
  /** Reasoning from the LLM for mapping choices */
  reasoning?: string
  /** Called whenever the mapping changes */
  onMappingChange: (mapping: ColumnMappingWithPriority) => void
  /** Completed upload history for "Apply Previous Mappings" */
  completedUploads?: CompletedUpload[]
}

// ── Helpers ──────────────────────────────────────────────────────────

function toSnakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

const REQUIRED_SET = new Set<string>(REQUIRED_CANONICAL_COLUMNS)

function isRequired(canonical: string): boolean {
  return REQUIRED_SET.has(canonical)
}

function deriveInitialState(
  derivedMappings: DerivedMappings,
  csvColumns: string[],
): { columns: ColumnState[]; unassignedCanonicals: string[] } {
  // Build csv → canonical lookup from mapping rows
  const csvToCanonical: Record<string, string> = {}
  for (const row of derivedMappings.rows) {
    if (row.csvColumn) {
      csvToCanonical[row.csvColumn] = row.canonical
    }
  }

  const columns: ColumnState[] = csvColumns.map((csvColumn) => ({
    csvColumn,
    canonical: csvToCanonical[csvColumn] ?? null,
    excluded: false, // all included by default
  }))

  const assignedCanonicals = new Set(derivedMappings.rows.filter((r) => r.csvColumn).map((r) => r.canonical))
  const unassignedCanonicals = KNOWN_CANONICALS.filter((c) => !assignedCanonicals.has(c))

  return { columns, unassignedCanonicals: [...unassignedCanonicals] }
}

function buildMapping(columns: ColumnState[]): ColumnMappingWithPriority {
  const result: ColumnMappingWithPriority = {}
  let priority = 1
  for (const col of columns) {
    if (col.excluded) continue
    const key = col.canonical || toSnakeCase(col.csvColumn)
    result[key] = {
      csvColumn: col.csvColumn,
      classificationPriority: priority++,
    }
  }
  return result
}

// ── Drag Source: Canonical Badge ─────────────────────────────────────

function CanonicalBadge({
  canonical,
  sourceColumn,
}: {
  canonical: string
  sourceColumn: string | null
}) {
  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DRAG_TYPE,
      item: { type: DRAG_TYPE, canonical, sourceColumn } as DragItem,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [canonical, sourceColumn],
  )

  const req = isRequired(canonical)

  return (
    <span
      ref={dragRef}
      className={`canonical-badge ${req ? 'required' : 'optional'} ${isDragging ? 'dragging' : ''}`}
    >
      <GripHorizontal size={10} className="opacity-40 flex-shrink-0" />
      {canonical}
      {req && <span className="canonical-req-dot" />}
    </span>
  )
}

// ── Drop Target wrapper ──────────────────────────────────────────────

function ColumnDropZone({
  csvColumn,
  excluded,
  onAssign,
  children,
}: {
  csvColumn: string
  excluded: boolean
  onAssign: (canonical: string, target: string) => void
  children: React.ReactNode
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop(
    () => ({
      accept: DRAG_TYPE,
      canDrop: () => !excluded,
      drop: (item: DragItem) => {
        onAssign(item.canonical, csvColumn)
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [csvColumn, excluded, onAssign],
  )

  let cls = 'column-drop-target'
  if (isOver && canDrop) cls += ' drop-hover'
  else if (isOver && !canDrop) cls += ' drop-invalid'

  return (
    <td ref={dropRef} className={cls}>
      {children}
    </td>
  )
}

// ── Unassigned pool drop zone (for returning badges) ────────────────

function UnassignedDropZone({
  onReturn,
  children,
}: {
  onReturn: (canonical: string) => void
  children: React.ReactNode
}) {
  const [{ isOver }, dropRef] = useDrop(
    () => ({
      accept: DRAG_TYPE,
      drop: (item: DragItem) => {
        // Only accept drops from assigned columns (not already in pool)
        if (item.sourceColumn) {
          onReturn(item.canonical)
        }
      },
      collect: (monitor) => ({ isOver: monitor.isOver() }),
    }),
    [onReturn],
  )

  return (
    <div ref={dropRef} className={`unassigned-pool ${isOver ? 'pool-hover' : ''}`}>
      {children}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────

function ColumnMappingEditorInner({
  derivedMappings,
  csvColumns,
  sampleRows,
  totalRows,
  confidence,
  reasoning,
  onMappingChange,
  completedUploads,
}: Props) {
  const initial = useMemo(() => deriveInitialState(derivedMappings, csvColumns), [derivedMappings, csvColumns])
  const [columns, setColumns] = useState<ColumnState[]>(initial.columns)
  const [unassigned, setUnassigned] = useState<string[]>(initial.unassignedCanonicals)

  // Sync when derivedMappings changes
  const prevMappingKey = useRef('')
  useEffect(() => {
    const key = JSON.stringify(derivedMappings.rows)
    if (key === prevMappingKey.current) return
    prevMappingKey.current = key
    const fresh = deriveInitialState(derivedMappings, csvColumns)
    setColumns(fresh.columns)
    setUnassigned(fresh.unassignedCanonicals)
  }, [derivedMappings, csvColumns])

  // Fire onMappingChange whenever columns change
  useEffect(() => {
    onMappingChange(buildMapping(columns))
  }, [columns, onMappingChange])

  // ── Handlers ─────────────────────────────────────────────────────

  const handleAssignCanonical = useCallback((canonical: string, targetCsv: string) => {
    setColumns((prev) => {
      const next = prev.map((c) => ({ ...c }))

      // Remove from source column
      const srcIdx = next.findIndex((c) => c.canonical === canonical)
      if (srcIdx >= 0) {
        next[srcIdx].canonical = null
      }

      // If target already has a canonical, displace it
      const tgtIdx = next.findIndex((c) => c.csvColumn === targetCsv)
      if (tgtIdx >= 0) {
        const displaced = next[tgtIdx].canonical
        if (displaced) {
          // If the source column exists, swap
          if (srcIdx >= 0) {
            next[srcIdx].canonical = displaced
          } else {
            // Displaced goes to unassigned
            setUnassigned((u) => [...u, displaced])
          }
        }
        next[tgtIdx].canonical = canonical
      }

      return next
    })

    // Remove from unassigned pool if it was there
    setUnassigned((prev) => prev.filter((c) => c !== canonical))
  }, [])

  const handleReturnToPool = useCallback((canonical: string) => {
    setColumns((prev) =>
      prev.map((c) => (c.canonical === canonical ? { ...c, canonical: null } : c)),
    )
    setUnassigned((prev) => (prev.includes(canonical) ? prev : [...prev, canonical]))
  }, [])

  const handleToggleExclude = useCallback((csvColumn: string) => {
    setColumns((prev) => {
      const next = prev.map((c) => {
        if (c.csvColumn !== csvColumn) return c
        const newExcluded = !c.excluded
        if (newExcluded && c.canonical) {
          // Move canonical to unassigned
          setUnassigned((u) => [...u, c.canonical!])
          return { ...c, excluded: true, canonical: null }
        }
        return { ...c, excluded: newExcluded }
      })
      return next
    })
  }, [])

  const handleApplyPrevious = useCallback(() => {
    if (!completedUploads || completedUploads.length === 0) return
    const prevMappings = completedUploads[0].mappings // MappingRow[]

    // Build csv → canonical lookup
    const csvToCanonical: Record<string, string> = {}
    for (const row of prevMappings) {
      if (row.csvColumn) {
        csvToCanonical[row.csvColumn] = row.canonical
      }
    }

    setColumns((prev) =>
      prev.map((col) => {
        const matched = csvToCanonical[col.csvColumn] ?? null
        return {
          ...col,
          canonical: matched,
          excluded: !matched,
        }
      }),
    )

    const assignedSet = new Set(prevMappings.filter((m) => m.csvColumn).map((m) => m.canonical))
    setUnassigned([...KNOWN_CANONICALS].filter((c) => !assignedSet.has(c)))
  }, [completedUploads])

  // ── Computed ─────────────────────────────────────────────────────

  const CONFIDENCE_STYLES: Record<string, string> = {
    high: 'bg-green-100 text-green-700',
    medium: 'bg-yellow-100 text-yellow-700',
    low: 'bg-red-100 text-red-700',
  }

  const displayRows = sampleRows.slice(0, 7)

  return (
    <div className="space-y-4">
      {/* ── Top bar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-700">Column Mappings</h3>
          {confidence && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[confidence] ?? ''}`}>
              {confidence} confidence
            </span>
          )}
        </div>
        {completedUploads && completedUploads.length > 0 && (
          <button
            onClick={handleApplyPrevious}
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <RotateCcw size={12} />
            Apply Previous Mappings
          </button>
        )}
      </div>

      {reasoning && (
        <p className="text-xs text-gray-500">{reasoning}</p>
      )}



      {/* ── Unassigned canonical pool ────────────────────────────── */}
      {unassigned.length > 0 && (
        <UnassignedDropZone onReturn={handleReturnToPool}>
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mr-2">
            Unassigned
          </span>
          {unassigned.map((c) => (
            <CanonicalBadge key={c} canonical={c} sourceColumn={null} />
          ))}
        </UnassignedDropZone>
      )}

      {/* ── Main table ───────────────────────────────────────────── */}
      <div className="mapping-table-wrap">
        <table className="min-w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            {/* Row 1: CSV column names + exclude toggles */}
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="mapping-th-hash">#</th>
              {columns.map((col) => (
                <th
                  key={col.csvColumn}
                  className={`mapping-th-col ${col.excluded ? 'col-excluded' : ''}`}
                >
                  <div className="flex items-center gap-1">
                    <span className="truncate flex-1 text-left">{col.csvColumn}</span>
                    <button
                      onClick={() => handleToggleExclude(col.csvColumn)}
                      className="mapping-eye-btn"
                      title={col.excluded ? 'Include column' : 'Exclude column'}
                    >
                      {col.excluded ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                </th>
              ))}
            </tr>

            {/* Row 2: Canonical name badges (drop targets) */}
            <tr className="bg-white border-b-2 border-gray-200">
              <td className="mapping-td-hash" />
              {columns.map((col) => (
                <ColumnDropZone
                  key={col.csvColumn}
                  csvColumn={col.csvColumn}
                  excluded={col.excluded}
                  onAssign={handleAssignCanonical}
                >
                  {col.excluded ? (
                    <span className="text-[10px] text-gray-300 italic">excluded</span>
                  ) : col.canonical ? (
                    <CanonicalBadge canonical={col.canonical} sourceColumn={col.csvColumn} />
                  ) : (
                    <span className="text-[10px] text-gray-300 italic">drop here</span>
                  )}
                </ColumnDropZone>
              ))}
            </tr>
          </thead>

          {/* Data rows */}
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i} className="mapping-data-row">
                <td className="mapping-td-hash">{i + 1}</td>
                {columns.map((col) => (
                  <td
                    key={col.csvColumn}
                    className={`mapping-td-data ${col.excluded ? 'col-excluded' : ''}`}
                  >
                    {String(row[col.csvColumn] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Row count */}
      {displayRows.length < totalRows && (
        <p className="text-center text-xs text-gray-400">
          Showing {displayRows.length} of ~{totalRows.toLocaleString()} rows. All rows will be imported.
        </p>
      )}
    </div>
  )
}

// ── Wrapper with DndProvider ─────────────────────────────────────────

export default function ColumnMappingEditor(props: Props) {
  return (
    <DndProvider backend={HTML5Backend}>
      <ColumnMappingEditorInner {...props} />
    </DndProvider>
  )
}
