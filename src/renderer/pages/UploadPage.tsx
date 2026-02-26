import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import FileDropZone from '../components/upload/FileDropZone'
import CSVPreviewTable from '../components/upload/CSVPreviewTable'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'

export default function UploadPage() {
  const navigate = useNavigate()
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)
  const metadata = useWorkflowStore((s) => s.projectMetadata)

  // Upload draft from global store — survives tab navigation
  const uploadDraft = useWorkflowStore((s) => s.uploadDraft)
  const setUploadDraft = useWorkflowStore((s) => s.setUploadDraft)

  // Local-only transient state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refresh metadata on mount so hasUploadedData is current
  useEffect(() => {
    refreshMetadata()
  }, [refreshMetadata])

  // Sync showUploader when project changes (e.g. opening an existing project with data)
  useEffect(() => {
    if (hasUploadedData) {
      setUploadDraft({ showUploader: false })
    }
  }, [hasUploadedData])

  const handleFileSelected = async (path: string) => {
    setUploadDraft({ filePath: path })
    setLoading(true)
    setError(null)
    try {
      const result = await ipc.upload.parsePreview(path)
      setUploadDraft({ preview: result, mapping: result.mappingSuggestion.mappings })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  // If data has been uploaded already, show a summary with option to re-upload
  if (hasUploadedData && !uploadDraft.showUploader) {
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
                {metadata?.columnMapping
                  ? `${Object.keys(metadata.columnMapping).length} columns mapped`
                  : 'Column mappings configured'}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => navigate('/workflow/data-review')}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit Mappings
              </button>
              <button
                onClick={() => setUploadDraft({ showUploader: true })}
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
          Select a CSV file to upload and preview the data.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {!uploadDraft.preview && !loading && <FileDropZone onFileSelected={handleFileSelected} />}

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

      {uploadDraft.preview && !loading && (
        <>
          <CSVPreviewTable preview={uploadDraft.preview} />

          <div className="flex items-center justify-between border-t border-gray-200 pt-4">
            <button
              onClick={() => {
                setUploadDraft({ preview: null, filePath: null })
              }}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Choose Different File
            </button>
            <button
              onClick={() => navigate('/workflow/data-review')}
              className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Next: Configure Mappings →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
