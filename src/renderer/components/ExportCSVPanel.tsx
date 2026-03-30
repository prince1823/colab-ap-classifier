import { useState, useEffect, useCallback, useRef } from 'react'
import { ipc } from '../lib/ipc'
import { Download, GripVertical } from 'lucide-react'

interface ColumnItem {
  name: string
  included: boolean
}

export default function ExportCSVPanel() {
  const [columns, setColumns] = useState<ColumnItem[]>([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<{ rowsExported: number } | null>(null)

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragCounter = useRef(0)

  // Load available columns
  useEffect(() => {
    ipc.export.columns()
      .then(cols => {
        setColumns((cols as string[]).map(name => ({ name, included: true })))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const toggleColumn = useCallback((index: number) => {
    setColumns(prev => prev.map((c, i) => i === index ? { ...c, included: !c.included } : c))
  }, [])

  const toggleAll = useCallback((included: boolean) => {
    setColumns(prev => prev.map(c => ({ ...c, included })))
  }, [])

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    // Make the drag image semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    setDragIndex(null)
    setDragOverIndex(null)
    dragCounter.current = 0
  }, [])

  const handleDragEnter = useCallback((index: number) => {
    dragCounter.current++
    setDragOverIndex(index)
  }, [])

  const handleDragLeave = useCallback(() => {
    dragCounter.current--
    if (dragCounter.current <= 0) {
      setDragOverIndex(null)
      dragCounter.current = 0
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault()
    const fromIndex = dragIndex
    if (fromIndex === null || fromIndex === dropIndex) return

    setColumns(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(dropIndex, 0, moved)
      return next
    })

    setDragIndex(null)
    setDragOverIndex(null)
    dragCounter.current = 0
  }, [dragIndex])

  // Export
  const handleExport = useCallback(async () => {
    const selected = columns.filter(c => c.included).map(c => c.name)
    if (selected.length === 0) return
    setExporting(true)
    setExportResult(null)
    try {
      const result = await ipc.export.csv(undefined, selected)
      if (result) setExportResult(result as { rowsExported: number })
    } catch {
      // export dialog cancelled or error
    } finally {
      setExporting(false)
    }
  }, [columns])

  const includedCount = columns.filter(c => c.included).length
  const allIncluded = includedCount === columns.length
  const noneIncluded = includedCount === 0

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Export CSV Data</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Select and reorder columns for export. Drag to reorder.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || noneIncluded || loading}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={12} />
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
        {exportResult && (
          <div className="mt-2 rounded-md bg-green-50 px-3 py-1.5 text-xs text-green-700">
            Exported {exportResult.rowsExported.toLocaleString()} rows successfully.
          </div>
        )}
      </div>

      {/* Toggle all bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-50 bg-gray-50/50">
        <span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">
          {includedCount}/{columns.length} columns included
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggleAll(true)}
            disabled={allIncluded}
            className="text-[10px] font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-300 disabled:cursor-not-allowed"
          >
            Include all
          </button>
          <span className="text-gray-200">|</span>
          <button
            type="button"
            onClick={() => toggleAll(false)}
            disabled={noneIncluded}
            className="text-[10px] font-medium text-red-500 hover:text-red-600 disabled:text-gray-300 disabled:cursor-not-allowed"
          >
            Exclude all
          </button>
        </div>
      </div>

      {/* Column list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
          </div>
        ) : (
          <div>
            {columns.map((col, index) => (
              <div
                key={col.name}
                draggable
                onDragStart={e => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragEnter={() => handleDragEnter(index)}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={e => handleDrop(e, index)}
                className={`
                  flex items-center gap-2 px-4 py-1.5 border-b border-gray-50 cursor-grab active:cursor-grabbing select-none transition-colors
                  ${dragOverIndex === index && dragIndex !== index ? 'bg-blue-50 border-blue-200' : ''}
                  ${dragIndex === index ? 'opacity-50' : ''}
                  ${!col.included ? 'opacity-50' : ''}
                `}
              >
                {/* Drag handle */}
                <GripVertical size={12} className="text-gray-300 flex-shrink-0" />

                {/* Column name */}
                <span className={`flex-1 text-xs font-medium truncate ${col.included ? 'text-gray-800' : 'text-gray-400 line-through'}`}>
                  {col.name}
                </span>

                {/* Include/exclude toggle */}
                <button
                  type="button"
                  onClick={() => toggleColumn(index)}
                  className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[8px] font-medium transition-colors ${
                    col.included
                      ? 'bg-green-100 text-green-700 border border-green-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200'
                      : 'bg-gray-200 text-gray-500 border border-transparent hover:bg-green-50 hover:text-green-700 hover:border-green-200'
                  }`}
                  title={col.included ? 'Click to exclude' : 'Click to include'}
                >
                  {col.included ? 'Incl' : 'Excl'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
