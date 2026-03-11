import { useState, useEffect, useCallback } from 'react'
import ClassificationControls from '../components/classification/ClassificationControls'
import ProgressDisplay from '../components/classification/ProgressDisplay'
import FilterConditionBuilder from '../components/FilterConditionBuilder'
import { useWorkflowStore } from '../stores/workflowStore'
import { ipc } from '../lib/ipc'
import type { ClassificationProgress } from '../../shared/types/classification'
import type { FilterCondition, FieldDefinition } from '../../shared/types/transactions'

type ScopePreset = 'unclassified_researched' | 'unclassified_not_researched' | 'all' | 'custom'

const PRESET_CONDITIONS: Record<Exclude<ScopePreset, 'custom'>, FilterCondition[]> = {
  unclassified_researched: [
    { field: 'classification_status', operator: 'equals', value: 'unclassified' },
    { field: 'is_researched', operator: 'is_true', value: '' },
  ],
  unclassified_not_researched: [
    { field: 'classification_status', operator: 'equals', value: 'unclassified' },
    { field: 'is_researched', operator: 'is_false', value: '' },
  ],
  all: [],
}

const PRESET_LABELS: Record<ScopePreset, string> = {
  unclassified_researched: 'Unclassified (with research)',
  unclassified_not_researched: 'Unclassified (no research)',
  all: 'All rows',
  custom: 'Custom filter',
}

export default function ClassificationPage() {
  const storeProgress = useWorkflowStore((s) => s.classificationProgress)

  // Local copy that persists terminal states even after the store clears progress
  const [localProgress, setLocalProgress] = useState<ClassificationProgress | null>(storeProgress)
  const [error, setError] = useState<string | null>(null)

  // Scope state
  const [preset, setPreset] = useState<ScopePreset>('unclassified_researched')
  const [customConditions, setCustomConditions] = useState<FilterCondition[]>([])
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])

  // Load filter fields on mount
  useEffect(() => {
    ipc.transactions.getFilterFields().then(setFilterFields).catch(console.error)
  }, [])

  // Sync local state from the store.
  useEffect(() => {
    if (storeProgress) {
      setLocalProgress(storeProgress)
      if (storeProgress.status !== 'failed') {
        setError(null)
      }
    }
    // Don't clear localProgress when store clears — keeps the success/failed banner visible
  }, [storeProgress])

  const isRunning =
    localProgress !== null && localProgress.status === 'running'

  const isCompleted = localProgress?.status === 'completed'

  // Compute the active conditions based on preset
  const activeConditions: FilterCondition[] = preset === 'custom'
    ? customConditions
    : PRESET_CONDITIONS[preset]

  const handlePresetChange = useCallback((newPreset: ScopePreset) => {
    setPreset(newPreset)
    // When switching to a non-custom preset, we don't clear customConditions
    // so the user can switch back and forth without losing their filter
  }, [])

  const handleStarted = () => {
    setLocalProgress(null)
    setError(null)
  }

  const handleError = (msg: string) => {
    setError(msg || null)
  }

  const handleCancelled = () => {
    setLocalProgress(null)
    setError(null)
  }

  const handleDismiss = () => {
    setLocalProgress(null)
    setError(null)
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Classification</h2>
        <p className="mt-1 text-sm text-gray-500">
          Select which transactions to classify, then start AI classification.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Scope presets */}
      {!isRunning && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Scope</label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PRESET_LABELS) as ScopePreset[]).map((key) => (
                <button
                  key={key}
                  onClick={() => handlePresetChange(key)}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    preset === key
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {PRESET_LABELS[key]}
                </button>
              ))}
            </div>
          </div>

          {/* FilterConditionBuilder — shown when custom is selected */}
          {preset === 'custom' && filterFields.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <FilterConditionBuilder
                conditions={customConditions}
                onChange={setCustomConditions}
                availableFields={filterFields}
                compact={false}
              />
              {customConditions.length === 0 && (
                <p className="mt-2 text-xs text-gray-400">
                  No conditions set — all rows will be classified.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <ClassificationControls
        isRunning={isRunning}
        conditions={activeConditions}
        onStarted={handleStarted}
        onError={handleError}
        onCancelled={handleCancelled}
      />

      {localProgress && <ProgressDisplay progress={localProgress} />}

      {isCompleted && (
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
          You can now go to the <strong>Review</strong> tab to examine the results, or to <strong>Output</strong> to export.
        </div>
      )}

      {!isRunning && !localProgress && !error && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          <p className="text-sm">No classification in progress.</p>
          <p className="mt-1 text-xs">Select a scope and click &quot;Start Classification&quot; to begin.</p>
        </div>
      )}
    </div>
  )
}
