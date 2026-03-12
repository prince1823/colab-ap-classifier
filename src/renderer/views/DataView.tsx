import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import FileDropZone from '../components/upload/FileDropZone'
import ColumnMappingEditor from '../components/upload/ColumnMappingEditor'
import DataPriorityStep from './data-steps/DataPriorityStep'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type {
  CSVPreview,
  ColumnMapping,
  ColumnMappingWithPriority,
  MappingRow,
  DerivedMappings,
  CompletedUpload,
  ConfidenceLevel,
} from '../../shared/types/column-mapping'
import { toSimpleMapping } from '../../shared/types/column-mapping'
import { REQUIRED_CANONICAL_COLUMNS } from '../../shared/canonical-columns'

type Step = 'upload' | 'priority'

const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload & Map' },
  { key: 'priority', label: 'Column Priority' },
]

const REQUIRED_COLS = REQUIRED_CANONICAL_COLUMNS as readonly string[]

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
  const [activeConfidence, setActiveConfidence] = useState<ConfidenceLevel | undefined>()
  const [activeReasoning, setActiveReasoning] = useState<string | undefined>()
  const [importing, setImporting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [derivingMappings, setDerivingMappings] = useState(false)

  // Current mapping from the DnD editor
  const mappingRef = useRef<ColumnMappingWithPriority>({})

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

  // ── File selected → parse CSV → derive mappings ─────────────────
  const handleFileSelected = async (path: string) => {
    setActiveFilePath(path)
    setLoading(true)
    setError(null)
    try {
      const preview = await ipc.ingest.parseCSV(path)
      setActivePreview(preview)

      // Automatically derive mappings via LLM
      setDerivingMappings(true)
      try {
        const derived = await ipc.ingest.deriveMappings(
          preview.columns,
          preview.sampleRows,
          'llm'
        )
        setActiveDerivedMappings(derived)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to derive mappings')
      } finally {
        setDerivingMappings(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  // ── Mapping changed from DnD editor ─────────────────────────────
  const handleMappingChange = (mapping: ColumnMappingWithPriority) => {
    mappingRef.current = mapping
  }

  // ── Import with current mappings ────────────────────────────────
  const handleImport = async () => {
    if (!activeFilePath) return
    setImporting(true)
    setError(null)
    try {
      const mapping = mappingRef.current
      const simpleMapping = toSimpleMapping(mapping)

      const result = await ipc.ingest.importCSV(activeFilePath, simpleMapping)

      // Save column_priorities from the mapping
      const required = REQUIRED_COLS.filter((col) => mapping[col]?.csvColumn)
      const optional = Object.entries(mapping)
        .filter(([name, e]) => !REQUIRED_COLS.includes(name) && e.classificationPriority && e.classificationPriority > 0)
        .sort(([, a], [, b]) => (a.classificationPriority ?? 99) - (b.classificationPriority ?? 99))
        .map(([name]) => name)
      await ipc.project.setSetting('column_priorities', [...required, ...optional])

      // Build MappingRow[] for completed upload
      const mappingRows: MappingRow[] = Object.entries(simpleMapping).map(([canonical, csvColumn]) => ({
        canonical,
        csvColumn,
      }))

      // Add to completed uploads
      setCompletedUploads((prev) => [
        ...prev,
        {
          uploadId: result.uploadId,
          fileName: activeFilePath.split('/').pop() ?? activeFilePath,
          rowCount: result.rowsInserted,
          mappings: mappingRows,
        },
      ])

      // Clear active state
      setActiveFilePath(null)
      setActivePreview(null)
      setActiveDerivedMappings(null)
      setActiveConfidence(undefined)
      setActiveReasoning(undefined)

      await refreshGateState()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import CSV')
    } finally {
      setImporting(false)
    }
  }

  // ── Priority step handlers ──────────────────────────────────────
  const handleSavePriorities = async (llmOrder: string[], _nonLlm: string[]) => {
    setError(null)
    try {
      await ipc.project.setSetting('column_priorities', llmOrder)
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
  const hasUploads = completedUploads.length > 0
  const hasActiveFile = activePreview && activeDerivedMappings && !loading && !derivingMappings

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
      <div className="flex-1 min-h-0 overflow-auto">
        {step === 'upload' && (
          <div className="space-y-6">
            {/* ── Upload history (completed uploads) ──────────────── */}
            {hasUploads && !hasActiveFile && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-700">Upload History</h3>
                  <button
                    onClick={() => setStep('priority')}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    Set Column Priorities &rarr;
                  </button>
                </div>
                <div className="rounded-md border border-gray-200 overflow-auto max-h-40">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="whitespace-nowrap px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">File</th>
                        <th className="whitespace-nowrap px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Rows</th>
                        <th className="whitespace-nowrap px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Columns</th>
                        <th className="whitespace-nowrap px-4 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {completedUploads.map((upload) => (
                        <tr key={upload.uploadId} className="hover:bg-gray-50">
                          <td className="whitespace-nowrap px-4 py-2.5 font-medium text-gray-900">{upload.fileName}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right text-gray-600">{upload.rowCount.toLocaleString()}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right text-gray-600">{upload.mappings.filter((m) => m.csvColumn).length}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-center">
                            <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Imported</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── File drop zone (show when no active mapping) ────── */}
            {!activePreview && !loading && !derivingMappings && (
              <div>
                {hasUploads && (
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Add Another CSV</h3>
                )}
                <FileDropZone onFileSelected={handleFileSelected} />
              </div>
            )}

            {/* ── Loading: parsing CSV ─────────────────────────────── */}
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

            {/* ── Loading: deriving mappings ────────────────────────── */}
            {derivingMappings && !loading && (
              <div className="flex items-center justify-center py-12">
                <div className="text-center">
                  <svg className="mx-auto mb-4 h-10 w-10 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <p className="text-sm font-medium text-gray-900">Generating column mappings...</p>
                  <p className="mt-1 text-xs text-gray-500">This may take a few seconds</p>
                </div>
              </div>
            )}

            {/* ── Column mapping editor (combined table with DnD) ──── */}
            {hasActiveFile && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">
                    {activeFilePath!.split('/').pop()} &mdash; {activePreview.totalRows.toLocaleString()} rows detected
                  </p>
                </div>

                <ColumnMappingEditor
                  derivedMappings={activeDerivedMappings}
                  csvColumns={activePreview.columns}
                  sampleRows={activePreview.sampleRows}
                  totalRows={activePreview.totalRows}
                  confidence={activeConfidence}
                  reasoning={activeReasoning}
                  onMappingChange={handleMappingChange}
                  completedUploads={completedUploads}
                />

                <div className="flex items-center justify-between border-t border-gray-200 pt-4">
                  <button
                    onClick={() => {
                      setActivePreview(null)
                      setActiveFilePath(null)
                      setActiveDerivedMappings(null)
                      setActiveConfidence(undefined)
                      setActiveReasoning(undefined)
                    }}
                    className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Choose Different File
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
                      'Import Data \u2192'
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
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
