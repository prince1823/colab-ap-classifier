import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import FileDropZone from '../components/upload/FileDropZone'
import CSVPreviewTable from '../components/upload/CSVPreviewTable'
import ColumnMappingEditor from '../components/upload/ColumnMappingEditor'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import { useWorkflowStore } from '../stores/workflowStore'
import type { CSVPreviewWithMappings, ColumnMappingWithPriority } from '../../shared/types/column-mapping'
import { toSimpleMapping } from '../../shared/types/column-mapping'

const REQUIRED_COLS = ['supplier_name', 'spend_amount', 'invoice_date']

export default function UploadPage() {
  const navigate = useNavigate()
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  // Existing upload from the project (fetched on mount)
  const [existingUpload, setExistingUpload] = useState<{ id: string; fileName: string; rowCount: number } | null>(null)
  const [showUploader, setShowUploader] = useState(false)

  // Upload draft as local state — resets on navigation, which is fine
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<CSVPreviewWithMappings | null>(null)
  const [mapping, setMapping] = useState<ColumnMappingWithPriority>({})

  // Transient UI state
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showMappingEditor, setShowMappingEditor] = useState(false)

  // Check for existing upload on mount
  useEffect(() => {
    ipc.ingest.getUpload().then((upload) => {
      if (upload) {
        setExistingUpload({ id: upload.id, fileName: upload.fileName, rowCount: upload.rowCount })
        setShowUploader(false)
      } else {
        setShowUploader(true)
      }
    }).catch((e) => {
      showError('Failed to check existing upload', e)
      setShowUploader(true)
    })
  }, [])

  const handleFileSelected = async (path: string) => {
    setFilePath(path)
    setLoading(true)
    setError(null)
    setShowMappingEditor(false)
    try {
      const parsed = await ipc.ingest.parseCSV(path)
      const mappingSuggestion = await ipc.ingest.suggestMappings(parsed.columns, parsed.sampleRows)
      setPreview({ ...parsed, mappingSuggestion })
      // mapping state populated by ColumnMappingEditor via onMappingChange
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
      await ipc.ingest.importCSV(filePath, toSimpleMapping(mapping))
      // Derive and save column_priorities so classification can run
      const required = REQUIRED_COLS.filter((col) => mapping[col]?.csvColumn)
      const optional = Object.entries(mapping)
        .filter(([name, e]) => !REQUIRED_COLS.includes(name) && e.classificationPriority && e.classificationPriority > 0)
        .sort(([, a], [, b]) => (a.classificationPriority ?? 99) - (b.classificationPriority ?? 99))
        .map(([name]) => name)
      await ipc.project.setSetting('column_priorities', [...required, ...optional])
      await refreshMetadata()
      navigate('/workflow/data-review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import CSV')
    } finally {
      setImporting(false)
    }
  }

  // If data has been uploaded already, show a summary with option to re-upload
  if (existingUpload && !showUploader) {
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
              <p className="text-sm font-medium text-gray-900">{existingUpload.fileName}</p>
              <p className="mt-1 text-sm text-gray-500">
                {existingUpload.rowCount.toLocaleString()} rows imported
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => navigate('/workflow/data-review')}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                View Data
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

  // While checking for existing upload, show nothing (brief flicker prevention)
  if (!showUploader) {
    return null
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Upload CSV</h2>
        <p className="mt-1 text-sm text-gray-500">
          {showMappingEditor
            ? 'Review and adjust column mappings, then import.'
            : 'Select a CSV file to upload and preview the data.'}
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

      {/* Step 1: CSV preview — show before mapping editor */}
      {preview && !loading && !showMappingEditor && (
        <>
          <CSVPreviewTable preview={preview} />

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
              onClick={() => setShowMappingEditor(true)}
              className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Next: Configure Mappings →
            </button>
          </div>
        </>
      )}

      {/* Step 2: Column mapping editor + import */}
      {preview && !loading && showMappingEditor && (
        <>
          <ColumnMappingEditor
            suggestion={preview.mappingSuggestion}
            csvColumns={preview.columns}
            onMappingChange={setMapping}
          />

          <div className="flex items-center justify-between border-t border-gray-200 pt-4">
            <button
              onClick={() => setShowMappingEditor(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              ← Back to Preview
            </button>
            <button
              onClick={handleImport}
              disabled={importing}
              className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
            >
              {importing ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Importing...
                </>
              ) : (
                'Import Data →'
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
