import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import DataUploadStep from './data-steps/DataUploadStep'
import DataMappingStep, { type MappingRow } from './data-steps/DataMappingStep'
import DataPriorityStep from './data-steps/DataPriorityStep'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { CSVPreviewWithMappings, ColumnMapping } from '../../shared/types/column-mapping'

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
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<CSVPreviewWithMappings | null>(null)
  const [mappings, setMappings] = useState<MappingRow[]>([])
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFileReady = (path: string, prev: CSVPreviewWithMappings) => {
    setFilePath(path)
    setPreview(prev)
    setStep('mapping')
  }

  const handleMappingsApplied = (rows: MappingRow[]) => {
    setMappings(rows)
    setStep('priority')
  }

  const handleSaveAndImport = async (llmOrder: string[], _nonLlm: string[]) => {
    if (!filePath) return
    setImporting(true)
    setError(null)
    try {
      // Build the simple ColumnMapping from all mapped rows (everything goes into the transaction table)
      const columnMapping: ColumnMapping = {}
      for (const row of mappings) {
        if (row.csvColumn) {
          columnMapping[row.canonical] = row.csvColumn
        }
      }

      await ipc.ingest.importCSV(filePath, columnMapping)

      // Save column_priorities — only the LLM-ordered columns
      await ipc.project.setSetting('column_priorities', llmOrder)

      await refreshMetadata()
      await refreshGateState()
      navigate('/suppliers')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import CSV')
    } finally {
      setImporting(false)
    }
  }

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
          <DataUploadStep onFileReady={handleFileReady} />
        )}
        {step === 'mapping' && preview && (
          <DataMappingStep
            preview={preview}
            initialMappings={mappings.length > 0 ? mappings : undefined}
            onApply={handleMappingsApplied}
            onBack={() => setStep('upload')}
          />
        )}
        {step === 'priority' && preview && (
          <DataPriorityStep
            preview={preview}
            mappings={mappings}
            onSave={handleSaveAndImport}
            onBack={() => setStep('mapping')}
            importing={importing}
          />
        )}
      </div>
    </div>
  )
}
