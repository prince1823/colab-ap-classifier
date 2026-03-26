import { useState } from 'react'
import FileDropZone from '../../components/upload/FileDropZone'
import CSVPreviewTable from '../../components/upload/CSVPreviewTable'
import { ipc } from '../../lib/ipc'
import type { CSVPreview, DeriveMappingsSource, CompletedUpload, DerivedMappings } from '../../../shared/types/column-mapping'

interface Props {
  completedUploads: CompletedUpload[]
  onFileReady: (filePath: string, preview: CSVPreview, source: DeriveMappingsSource) => void
  onProceedToPriority: () => void
  derivingMappings: boolean
  derivedMappings: DerivedMappings | null
  preview: CSVPreview | null
  onConfirmMapping: () => void
  onCancelPreview: () => void
}

export default function DataUploadStep({
  completedUploads,
  onFileReady,
  onProceedToPriority,
  derivingMappings,
  derivedMappings,
  preview: parentPreview,
  onConfirmMapping,
  onCancelPreview,
}: Props) {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<CSVPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFileSelected = async (path: string) => {
    setFilePath(path)
    setLoading(true)
    setError(null)
    try {
      const parsed = await ipc.ingest.parseCSV(path)
      setPreview(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  const handleChooseSource = (source: DeriveMappingsSource) => {
    if (!filePath || !preview) return
    onFileReady(filePath, preview, source)
  }

  const hasUploads = completedUploads.length > 0
  const hasActiveFile = preview && !loading

  // Determine mapped and unmapped columns for the preview modal
  const showPreviewModal = derivedMappings !== null && !derivingMappings
  const csvColumns = parentPreview?.columns ?? preview?.columns ?? []
  const mappedRows = derivedMappings?.rows.filter((r) => r.csvColumn) ?? []
  const mappedCsvCols = new Set(mappedRows.map((r) => r.csvColumn))
  const unmappedColumns = csvColumns.filter((col) => !mappedCsvCols.has(col))

  // Full-area loading overlay when deriving mappings
  if (derivingMappings) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <svg className="mx-auto mb-4 h-10 w-10 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm font-medium text-gray-900">Generating column mappings...</p>
          <p className="mt-1 text-xs text-gray-500">This may take a few seconds</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Preview Mapping Modal */}
      {showPreviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50">
          <div className="relative w-full max-w-2xl max-h-[80vh] rounded-xl bg-white shadow-2xl flex flex-col">
            {/* Modal header */}
            <div className="flex-shrink-0 flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h3 className="text-lg font-semibold text-gray-900">Column Mapping Preview</h3>
              <button
                onClick={onCancelPreview}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

            {/* Modal body — scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
              {/* Mapped columns */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">
                  Mapped Columns
                  <span className="ml-1.5 text-xs font-normal text-gray-400">({mappedRows.length})</span>
                </h4>
                {mappedRows.length > 0 ? (
                  <div className="rounded-md border border-gray-200 overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Original CSV Column</th>
                          <th className="px-4 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500" />
                          <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Canonical Name</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {mappedRows.map((row) => (
                          <tr key={row.canonical}>
                            <td className="px-4 py-2 font-medium text-gray-900">{row.csvColumn}</td>
                            <td className="px-4 py-2 text-center text-gray-400">&rarr;</td>
                            <td className="px-4 py-2 text-gray-600">{row.canonical}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 italic">No columns were mapped.</p>
                )}
              </div>

              {/* Unmapped columns */}
              {unmappedColumns.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    Unmapped Columns
                    <span className="ml-1.5 text-xs font-normal text-gray-400">({unmappedColumns.length})</span>
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {unmappedColumns.map((col) => (
                      <span
                        key={col}
                        className="inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600"
                      >
                        {col}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex-shrink-0 flex items-center justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <button
                onClick={onCancelPreview}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={onConfirmMapping}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Use This Mapping
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV preview or file drop zone */}
      <div className="flex-shrink-0">
        {hasActiveFile && (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-900">
                {filePath!.split('/').pop()} &mdash; {preview.totalRows.toLocaleString()} rows detected
              </p>
              <button
                onClick={() => { setPreview(null); setFilePath(null) }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Choose Different File
              </button>
            </div>
            {error && (
              <div className="mb-2 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
            )}
            <CSVPreviewTable preview={preview} />
            <div className="flex justify-end mt-3">
              <button
                onClick={() => handleChooseSource('llm')}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-blue-600 hover:text-white hover:border-blue-600"
              >
                AI Suggested Column Mapping &rarr;
              </button>
            </div>
          </>
        )}
        {!preview && !loading && (
          <div>
            {hasUploads && (
              <h3 className="text-sm font-medium text-gray-700 mb-2">Add Another CSV</h3>
            )}
            <FileDropZone onFileSelected={handleFileSelected} />
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <svg className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm text-gray-600">Parsing CSV...</p>
            </div>
          </div>
        )}
      </div>

      {/* Upload history table — full width, fills remaining height, scrolls both axes */}
      {hasUploads && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-shrink-0 flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-700">Upload History</h3>
            <div className="flex items-center gap-3">
              {hasActiveFile && (
                <span className="text-xs text-gray-500">
                  Select a row to reuse its mapping
                </span>
              )}
              {!preview && !loading && (
                <button
                  onClick={onProceedToPriority}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Set Column Priorities &rarr;
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 min-h-0 rounded-md border border-gray-200 overflow-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">File</th>
                  <th className="whitespace-nowrap px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Rows</th>
                  <th className="whitespace-nowrap px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Columns</th>
                  <th className="whitespace-nowrap px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Uploaded At</th>
                  {hasActiveFile && (
                    <th className="whitespace-nowrap px-4 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">Mapping</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {completedUploads.map((upload) => (
                  <tr key={upload.uploadId} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-gray-900">
                      {upload.fileName}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right text-gray-600">
                      {upload.rowCount.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right text-gray-600">
                      {upload.mappings.filter((m) => m.csvColumn).length}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                      {upload.createdAt
                        ? new Date(upload.createdAt).toLocaleString(undefined, {
                            year: 'numeric', month: 'short', day: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })
                        : '—'}
                    </td>
                    {hasActiveFile && (
                      <td className="whitespace-nowrap px-4 py-2.5 text-center">
                        <button
                          onClick={() => handleChooseSource({ uploadId: upload.uploadId })}
                          className="rounded px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                        >
                          Preview Mapping
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
