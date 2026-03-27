import { useState } from 'react'
import { X } from 'lucide-react'
import FileDropZone from '../upload/FileDropZone'
import { ipc } from '../../lib/ipc'

interface Props {
  onClose: () => void
  onComplete: () => void
}

export default function SupplierImportModal({ onClose, onComplete }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [columns, setColumns] = useState<string[]>([])
  const [sampleRows, setSampleRows] = useState<Record<string, string>[]>([])
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null)

  const handleFileSelected = async (path: string) => {
    setError(null)
    setParsing(true)
    try {
      const preview = await ipc.suppliers.parseCSV(path)
      setFilePath(path)
      setColumns(preview.columns)
      setSampleRows(preview.sampleRows)
      // Auto-select if there's only one column
      if (preview.columns.length === 1) {
        setSelectedColumn(preview.columns[0])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse CSV')
    } finally {
      setParsing(false)
    }
  }

  const handleImport = async () => {
    if (!filePath || !selectedColumn) return
    setImporting(true)
    setError(null)
    try {
      const res = await ipc.suppliers.importCSV(filePath, selectedColumn)
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import suppliers')
    } finally {
      setImporting(false)
    }
  }

  const handleDone = () => {
    onComplete()
  }

  // Preview: show unique values from selected column
  const previewValues = selectedColumn
    ? [...new Set(sampleRows.map(r => r[selectedColumn]).filter(Boolean))].slice(0, 8)
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative flex flex-col bg-white rounded-xl shadow-xl w-[540px] max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {result ? 'Import Complete' : filePath ? 'Select Supplier Name Column' : 'Upload Supplier List'}
          </h2>
          <button
            onClick={onClose}
            disabled={importing}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            <X size={20} />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 flex-shrink-0">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-auto p-6">
          {/* Step 1: File selection */}
          {!filePath && !result && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              {parsing ? (
                <div className="flex flex-col items-center gap-3">
                  <svg className="h-10 w-10 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <p className="text-sm text-gray-600">Parsing CSV...</p>
                </div>
              ) : (
                <FileDropZone onFileSelected={handleFileSelected} />
              )}
            </div>
          )}

          {/* Step 2: Column selection */}
          {filePath && !result && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Which column contains the supplier names?
              </p>

              <div className="space-y-2">
                {columns.map(col => (
                  <label
                    key={col}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedColumn === col
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="supplierColumn"
                      value={col}
                      checked={selectedColumn === col}
                      onChange={() => setSelectedColumn(col)}
                      className="text-blue-600"
                    />
                    <span className="text-sm font-medium text-gray-900">{col}</span>
                    {/* Show sample value */}
                    {sampleRows[0]?.[col] && (
                      <span className="text-xs text-gray-400 ml-auto truncate max-w-[200px]">
                        e.g. "{sampleRows[0][col]}"
                      </span>
                    )}
                  </label>
                ))}
              </div>

              {/* Preview of selected column values */}
              {selectedColumn && previewValues.length > 0 && (
                <div className="mt-4 rounded-lg bg-gray-50 p-3">
                  <p className="text-xs font-medium text-gray-500 mb-2">
                    Sample values from "{selectedColumn}":
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {previewValues.map((val, i) => (
                      <span key={i} className="inline-block rounded bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-700">
                        {val}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Result */}
          {result && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-900">
                  {result.created} supplier{result.created !== 1 ? 's' : ''} added
                </p>
                {result.skipped > 0 && (
                  <p className="text-xs text-gray-500 mt-1">
                    {result.skipped} already existed and were skipped
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
          {!result ? (
            <>
              <button
                onClick={onClose}
                disabled={importing}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              {filePath && (
                <button
                  onClick={handleImport}
                  disabled={!selectedColumn || importing}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {importing && (
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  Import Suppliers
                </button>
              )}
            </>
          ) : (
            <button
              onClick={handleDone}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
