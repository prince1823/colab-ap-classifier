import { useState, useEffect, useCallback, useRef } from 'react'
import { GripVertical, X, Plus, ChevronDown } from 'lucide-react'
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

  const [llmOrder, setLlmOrder] = useState<string[]>(() =>
    allCanonicals.filter((c) => c === 'supplier_name')
  )
  const [nonLlm, setNonLlm] = useState<string[]>(() =>
    allCanonicals.filter((c) => c !== 'supplier_name')
  )

  // Transaction preview
  const [previewColumns, setPreviewColumns] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<TransactionPreviewRow[]>([])
  const [totalRows, setTotalRows] = useState(0)

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

  // Add-column dropdown state
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!addMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [addMenuOpen])

  return (
    <div className="flex flex-col gap-5 h-full">
      {/* ── LLM Columns ─ compact chips ───────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-gray-700">Columns sent to LLM</h3>
            <span className="text-[10px] text-gray-400">Drag to reorder priority</span>
          </div>
          {/* Add column dropdown */}
          {nonLlm.length > 0 && (
            <div className="relative" ref={addMenuRef}>
              <button
                onClick={() => setAddMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <Plus size={10} />
                Add column
                <span className="text-gray-400">({nonLlm.length})</span>
                <ChevronDown size={10} className={`text-gray-400 transition-transform ${addMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {addMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 w-56 max-h-48 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                  {nonLlm.map((canonical) => (
                    <button
                      key={canonical}
                      onClick={() => addToLlm(canonical)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-blue-50 hover:text-blue-700 text-left"
                    >
                      <Plus size={10} className="flex-shrink-0 text-gray-400" />
                      {canonical}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {llmOrder.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {llmOrder.map((canonical, index) => (
              <div
                key={canonical}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
                className={`inline-flex items-center gap-1.5 rounded-md border bg-white pl-1 pr-1.5 py-1 text-xs cursor-grab active:cursor-grabbing transition-all ${
                  dragIndex === index ? 'opacity-40 border-blue-300' : 'border-gray-200'
                } ${dragOverIndex === index && dragIndex !== index ? 'border-l-2 border-l-blue-500' : ''}`}
              >
                <GripVertical size={10} className="text-gray-300 flex-shrink-0" />
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[9px] font-bold text-blue-700 flex-shrink-0">
                  {index + 1}
                </span>
                <span className="text-gray-700 font-medium">{canonical}</span>
                <button
                  onClick={() => removeFromLlm(canonical)}
                  className="rounded p-0.5 text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
                  title="Remove from LLM"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400 italic py-2 px-1">No columns selected for LLM.</p>
        )}
      </div>

      {/* ── Transaction preview ────────────────────────────────── */}
      {previewRows.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-sm font-medium text-gray-700">Transaction Preview</h3>
            {totalRows > 0 && (
              <span className="text-[10px] text-gray-400">
                {Math.min(previewRows.length, 10)} of {totalRows.toLocaleString()} rows
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr>
                  <th className="whitespace-nowrap px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-gray-400">#</th>
                  {previewColumns.map((col) => (
                    <th key={col} className="whitespace-nowrap px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {previewRows.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-1.5 text-[10px] text-gray-400">{i + 1}</td>
                    {previewColumns.map((col) => (
                      <td key={col} className="max-w-xs truncate whitespace-nowrap px-3 py-1.5 text-gray-700">{String(row[col] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Action buttons ─────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between border-t border-gray-200 pt-3">
        <button
          onClick={onBack}
          className="rounded-md border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          &larr; Back
        </button>
        <button
          onClick={() => onSave(llmOrder, nonLlm)}
          className="rounded-md bg-blue-600 px-6 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save Priorities &rarr;
        </button>
      </div>
    </div>
  )
}
