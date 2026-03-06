import { useState, useEffect } from 'react'
import FileDropZone from '../../components/upload/FileDropZone'
import CSVPreviewTable from '../../components/upload/CSVPreviewTable'
import { ipc } from '../../lib/ipc'
import type { CSVPreviewWithMappings } from '../../../shared/types/column-mapping'

interface Props {
  onFileReady: (filePath: string, preview: CSVPreviewWithMappings) => void
}

export default function DataUploadStep({ onFileReady }: Props) {
  const [existingUpload, setExistingUpload] = useState<{ id: string; fileName: string; rowCount: number } | null>(null)
  const [showUploader, setShowUploader] = useState(false)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<CSVPreviewWithMappings | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ipc.ingest.getUpload().then((upload) => {
      if (upload) {
        setExistingUpload({ id: upload.id, fileName: upload.fileName, rowCount: upload.rowCount })
        setShowUploader(false)
      } else {
        setShowUploader(true)
      }
    }).catch(() => {
      setShowUploader(true)
    })
  }, [])

  const handleFileSelected = async (path: string) => {
    setFilePath(path)
    setLoading(true)
    setError(null)
    try {
      const parsed = await ipc.ingest.parseCSV(path)
      const mappingSuggestion = await ipc.ingest.suggestMappings(parsed.columns, parsed.sampleRows)
      const previewWithMappings: CSVPreviewWithMappings = { ...parsed, mappingSuggestion }
      setPreview(previewWithMappings)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  // Existing upload summary
  if (existingUpload && !showUploader) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">{existingUpload.fileName}</p>
              <p className="mt-1 text-sm text-gray-500">
                {existingUpload.rowCount.toLocaleString()} rows imported
              </p>
            </div>
            <button
              onClick={() => setShowUploader(true)}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Upload New File
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!showUploader) return null

  return (
    <div className="flex gap-6 h-full">
      {/* Left: CSV preview */}
      <div className="flex-1 min-w-0">
        {preview && !loading && <CSVPreviewTable preview={preview} />}
        {!preview && !loading && <FileDropZone onFileSelected={handleFileSelected} />}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <svg className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm text-gray-600">Analyzing CSV and suggesting column mappings...</p>
            </div>
          </div>
        )}
      </div>

      {/* Right: action area (only after preview is ready) */}
      {preview && !loading && filePath && (
        <div className="w-72 flex-shrink-0 space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-sm font-medium text-gray-900">
              {filePath.split('/').pop()}
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {preview.totalRows.toLocaleString()} rows detected
            </p>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}

          <button
            onClick={() => onFileReady(filePath, preview)}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Map Columns &rarr;
          </button>

          <button
            onClick={() => { setPreview(null); setFilePath(null) }}
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Choose Different File
          </button>
        </div>
      )}
    </div>
  )
}
