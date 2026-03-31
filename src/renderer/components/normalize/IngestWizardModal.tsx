import { useState } from 'react'
import { X } from 'lucide-react'
import FileDropZone from '../upload/FileDropZone'
import DataMappingStep, { type ColumnState } from '../../views/data-steps/DataMappingStep'
import { ipc } from '../../lib/ipc'
import { REQUIRED_CANONICAL_COLUMNS } from '../../../shared/canonical-columns'
import type {
  CSVPreview,
  ColumnMapping,
  MappingRow,
  DerivedMappings,
} from '../../../shared/types/column-mapping'

interface Props {
  onClose: () => void
  onComplete: () => void
}

type Step = 'upload' | 'mapping'

export default function IngestWizardModal({ onClose, onComplete }: Props) {
  const [step, setStep] = useState<Step>('upload')
  const [error, setError] = useState<string | null>(null)

  // File & preview state
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [activePreview, setActivePreview] = useState<CSVPreview | null>(null)
  const [activeDerivedMappings, setActiveDerivedMappings] = useState<DerivedMappings | null>(null)
  const [derivingMappings, setDerivingMappings] = useState(false)
  const [importing, setImporting] = useState(false)

  const handleFileSelected = async (path: string) => {
    setError(null)
    setDerivingMappings(true)
    try {
      const preview = await ipc.ingest.parseCSV(path)
      setActiveFilePath(path)
      setActivePreview(preview)

      const derived = await ipc.ingest.deriveMappings(
        preview.columns,
        preview.sampleRows,
        'llm'
      )
      setActiveDerivedMappings(derived)
      setStep('mapping')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse CSV')
    } finally {
      setDerivingMappings(false)
    }
  }

  const handleImport = async (rows: MappingRow[], _columnStates?: ColumnState[]) => {
    if (!activeFilePath) return
    setImporting(true)
    setError(null)
    try {
      const columnMapping: ColumnMapping = {}
      for (const row of rows) {
        if (row.csvColumn && row.canonical) {
          columnMapping[row.canonical] = row.csvColumn
        }
      }

      const missingRequired = REQUIRED_CANONICAL_COLUMNS.filter((r) => !columnMapping[r])
      if (missingRequired.length > 0) {
        const names = missingRequired.map((n) => `"${n}"`).join(', ')
        throw new Error(
          `Missing required column${missingRequired.length > 1 ? 's' : ''}: ${names}. Please assign a CSV column to ${missingRequired.length > 1 ? 'each' : 'it'} before importing.`
        )
      }

      await ipc.ingest.importCSV(activeFilePath, columnMapping)

      // Merge new mapped columns into column_priorities
      const existingPriorities = await ipc.project.getSetting('column_priorities') as string[] | null
      const mappedCols = rows.filter((r) => r.csvColumn).map((r) => r.canonical)
      if (!existingPriorities || existingPriorities.length === 0) {
        const supplierFirst = mappedCols.filter((c) => c === 'supplier_name')
        const rest = mappedCols.filter((c) => c !== 'supplier_name')
        await ipc.project.setSetting('column_priorities', [...supplierFirst, ...rest])
      } else {
        const existingSet = new Set(existingPriorities)
        const newCols = mappedCols.filter((c) => !existingSet.has(c))
        if (newCols.length > 0) {
          await ipc.project.setSetting('column_priorities', [...existingPriorities, ...newCols])
        }
      }

      onComplete()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import CSV')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative flex flex-col bg-white rounded-xl shadow-xl w-[90vw] max-w-5xl h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {step === 'upload' ? 'Select CSV File' : 'Review Column Mapping'}
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
          {step === 'upload' && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              {derivingMappings ? (
                <div className="flex flex-col items-center gap-3">
                  <svg className="h-10 w-10 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <p className="text-sm text-gray-600">Parsing file and deriving column mappings...</p>
                </div>
              ) : (
                <FileDropZone onFileSelected={handleFileSelected} />
              )}
            </div>
          )}

          {step === 'mapping' && activePreview && activeDerivedMappings && (
            <DataMappingStep
              preview={activePreview}
              derivedMappings={activeDerivedMappings}
              onApply={handleImport}
              onBack={() => {
                setActiveDerivedMappings(null)
                setActivePreview(null)
                setActiveFilePath(null)
                setStep('upload')
              }}
              importing={importing}
              isFirstUpload={true}
            />
          )}
        </div>
      </div>
    </div>
  )
}
