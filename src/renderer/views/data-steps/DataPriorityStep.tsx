import { useState } from 'react'
import CSVPreviewTable from '../../components/upload/CSVPreviewTable'
import { ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import type { CSVPreviewWithMappings } from '../../../shared/types/column-mapping'
import type { MappingRow } from './DataMappingStep'

interface Props {
  preview: CSVPreviewWithMappings
  mappings: MappingRow[]
  onSave: (llmOrder: string[], nonLlm: string[]) => void
  onBack: () => void
  importing: boolean
}

export default function DataPriorityStep({ preview, mappings, onSave, onBack, importing }: Props) {
  // Initialize: all mapped columns start in the LLM list
  const allCanonicals = mappings.filter((m) => m.csvColumn).map((m) => m.canonical)
  const [llmOrder, setLlmOrder] = useState<string[]>(allCanonicals)
  const [nonLlm, setNonLlm] = useState<string[]>([])

  const moveUp = (index: number) => {
    if (index === 0) return
    setLlmOrder((prev) => {
      const next = [...prev]
      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
      return next
    })
  }

  const moveDown = (index: number) => {
    if (index >= llmOrder.length - 1) return
    setLlmOrder((prev) => {
      const next = [...prev]
      ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
      return next
    })
  }

  const removeFromLlm = (canonical: string) => {
    setLlmOrder((prev) => prev.filter((c) => c !== canonical))
    setNonLlm((prev) => [...prev, canonical])
  }

  const addToLlm = (canonical: string) => {
    setNonLlm((prev) => prev.filter((c) => c !== canonical))
    setLlmOrder((prev) => [...prev, canonical])
  }

  return (
    <div className="flex gap-6 h-full">
      {/* Left: CSV preview */}
      <div className="flex-1 min-w-0">
        <CSVPreviewTable preview={preview} />
      </div>

      {/* Right: Priority order */}
      <div className="w-80 flex-shrink-0 space-y-4 overflow-auto">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Columns sent to LLM</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Higher position = more weight in classification.
          </p>
        </div>

        {/* LLM columns */}
        <div className="space-y-1">
          {llmOrder.map((canonical, index) => (
            <div
              key={canonical}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                {index + 1}
              </span>
              <span className="flex-1 text-sm text-gray-700 truncate">{canonical}</span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => moveUp(index)}
                  disabled={index === 0}
                  className="rounded p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                  title="Move up"
                >
                  <ChevronUpIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => moveDown(index)}
                  disabled={index >= llmOrder.length - 1}
                  className="rounded p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                  title="Move down"
                >
                  <ChevronDownIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => removeFromLlm(canonical)}
                  className="ml-1 rounded p-0.5 text-gray-400 hover:text-red-500 text-xs"
                  title="Remove from LLM"
                >
                  &times;
                </button>
              </div>
            </div>
          ))}
          {llmOrder.length === 0 && (
            <p className="text-xs text-gray-400 italic py-2">No columns selected for LLM.</p>
          )}
        </div>

        {/* Non-LLM columns */}
        {nonLlm.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Not sent to LLM
            </h4>
            <div className="space-y-1">
              {nonLlm.map((canonical) => (
                <div
                  key={canonical}
                  className="flex items-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2"
                >
                  <span className="flex-1 text-sm text-gray-500 truncate">{canonical}</span>
                  <button
                    onClick={() => addToLlm(canonical)}
                    className="rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onBack}
            disabled={importing}
            className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            &larr; Back
          </button>
          <button
            onClick={() => onSave(llmOrder, nonLlm)}
            disabled={importing}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
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
              'Save & Import \u2192'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
