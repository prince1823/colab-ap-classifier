import { useState, useEffect, useCallback } from 'react'
import ClassificationControls from '../components/classification/ClassificationControls'
import ProgressDisplay from '../components/classification/ProgressDisplay'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import { makeEmptyGroup, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import { useWorkflowStore } from '../stores/workflowStore'
import { ipc } from '../lib/ipc'
import QCPanel from '../components/qc/QCPanel'
import type { ClassificationProgress } from '../../shared/types/classification'
import type { FieldDefinition, GroupedFilter, FilterOperator } from '../../shared/types/transactions'

type ActiveTab = 'classification' | 'qc'
type ScopePreset = 'unclassified_researched' | 'unclassified_not_researched' | 'all' | 'custom'

const PRESET_GROUPED: Record<Exclude<ScopePreset, 'custom'>, GroupedFilter> = {
  unclassified_researched: {
    groupConnector: 'AND',
    groups: [{
      connector: 'AND',
      conditions: [
        { field: 'classification_status', operator: 'equals', value: 'unclassified' },
        { field: 'is_researched', operator: 'is_true', value: '' },
      ],
    }],
  },
  unclassified_not_researched: {
    groupConnector: 'AND',
    groups: [{
      connector: 'AND',
      conditions: [
        { field: 'classification_status', operator: 'equals', value: 'unclassified' },
        { field: 'is_researched', operator: 'is_false', value: '' },
      ],
    }],
  },
  all: { groupConnector: 'AND', groups: [] },
}

const PRESET_LABELS: Record<ScopePreset, string> = {
  unclassified_researched: 'Unclassified (with research)',
  unclassified_not_researched: 'Unclassified (no research)',
  all: 'All rows',
  custom: 'Custom filter',
}

export default function ClassificationPage() {
  const storeProgress = useWorkflowStore((s) => s.classificationProgress)
  const subscribeToClassificationProgress = useWorkflowStore((s) => s.subscribeToClassificationProgress)
  const subscribeToQCProgress = useWorkflowStore((s) => s.subscribeToQCProgress)
  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>('classification')

  // Local copy that persists terminal states even after the store clears progress
  const [localProgress, setLocalProgress] = useState<ClassificationProgress | null>(storeProgress)
  const [error, setError] = useState<string | null>(null)

  // Scope state
  const [preset, setPreset] = useState<ScopePreset>('unclassified_researched')
  const [customGrouped, setCustomGrouped] = useState<GroupedFilter | null>(null)
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const [filterModalOpen, setFilterModalOpen] = useState(false)

  // Load filter fields on mount, subscribe to classification + QC progress via store
  useEffect(() => {
    ipc.transactions.getFilterFields().then(setFilterFields).catch(console.error)
    const unsubscribeClassification = subscribeToClassificationProgress()
    const unsubscribeQC = subscribeToQCProgress()
    return () => { unsubscribeClassification(); unsubscribeQC() }
  }, [subscribeToClassificationProgress, subscribeToQCProgress])

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

  // Compute the active grouped filter based on preset
  const activeGrouped: GroupedFilter = preset === 'custom'
    ? (customGrouped ?? { groupConnector: 'AND', groups: [] })
    : PRESET_GROUPED[preset]

  // Count valid custom conditions for the summary pill
  const customConditionCount = customGrouped
    ? customGrouped.groups.reduce((sum, g) => sum + g.conditions.filter(c => c.field).length, 0)
    : 0

  const handlePresetChange = useCallback((newPreset: ScopePreset) => {
    setPreset(newPreset)
    if (newPreset === 'custom') {
      setFilterModalOpen(true)
    }
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
      {/* Header with tab toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {activeTab === 'classification' ? 'Classification' : 'QC Agent'}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {activeTab === 'classification'
              ? 'Select which transactions to classify, then start AI classification.'
              : 'Configure and run quality checks on classified transactions.'}
          </p>
        </div>
        <div className="flex rounded-lg border border-gray-300 bg-gray-100 p-0.5">
          <button
            onClick={() => setActiveTab('classification')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'classification'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Classification
          </button>
          <button
            onClick={() => setActiveTab('qc')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'qc'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            QC Agent
          </button>
        </div>
      </div>

      {/* Classification tab */}
      {activeTab === 'classification' && (
        <>
          {error && (
            <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
          )}

          {/* Scope presets */}
          {!isRunning && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Scope</label>
                <div className="flex items-center gap-2">
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
                  <div className="ml-auto shrink-0">
                    <ClassificationControls
                      isRunning={isRunning}
                      groupedFilter={activeGrouped}
                      onStarted={handleStarted}
                      onError={handleError}
                      onCancelled={handleCancelled}
                    />
                  </div>
                </div>
              </div>

              {/* Custom filter summary */}
              {preset === 'custom' && (
                <div
                  onClick={() => setFilterModalOpen(true)}
                  className="cursor-pointer rounded-md border border-gray-200 bg-white px-2.5 py-1.5 hover:border-blue-300 hover:bg-blue-50/30 transition-colors overflow-x-auto scrollbar-hide"
                  style={{ scrollbarWidth: 'none' }}
                >
                  {customConditionCount > 0 ? (
                    <div className="flex items-center gap-0.5 whitespace-nowrap">
                      {customGrouped!.groups.map((group, gi) => {
                        const validConditions = group.conditions.filter(c => c.field)
                        if (validConditions.length === 0) return null
                        const groupConnector = gi > 0
                          ? (group.groupConnector ?? customGrouped!.groupConnector)
                          : null
                        return (
                          <span key={gi} className="contents">
                            {groupConnector && (
                              <span className="mx-0.5 text-[9px] font-bold text-blue-600">{groupConnector}</span>
                            )}
                            {validConditions.length > 1 && <span className="text-[10px] text-gray-400">(</span>}
                            {validConditions.map((c, ci) => {
                              const condConnector = ci > 0
                                ? (validConditions[ci - 1].connector ?? group.connector)
                                : null
                              const displayValue = ['is_true', 'is_false', 'is_null'].includes(c.operator)
                                ? ''
                                : ` "${Array.isArray(c.value) ? c.value.join(', ') : c.value}"`
                              return (
                                <span key={ci} className="contents">
                                  {condConnector && (
                                    <span className="mx-0.5 text-[9px] font-bold text-gray-500">{condConnector}</span>
                                  )}
                                  <span className="inline-flex items-center rounded bg-gray-100 px-1 py-px text-[10px] text-gray-700">
                                    <span className="font-medium">{c.field}</span>
                                    <span className="mx-0.5 text-gray-400">{OPERATOR_LABELS[c.operator as FilterOperator]}</span>
                                    {displayValue && <span className="text-blue-600">{displayValue}</span>}
                                  </span>
                                </span>
                              )
                            })}
                            {validConditions.length > 1 && <span className="text-[10px] text-gray-400">)</span>}
                          </span>
                        )
                      })}
                      <span className="ml-1.5 text-[9px] text-gray-400 shrink-0">click to edit</span>
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-400">
                      No conditions set — click to add filters. All rows will be classified.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {isRunning && (
            <ClassificationControls
              isRunning={isRunning}
              groupedFilter={activeGrouped}
              onStarted={handleStarted}
              onError={handleError}
              onCancelled={handleCancelled}
            />
          )}

          {localProgress && <ProgressDisplay progress={localProgress} />}

          {!isRunning && !localProgress && !error && (
            <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
              <p className="text-sm">No classification in progress.</p>
              <p className="mt-1 text-xs">Select a scope and click &quot;Start Classification&quot; to begin.</p>
            </div>
          )}

          <AdvancedFilterModal
            isOpen={filterModalOpen}
            onClose={() => setFilterModalOpen(false)}
            groupedFilter={customGrouped}
            onApply={setCustomGrouped}
            availableFields={filterFields}
            title="Classification Scope Filter"
            subtitle="Build conditions to filter which transactions to classify"
          />
        </>
      )}

      {/* QC Agent tab */}
      {activeTab === 'qc' && <QCPanel />}
    </div>
  )
}
