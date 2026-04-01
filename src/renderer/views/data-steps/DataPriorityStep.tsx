import { useState, useEffect, useCallback, useRef } from 'react'
import { ipc } from '../../lib/ipc'
import { showError } from '../../lib/toast-errors'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { MappingRow } from '../../../shared/types/column-mapping'
import { VIRTUAL_COLUMN_NAMES } from '../../../shared/virtual-columns'

interface Props {
  allMappings: MappingRow[]
  onSave: (llmOrder: string[], nonLlm: string[]) => void
  onBack: () => void
}

interface TransactionPreviewRow {
  [key: string]: unknown
}

export default function DataPriorityStep({ allMappings, onSave, onBack }: Props) {
  const projectFilePath = useWorkflowStore((s) => s.projectFilePath)
  // Virtual columns (supplier_name, parent_name, etc.) are resolved via JOINs and cannot
  // contribute to LLM dedup groups — exclude them from the priority UI entirely.
  const allCanonicals = [...new Set(
    allMappings.filter((m) => m.csvColumn).map((m) => m.canonical).filter((c) => !VIRTUAL_COLUMN_NAMES.has(c))
  )]

  const [llmOrder, setLlmOrder] = useState<string[]>([])
  const [nonLlm, setNonLlm] = useState<string[]>(() => [...allCanonicals])
  const [missingColumns, setMissingColumns] = useState<string[]>([])
  const [loadedFromSaved, setLoadedFromSaved] = useState(false)

  const [previewColumns, setPreviewColumns] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<TransactionPreviewRow[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [valueCounts, setValueCounts] = useState<Record<string, number>>({})

  // Fetch existing column_priorities from a previous user-saved session
  // Only pre-populate if the user previously saved a curated (non-default) priority list
  useEffect(() => {
    ipc.project.getSetting('column_priorities_saved').then((saved) => {
      if (!saved || !Array.isArray(saved) || saved.length === 0) return

      const savedPriorities = saved as string[]
      const canonicalSet = new Set(allCanonicals)

      // Find columns in saved priorities that are no longer mapped
      const missing = savedPriorities.filter((col) => !canonicalSet.has(col))
      if (missing.length > 0) setMissingColumns(missing)

      // Pre-populate: saved priorities that exist in current mappings go to LLM
      const validSaved = savedPriorities.filter((col) => canonicalSet.has(col))
      const remaining = allCanonicals.filter((col) => !validSaved.includes(col))

      setLlmOrder(validSaved)
      setNonLlm(remaining)
      setLoadedFromSaved(true)
    }).catch((e) => showError('Failed to load saved column priorities', e))
  }, [projectFilePath])

  const loadPreview = useCallback(async () => {
    setPreviewColumns(allCanonicals)
    try {
      const result = await ipc.transactions.query({ pageSize: 100, randomize: true })
      setTotalRows(result.totalCount)
      const flat = result.rows.map((r) => ({
        ...r,
        ...r.canonicalFields,
      })) as TransactionPreviewRow[]
      setPreviewRows(flat)
    } catch (e) {
      showError('Failed to load transaction preview', e)
    }
  }, [])

  useEffect(() => {
    loadPreview()
  }, [projectFilePath])

  // Fetch unique value counts for each canonical column
  useEffect(() => {
    Promise.all(
      allCanonicals.map(async (col) => {
        const values = await ipc.transactions.distinctValues(col)
        return [col, values.length] as const
      })
    ).then((entries) => {
      setValueCounts(Object.fromEntries(entries))
    }).catch((e) => showError('Failed to load value counts', e))
  }, [projectFilePath])

  // Drag state for LLM rows
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const priorityContainerRef = useRef<HTMLDivElement>(null)

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)

    // Auto-scroll the priority container when dragging near edges
    const container = priorityContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const scrollZone = 40
    const y = e.clientY
    if (y - rect.top < scrollZone) {
      container.scrollBy({ top: -10 })
    } else if (rect.bottom - y < scrollZone) {
      container.scrollBy({ top: 10 })
    }
  }, [])

  const handleDrop = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    setLlmOrder((prev) => {
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

  // Resizable split panel state (percentage for top panel)
  const [splitPercent, setSplitPercent] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingSplit = useRef(false)

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingSplit.current = true

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingSplit.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((ev.clientY - rect.top) / rect.height) * 100
      setSplitPercent(Math.min(80, Math.max(20, pct)))
    }
    const onMouseUp = () => {
      isDraggingSplit.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const removeFromLlm = (canonical: string) => {
    setLlmOrder((prev) => prev.filter((c) => c !== canonical))
    setNonLlm((prev) => [...prev, canonical])
  }

  const addToLlm = (canonical: string) => {
    setNonLlm((prev) => prev.filter((c) => c !== canonical))
    setLlmOrder((prev) => [...prev, canonical])
  }

  return (
    <div className="flex flex-col h-full">
      {/* Warning: saved priorities reference unmapped columns */}
      {missingColumns.length > 0 && (
        <div className="flex-shrink-0 mb-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <span className="font-semibold">Warning:</span> Previously saved priorities include columns not in current mappings:{' '}
          <span className="font-mono">{missingColumns.join(', ')}</span>.
          These columns will be removed from priorities on save.
        </div>
      )}

      {/* Resizable split container */}
      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
        {/* Top: Transaction preview */}
        <div className="flex flex-col min-h-0" style={{ height: `${splitPercent}%` }}>
          <div className="mb-2 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-gray-700">Transaction Preview</h3>
              <button
                onClick={loadPreview}
                className="rounded border border-blue-300 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                title="Refresh with random rows"
              >
                Refresh
              </button>
            </div>
            {totalRows > 0 && (
              <span className="text-xs text-gray-500">
                Showing {Math.min(previewRows.length, 100)} of {totalRows.toLocaleString()} rows
              </span>
            )}
          </div>
          {previewRows.length > 0 ? (
            <div className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr>
                    <th className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-400">#</th>
                    {previewColumns.map((col) => (
                      <th key={col} className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {previewRows.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-400">{i + 1}</td>
                      {previewColumns.map((col) => (
                        <td key={col} className="max-w-xs truncate whitespace-nowrap px-3 py-2 text-gray-700">
                          {String(row[col] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-sm text-gray-400">
              Loading transaction preview...
            </div>
          )}
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={handleSplitMouseDown}
          className="flex-shrink-0 flex items-center justify-center h-3 cursor-row-resize group hover:bg-blue-50 border-y border-gray-200 my-1"
        >
          <div className="w-8 h-0.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
        </div>

        {/* Bottom: Column priority */}
        <div className="flex flex-col min-h-0" style={{ height: `${100 - splitPercent}%` }}>
          <div className="flex-shrink-0 flex items-baseline gap-3 mb-2">
            <h3 className="text-sm font-medium text-gray-700">Column Priority</h3>
            <p className="text-xs text-gray-400">
              {loadedFromSaved
                ? 'Loaded from saved priorities. Drag and drop to adjust before classification.'
                : 'Drag and drop rows to set priority. Higher position = more weight for LLM classification.'}
            </p>
          </div>

          {/* Column priority table */}
          <div ref={priorityContainerRef} className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="w-8 px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-400">#</th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">Column</th>
              <th className="w-28 px-3 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-500">Unique Values</th>
              <th className="w-28 px-3 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-500">Sent to LLM</th>
              <th className="w-20 px-3 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-500">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {/* LLM columns — draggable */}
            {llmOrder.map((canonical, index) => (
              <tr
                key={canonical}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
                className={`cursor-grab active:cursor-grabbing transition-all hover:bg-blue-50/30 ${
                  dragIndex === index ? 'opacity-30' : ''
                } ${dragOverIndex === index && dragIndex !== index ? 'border-t-2 border-t-blue-500' : ''}`}
              >
                <td className="px-2 py-2 text-center">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700">
                    {index + 1}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm font-medium text-gray-800">{canonical}</td>
                <td className="px-3 py-2 text-center text-sm text-gray-600">
                  {valueCounts[canonical] !== undefined ? valueCounts[canonical].toLocaleString() : '...'}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">Yes</span>
                </td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => removeFromLlm(canonical)}
                    className="rounded px-2 py-0.5 text-[10px] font-medium text-red-500 hover:bg-red-50 hover:text-red-700"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}

            {/* Non-LLM columns */}
            {nonLlm.map((canonical) => (
              <tr key={canonical} className="bg-gray-50/50 hover:bg-gray-50">
                <td className="px-2 py-2 text-center text-xs text-gray-300">&mdash;</td>
                <td className="px-3 py-2 text-sm text-gray-500">{canonical}</td>
                <td className="px-3 py-2 text-center text-sm text-gray-600">
                  {valueCounts[canonical] !== undefined ? valueCounts[canonical].toLocaleString() : '...'}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-400">No</span>
                </td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => addToLlm(canonical)}
                    className="rounded px-2 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Add
                  </button>
                </td>
              </tr>
            ))}

            {llmOrder.length === 0 && nonLlm.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-xs text-gray-400 italic">
                  No columns available
                </td>
              </tr>
            )}
          </tbody>
        </table>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-gray-200">
        <div className="text-xs text-gray-500">
          {llmOrder.length} column{llmOrder.length !== 1 ? 's' : ''} sent to LLM &middot; Drag to reorder priority
          {loadedFromSaved && <span className="ml-2 text-blue-500">&middot; Restored from saved priorities</span>}
        </div>
        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <button
            onClick={() => onSave(llmOrder, nonLlm)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save Priorities &rarr;
          </button>
        </div>
      </div>
    </div>
  )
}
