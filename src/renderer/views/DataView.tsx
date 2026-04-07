import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { clsx } from 'clsx'
import DataUploadStep from './data-steps/DataUploadStep'
import DataMappingStep, { type ColumnState } from './data-steps/DataMappingStep'
import DataPriorityStep from './data-steps/DataPriorityStep'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import { useWorkflowStore } from '../stores/workflowStore'
import { REQUIRED_CANONICAL_COLUMNS } from '../../shared/canonical-columns'
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns'
import type {
  CSVPreview,
  ColumnMapping,
  MappingRow,
  DerivedMappings,
  DeriveMappingsSource,
  CompletedUpload,
} from '../../shared/types/column-mapping'
import type { IngestProgress } from '../../shared/types/classification'

type Step = 'upload' | 'mapping' | 'priority'

const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload CSV' },
  { key: 'mapping', label: 'Review Column Mapping' },
  { key: 'priority', label: 'Column Priority' },
]

export default function DataView() {
  const navigate = useNavigate()
  const location = useLocation()
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)
  const refreshGateState = useWorkflowStore((s) => s.refreshGateState)
  const projectFilePath = useWorkflowStore((s) => s.projectFilePath)

  const [step, setStep] = useState<Step>('upload')
  const [completedUploads, setCompletedUploads] = useState<CompletedUpload[]>([])
  const [error, setError] = useState<string | null>(null)
  const [uploadStats, setUploadStats] = useState<Record<string, { classifiedCount: number; humanReviewedCount: number }>>({})

  // Active upload/mapping cycle state
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [activePreview, setActivePreview] = useState<CSVPreview | null>(null)
  const [activeDerivedMappings, setActiveDerivedMappings] = useState<DerivedMappings | null>(null)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<IngestProgress | null>(null)
  const [derivingMappings, setDerivingMappings] = useState(false)
  const [mappingFromPrevious, setMappingFromPrevious] = useState(false)
  // Preserved column states so going back from priority doesn't lose edits
  const [preservedColumnStates, setPreservedColumnStates] = useState<ColumnState[] | null>(null)
  // Track upload created in the current mapping cycle so we can delete it if user goes back
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null)

  // Load existing uploads and stats on mount and when project changes
  useEffect(() => {
    // Reset local state when project switches
    setCompletedUploads([])
    setUploadStats({})
    setActiveFilePath(null)
    setActivePreview(null)
    setActiveDerivedMappings(null)
    setPreservedColumnStates(null)
    setActiveUploadId(null)
    setStep('upload')
    setError(null)

    if (!projectFilePath) return

    ipc.ingest.getUploadHistory().then((uploads) => {
      setCompletedUploads(
        uploads.map((u) => ({
          uploadId: u.id,
          fileName: u.fileName,
          rowCount: u.rowCount,
          mappings: Object.entries(u.columnMappings).map(([canonical, csvColumn]) => ({
            canonical,
            csvColumn,
          })),
          createdAt: u.createdAt,
        }))
      )
    }).catch((e) => {
      showError('Failed to load upload history', e)
    })
  }, [projectFilePath])

  // Refresh upload stats whenever the user navigates back to /data.
  // DataView is keep-alive (never unmounts), so the mount effect above only
  // runs once per project. Without this, classifiedCount goes stale after
  // the user classifies rows on another page, causing the delete dialog to
  // skip the force flag and the backend to reject the deletion.
  useEffect(() => {
    if (location.pathname !== '/data' || !projectFilePath) return
    ipc.ingest.getUploadStatsBatch().then(setUploadStats).catch((e) => {
      showError('Failed to load upload stats', e)
    })
  }, [location.pathname, projectFilePath])

  // Listen for import progress events from the backend
  useEffect(() => {
    const unsubscribe = ipc.ingest.onProgress((progress: IngestProgress) => {
      setImportProgress(progress)
    })
    return unsubscribe
  }, [])

  const handleDeleteUpload = async (uploadId: string, force?: boolean) => {
    try {
      await ipc.ingest.deleteUpload(uploadId, force)
      setCompletedUploads((prev) => prev.filter((u) => u.uploadId !== uploadId))
      setUploadStats((prev) => {
        const next = { ...prev }
        delete next[uploadId]
        return next
      })
      await refreshGateState()
    } catch (e) {
      showError('Failed to delete upload', e)
      throw e
    }
  }

  const handleFileReady = async (
    path: string,
    preview: CSVPreview,
    source: DeriveMappingsSource
  ) => {
    setActiveFilePath(path)
    setActivePreview(preview)
    setError(null)
    setDerivingMappings(true)
    setMappingFromPrevious(source !== 'llm')
    try {
      const derived = await ipc.ingest.deriveMappings(
        preview.columns,
        preview.sampleRows,
        source
      )
      setActiveDerivedMappings(derived)
      // LLM source: go directly to mapping step; previous upload: stay and show preview modal
      if (source === 'llm') {
        setStep('mapping')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to derive mappings')
    } finally {
      setDerivingMappings(false)
    }
  }

  // Called from DataMappingStep when user clicks "Import & Continue"
  const handleImport = async (rows: MappingRow[], columnStates?: ColumnState[]) => {
    if (!activeFilePath) return
    if (columnStates) setPreservedColumnStates(columnStates)
    setImporting(true)
    setError(null)
    setImportProgress(null)
    try {
      // If the user went back from priority and is re-importing, delete the previous upload first
      if (activeUploadId) {
        await ipc.ingest.deleteUpload(activeUploadId, true)
        setCompletedUploads((prev) => prev.filter((u) => u.uploadId !== activeUploadId))
        setUploadStats((prev) => { const next = { ...prev }; delete next[activeUploadId]; return next })
        setActiveUploadId(null)
      }
      // Build simple ColumnMapping from mapping rows (skip empty canonicals)
      const columnMapping: ColumnMapping = {}
      for (const row of rows) {
        if (row.csvColumn && row.canonical) {
          columnMapping[row.canonical] = row.csvColumn
        }
      }

      // Validate required canonicals before calling backend
      const missingRequired = REQUIRED_CANONICAL_COLUMNS.filter((r) => !columnMapping[r])
      if (missingRequired.length > 0) {
        const names = missingRequired.map((n) => `"${n}"`).join(', ')
        throw new Error(
          `Missing required column${missingRequired.length > 1 ? 's' : ''}: ${names}. Please assign a CSV column to ${missingRequired.length > 1 ? 'each' : 'it'} before importing.`
        )
      }

      const result = await ipc.ingest.importCSV(activeFilePath, columnMapping)

      // Merge new mapped columns into column_priorities (preserving existing order).
      // Virtual columns are excluded — they have no physical presence on transaction rows
      // and must never appear in column_priorities (see VIRTUAL_COLUMN_NAMES).
      const existingPriorities = await ipc.project.getSetting('column_priorities') as string[] | null
      const mappedCols = rows
        .filter((r) => r.csvColumn)
        .map((r) => r.canonical)
        .filter((c) => !VIRTUAL_COLUMN_NAMES.has(c))
      if (!existingPriorities || existingPriorities.length === 0) {
        await ipc.project.setSetting('column_priorities', mappedCols)
      } else {
        const existingSet = new Set(existingPriorities)
        const newCols = mappedCols.filter((c) => !existingSet.has(c))
        if (newCols.length > 0) {
          await ipc.project.setSetting('column_priorities', [...existingPriorities, ...newCols])
        }
      }

      // Add to completed uploads
      setCompletedUploads((prev) => [
        ...prev,
        {
          uploadId: result.uploadId,
          fileName: activeFilePath.split('/').pop() ?? activeFilePath,
          rowCount: result.rowsInserted,
          mappings: rows,
          createdAt: new Date().toISOString(),
        },
      ])
      // New imports have no classified rows yet — seed stats so the delete button shows
      setUploadStats((prev) => ({ ...prev, [result.uploadId]: { classifiedCount: 0, humanReviewedCount: 0 } }))
      // Track so we can delete if user goes back and re-imports
      setActiveUploadId(result.uploadId)

      await refreshGateState()

      // Move to priority — keep preview/mappings so Back can return to mapping step
      setStep('priority')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import CSV')
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  const handleSavePriorities = async (llmOrder: string[], _nonLlm: string[]) => {
    setError(null)
    try {
      // Filter virtual columns at write time — they must never appear in column_priorities
      const filtered = llmOrder.filter((c) => !VIRTUAL_COLUMN_NAMES.has(c))
      await ipc.project.setSetting('column_priorities', filtered)
      // Save separately so Priority step knows this is user-curated (not auto-default)
      await ipc.project.setSetting('column_priorities_saved', llmOrder)
      await refreshMetadata()
      await refreshGateState()

      // Clear active cycle state and return to upload for additional files
      setActiveFilePath(null)
      setActivePreview(null)
      setActiveDerivedMappings(null)
      setPreservedColumnStates(null)
      setActiveUploadId(null)
      setStep('upload')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save priorities')
    }
  }

  // Union of all mappings from completed uploads for priority step
  const allMappings: MappingRow[] = (() => {
    const seen = new Set<string>()
    const result: MappingRow[] = []
    for (const upload of completedUploads) {
      for (const m of upload.mappings) {
        if (!seen.has(m.canonical)) {
          seen.add(m.canonical)
          result.push(m)
        }
      }
    }
    return result
  })()

  const stepIndex = STEPS.findIndex((s) => s.key === step)

  return (
    <div className="flex flex-col h-full p-6">
      {/* Step indicator */}
      <div className="flex-shrink-0 mb-6">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-900">Data</h2>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              {i > 0 && <div className="h-px w-8 bg-gray-300" />}
              <div
                className={clsx(
                  'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium',
                  i === stepIndex && 'bg-blue-100 text-blue-700',
                  i < stepIndex && 'bg-green-100 text-green-700',
                  i > stepIndex && 'bg-gray-100 text-gray-400'
                )}
              >
                <span
                  className={clsx(
                    'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                    i === stepIndex && 'bg-blue-600 text-white',
                    i < stepIndex && 'bg-green-600 text-white',
                    i > stepIndex && 'bg-gray-300 text-white'
                  )}
                >
                  {i < stepIndex ? '\u2713' : i + 1}
                </span>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex-shrink-0 mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Step content */}
      <div className="flex-1 min-h-0">
        {step === 'upload' && (
          <DataUploadStep
            completedUploads={completedUploads}
            uploadStats={uploadStats}
            onFileReady={handleFileReady}
            onDeleteUpload={handleDeleteUpload}
            onProceedToPriority={() => setStep('priority')}
            derivingMappings={derivingMappings}
            derivedMappings={activeDerivedMappings}
            preview={activePreview}
            onConfirmMapping={() => setStep('mapping')}
            onCancelPreview={() => { setActiveDerivedMappings(null) }}
          />
        )}
        {step === 'mapping' && activePreview && activeDerivedMappings && (
          <DataMappingStep
            preview={activePreview}
            derivedMappings={activeDerivedMappings}
            onApply={handleImport}
            onBack={async () => {
              if (activeUploadId) {
                await ipc.ingest.deleteUpload(activeUploadId, true).catch(() => {})
                setCompletedUploads((prev) => prev.filter((u) => u.uploadId !== activeUploadId))
                setUploadStats((prev) => { const next = { ...prev }; delete next[activeUploadId]; return next })
                setActiveUploadId(null)
              }
              setActiveDerivedMappings(null)
              setStep('upload')
            }}
            fromPreviousMapping={mappingFromPrevious}
            preservedColumnStates={preservedColumnStates}
            importing={importing}
            importProgress={importProgress}
            isFirstUpload={completedUploads.length === 0}
          />
        )}
        {step === 'priority' && (
          <DataPriorityStep
            allMappings={allMappings}
            onSave={handleSavePriorities}
            onBack={() => setStep(activePreview && activeDerivedMappings ? 'mapping' : 'upload')}
          />
        )}
      </div>
    </div>
  )
}
