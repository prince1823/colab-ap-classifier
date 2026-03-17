import { useState, useEffect, useCallback } from 'react'
import { ipc } from '../../lib/ipc'
import type { MappingRow } from '../../../shared/types/column-mapping'

interface Props {
  allMappings: MappingRow[]
  onSave: (llmOrder: string[], nonLlm: string[]) => void
  onBack: () => void
}

interface TransactionPreviewRow {
  [key: string]: unknown
}

export default function DataPriorityStep({ allMappings, onSave, onBack }: Props) {
  const allCanonicals = [...new Set(allMappings.filter((m) => m.csvColumn).map((m) => m.canonical))]

  const [llmOrder, setLlmOrder] = useState<string[]>([])
  const [nonLlm, setNonLlm] = useState<string[]>(() => [...allCanonicals])
  const [missingColumns, setMissingColumns] = useState<string[]>([])
  const [loadedFromSaved, setLoadedFromSaved] = useState(false)

  const [previewColumns, setPreviewColumns] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<TransactionPreviewRow[]>([])
  const [totalRows, setTotalRows] = useState(0)

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
    }).catch(() => {})
  }, [])

  useEffect(() => {
    setPreviewColumns(allCanonicals)
    ipc.transactions.query().then((result) => {
      const flat = result.rows.slice(0, 10).map((r) => ({
        ...r,
        ...r.canonicalFields,
      })) as TransactionPreviewRow[]
      setPreviewRows(flat)
      setTotalRows(result.total)
    }).catch(() => {})
  }, [])

  // Drag state for LLM rows
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

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

  const removeFromLlm = (canonical: string) => {
    setLlmOrder((prev) => prev.filter((c) => c !== canonical))
    setNonLlm((prev) => [...prev, canonical])
  }

  const addToLlm = (canonical: string) => {
    setNonLlm((prev) => prev.filter((c) => c !== canonical))
    setLlmOrder((prev) => [...prev, canonical])
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Top: Transaction preview */}
      <div className="flex-shrink-0">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-700">Transaction Preview</h3>
          {totalRows > 0 && (
            <span className="text-xs text-gray-500">
              Showing {Math.min(previewRows.length, 10)} of {totalRows.toLocaleString()} rows
            </span>
          )}
        </div>
        {previewRows.length > 0 ? (
          <div className="max-h-[240px] overflow-auto rounded-md border border-gray-200">
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

      {/* Warning: saved priorities reference unmapped columns */}
      {missingColumns.length > 0 && (
        <div className="flex-shrink-0 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <span className="font-semibold">Warning:</span> Previously saved priorities include columns not in current mappings:{' '}
          <span className="font-mono">{missingColumns.join(', ')}</span>.
          These columns will be removed from priorities on save.
        </div>
      )}

      {/* Column priority heading */}
      <div className="flex-shrink-0 flex items-baseline gap-3">
        <h3 className="text-sm font-medium text-gray-700">Column Priority</h3>
        <p className="text-xs text-gray-400">
          {loadedFromSaved
            ? 'Loaded from saved priorities. Drag and drop to adjust before classification.'
            : 'Drag and drop rows to set priority. Higher position = more weight for LLM classification.'}
        </p>
      </div>

      {/* Column priority table */}
      <div className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="w-8 px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-gray-400">#</th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">Column</th>
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
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-400 italic">
                  No columns available
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
