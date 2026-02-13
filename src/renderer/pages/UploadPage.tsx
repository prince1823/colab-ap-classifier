import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import FileDropZone from '../components/upload/FileDropZone'
import CSVPreviewTable from '../components/upload/CSVPreviewTable'
import ColumnMappingEditor from '../components/upload/ColumnMappingEditor'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { CSVPreviewWithMappings, CanonicalColumnMapping } from '../../shared/types/canonicalization'

export default function UploadPage() {
  const navigate = useNavigate()
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)
  const metadata = useWorkflowStore((s) => s.projectMetadata)

  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<CSVPreviewWithMappings | null>(null)
  const [mapping, setMapping] = useState<CanonicalColumnMapping>({})
  const [groupingColumns, setGroupingColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showUploader, setShowUploader] = useState(!hasUploadedData)

  // Refresh metadata on mount so hasUploadedData is current
  useEffect(() => {
    refreshMetadata()
  }, [refreshMetadata])

  const handleFileSelected = async (path: string) => {
    setFilePath(path)
    setLoading(true)
    setError(null)
    try {
      const result = await ipc.upload.parsePreview(path)
      setPreview(result)
      setMapping(result.mappingSuggestion.mappings)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  const handleImport = async () => {
    if (!filePath) return
    setImporting(true)
    setError(null)
    try {
      await ipc.canonicalization.save(mapping, groupingColumns)
      await ipc.upload.csv(filePath)
      await refreshMetadata()
      navigate('/workflow/data-review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import data')
    } finally {
      setImporting(false)
    }
  }

  // If data has been uploaded already, show a summary with option to re-upload
  if (hasUploadedData && !showUploader) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Upload CSV</h2>
          <p className="mt-1 text-sm text-gray-500">
            Data has been uploaded for this project.
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Data already imported</p>
              <p className="mt-1 text-sm text-gray-500">
                {metadata?.columnMappings
                  ? `${Object.keys(metadata.columnMappings).length} columns mapped`
                  : 'Column mappings configured'}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => navigate('/workflow/canonicalization')}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit Mappings
              </button>
              <button
                onClick={() => setShowUploader(true)}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Upload New File
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Upload CSV</h2>
        <p className="mt-1 text-sm text-gray-500">
          Select a CSV file to upload. Column mappings will be automatically suggested.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

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

      {preview && !loading && (
        <>
          <CSVPreviewTable preview={preview} />

          <ColumnMappingEditor
            suggestion={preview.mappingSuggestion}
            csvColumns={preview.columns}
            onMappingChange={setMapping}
            groupingColumns={groupingColumns}
            onGroupingChange={setGroupingColumns}
          />

          <div className="flex items-center justify-between border-t border-gray-200 pt-4">
            <button
              onClick={() => {
                setPreview(null)
                setFilePath(null)
              }}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Choose Different File
            </button>
            <button
              onClick={handleImport}
              disabled={importing}
              className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {importing ? 'Importing...' : 'Confirm & Import'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
