import { useState, useEffect, useRef, useCallback } from 'react'
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

const DRAG_ITEM_TYPE = 'PRIORITY_COLUMN'

export default function DataPriorityStep({ allMappings, onSave, onBack }: Props) {
  // Default: only supplier_name in the LLM list, rest in non-LLM
  const allCanonicals = [...new Set(allMappings.filter((m) => m.csvColumn).map((m) => m.canonical))]

  const [llmOrder, setLlmOrder] = useState<string[]>(() =>
    allCanonicals.filter((c) => c === 'supplier_name')
  )
  const [nonLlm, setNonLlm] = useState<string[]>(() =>
    allCanonicals.filter((c) => c !== 'supplier_name')
  )

  // Combined transaction preview
  const [previewColumns, setPreviewColumns] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<TransactionPreviewRow[]>([])
  const [totalRows, setTotalRows] = useState(0)

  useEffect(() => {
    // Load combined preview from transactions table
    Promise.all([
      ipc.transactions.query(),
      ipc.transactions.getColumns(),
    ]).then(([result, columns]) => {
      setPreviewColumns(columns)
      setPreviewRows(result.rows.slice(0, 10) as TransactionPreviewRow[])
      setTotalRows(result.total)
    }).catch(() => {
      // Ignore — preview is optional
    })
  }, [])

  // Drag state
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
    <div className="flex gap-6 h-full">
      {/* Left: Combined transaction preview */}
      <div className="flex-1 min-w-0">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-700">Transaction Preview</h3>
          {totalRows > 0 && (
            <span className="text-xs text-gray-500">
              Showing {Math.min(previewRows.length, 10)} of {totalRows.toLocaleString()} rows
            </span>
          )}
        </div>
        {previewRows.length > 0 ? (
          <div className="max-h-[480px] overflow-auto rounded-md border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                    #
                  </th>
                  {previewColumns.map((col) => (
                    <th
                      key={col}
                      className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {previewRows.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-400">
                      {i + 1}
                    </td>
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
          <div className="flex items-center justify-center py-12 text-sm text-gray-400">
            Loading transaction preview...
          </div>
        )}
      </div>

      {/* Right: Priority order */}
      <div className="w-80 flex-shrink-0 space-y-4 overflow-auto">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Columns sent to LLM</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Drag to reorder. Higher position = more weight.
          </p>
        </div>

        {/* LLM columns — draggable */}
        <div className="space-y-1">
          {llmOrder.map((canonical, index) => (
            <div
              key={canonical}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 cursor-grab active:cursor-grabbing transition-all ${
                dragIndex === index ? 'opacity-50 border-blue-300' : 'border-gray-200'
              } ${dragOverIndex === index && dragIndex !== index ? 'border-t-2 border-t-blue-500' : ''}`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700 flex-shrink-0">
                {index + 1}
              </span>
              <span className="flex-1 text-sm text-gray-700 truncate">{canonical}</span>
              <button
                onClick={() => removeFromLlm(canonical)}
                className="rounded p-0.5 text-gray-400 hover:text-red-500 text-xs flex-shrink-0"
                title="Remove from LLM"
              >
                &times;
              </button>
            </div>
          ))}
          {llmOrder.length === 0 && (
            <p className="text-xs text-gray-400 italic py-2">No columns selected for LLM.</p>
          )}
        </div>

        {/* Non-LLM columns */}
        {nonLlm.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Not sent to LLM
            </h4>
            <div className="space-y-1">
              {nonLlm.map((canonical) => (
                <div
                  key={canonical}
                  className="flex items-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2"
                >
                  <span className="flex-1 text-sm text-gray-500 truncate">{canonical}</span>
                  <button
                    onClick={() => addToLlm(canonical)}
                    className="rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onBack}
            className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <button
            onClick={() => onSave(llmOrder, nonLlm)}
            className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save Priorities &rarr;
          </button>
        </div>
      </div>
    </div>
  )
}
