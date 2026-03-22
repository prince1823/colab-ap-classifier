import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import DataUploadStep from './data-steps/DataUploadStep'
import DataMappingStep, { type ColumnState } from './data-steps/DataMappingStep'
import DataPriorityStep from './data-steps/DataPriorityStep'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type {
  CSVPreview,
  ColumnMapping,
  MappingRow,
  DerivedMappings,
  DeriveMappingsSource,
  CompletedUpload,
} from '../../shared/types/column-mapping'

type Step = 'upload' | 'mapping' | 'priority'

const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload CSV' },
  { key: 'mapping', label: 'Column Mapping' },
  { key: 'priority', label: 'Column Priority' },
]

export default function DataView() {
  const navigate = useNavigate()
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)
  const refreshGateState = useWorkflowStore((s) => s.refreshGateState)

  const [step, setStep] = useState<Step>('upload')
  const [completedUploads, setCompletedUploads] = useState<CompletedUpload[]>([])
  const [error, setError] = useState<string | null>(null)

  // Active upload/mapping cycle state
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [activePreview, setActivePreview] = useState<CSVPreview | null>(null)
  const [activeDerivedMappings, setActiveDerivedMappings] = useState<DerivedMappings | null>(null)
  const [importing, setImporting] = useState(false)
  const [derivingMappings, setDerivingMappings] = useState(false)
  const [mappingFromPrevious, setMappingFromPrevious] = useState(false)
  // Preserved column states so going back from priority doesn't lose edits
  const [preservedColumnStates, setPreservedColumnStates] = useState<ColumnState[] | null>(null)

  // Load existing uploads on mount
  useEffect(() => {
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
        }))
      )
    }).catch(() => {
      // No uploads yet — that's fine
    })
  }, [])

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
      setStep('mapping')
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
    try {
      // Build simple ColumnMapping from mapping rows
      const columnMapping: ColumnMapping = {}
      for (const row of rows) {
        if (row.csvColumn) {
          columnMapping[row.canonical] = row.csvColumn
        }
      }

      const result = await ipc.ingest.importCSV(activeFilePath, columnMapping)

      // Only set default column_priorities if none exist yet
      const existingPriorities = await ipc.project.getSetting('column_priorities') as string[] | null
      if (!existingPriorities || existingPriorities.length === 0) {
        const mappedCols = rows.filter((r) => r.csvColumn).map((r) => r.canonical)
        const supplierFirst = mappedCols.filter((c) => c === 'supplier_name')
        const rest = mappedCols.filter((c) => c !== 'supplier_name')
        await ipc.project.setSetting('column_priorities', [...supplierFirst, ...rest])
      }

      // Add to completed uploads
      setCompletedUploads((prev) => [
        ...prev,
        {
          uploadId: result.uploadId,
          fileName: activeFilePath.split('/').pop() ?? activeFilePath,
          rowCount: result.rowsInserted,
          mappings: rows,
        },
      ])

      await refreshGateState()

      // Clear active cycle state and move to priority
      setActiveFilePath(null)
      setActivePreview(null)
      setActiveDerivedMappings(null)
      setPreservedColumnStates(null)
      setStep('priority')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import CSV')
    } finally {
      setImporting(false)
    }
  }

  const handleSavePriorities = async (llmOrder: string[], _nonLlm: string[]) => {
    setError(null)
    try {
      await ipc.project.setSetting('column_priorities', llmOrder)
      // Save separately so Priority step knows this is user-curated (not auto-default)
      await ipc.project.setSetting('column_priorities_saved', llmOrder)
      await refreshMetadata()
      await refreshGateState()
      navigate('/suppliers')
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
            onFileReady={handleFileReady}
            onProceedToPriority={() => setStep('priority')}
            derivingMappings={derivingMappings}
          />
        )}
        {step === 'mapping' && activePreview && activeDerivedMappings && (
          <DataMappingStep
            preview={activePreview}
            derivedMappings={activeDerivedMappings}
            onApply={handleImport}
            onBack={() => setStep('upload')}
            fromPreviousMapping={mappingFromPrevious}
            preservedColumnStates={preservedColumnStates}
            importing={importing}
            isFirstUpload={completedUploads.length === 0}
          />
        )}
        {step === 'priority' && (
          <DataPriorityStep
            allMappings={allMappings}
            onSave={handleSavePriorities}
            onBack={() => setStep('upload')}
          />
        )}
      </div>
    </div>
  )
}
