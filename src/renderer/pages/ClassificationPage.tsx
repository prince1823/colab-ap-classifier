import { useState, useEffect, useRef } from 'react'
import ClassificationControls from '../components/classification/ClassificationControls'
import ProgressDisplay from '../components/classification/ProgressDisplay'
import { useWorkflowStore } from '../stores/workflowStore'
import type { ClassificationProgress } from '../../shared/types/classification'

export default function ClassificationPage() {
  const storeProgress = useWorkflowStore((s) => s.classificationProgress)
  const hasClassifiedData = useWorkflowStore((s) => s.hasClassifiedData)
  const refreshStats = useWorkflowStore((s) => s.refreshStats)

  // Local copy that persists terminal states even after the store clears progress
  const [localProgress, setLocalProgress] = useState<ClassificationProgress | null>(storeProgress)
  const [runId, setRunId] = useState<string | null>(storeProgress?.runId ?? null)
  const [error, setError] = useState<string | null>(null)
  const prevStatusRef = useRef<string | null>(storeProgress?.status ?? null)

  // Track dismissed runIds so stale store updates don't re-populate the UI after cancel
  const dismissedRunRef = useRef<string | null>(null)

  // AppShell already subscribes to progress events globally.
  // Sync local state from the store.
  useEffect(() => {
    if (storeProgress) {
      // If user already cancelled/dismissed this run, ignore stale store updates for it
      if (dismissedRunRef.current && storeProgress.runId === dismissedRunRef.current) {
        return
      }

      setLocalProgress(storeProgress)
      if (storeProgress.runId) {
        setRunId(storeProgress.runId)
      }
      if (storeProgress.status !== 'failed') {
        setError(null)
      }

      // When transitioning to a terminal state, refresh stats as a safety net
      const wasActive = prevStatusRef.current === 'pending' || prevStatusRef.current === 'researching' || prevStatusRef.current === 'classifying'
      const isTerminal = storeProgress.status === 'completed' || storeProgress.status === 'failed' || storeProgress.status === 'cancelled'
      if (wasActive && isTerminal) {
        refreshStats()
      }

      prevStatusRef.current = storeProgress.status
    }
    // Don't clear localProgress when store clears — keeps the success/failed banner visible
  }, [storeProgress, refreshStats])

  // In v2, classification state is entirely event-driven via the store.
  // No mount-time status check needed.

  const isRunning =
    localProgress !== null &&
    (localProgress.status === 'pending' ||
      localProgress.status === 'researching' ||
      localProgress.status === 'classifying')

  const isCompleted = localProgress?.status === 'completed'
  const isCancelled = localProgress?.status === 'cancelled'
  const isFailed = localProgress?.status === 'failed'

  const handleStarted = () => {
    dismissedRunRef.current = null // Allow new run's events through
    setLocalProgress(null)
    setError(null)
  }

  const handleError = (msg: string) => {
    setError(msg || null)
  }

  const handleCancelled = () => {
    // Mark this runId as dismissed so the store sync useEffect ignores stale events
    if (runId) {
      dismissedRunRef.current = runId
    }
    // Reset to initial view immediately after cancel
    setLocalProgress(null)
    setRunId(null)
    setError(null)
  }

  const handleDismiss = () => {
    setLocalProgress(null)
    setRunId(null)
    setError(null)
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Classification</h2>
        <p className="mt-1 text-sm text-gray-500">
          Start AI classification. Transactions will be classified against your taxonomy.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      <ClassificationControls
        isRunning={isRunning}
        runId={runId}
        onStarted={handleStarted}
        onError={handleError}
        onCancelled={handleCancelled}
      />

      {localProgress && <ProgressDisplay progress={localProgress} />}

      {isCompleted && hasClassifiedData && (
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
          You can now go to the <strong>Review</strong> tab to examine the results, or to <strong>Output</strong> to export.
        </div>
      )}

      {!isRunning && !localProgress && !error && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          <p className="text-sm">No classification in progress.</p>
          <p className="mt-1 text-xs">Select a scope and click "Start Classification" to begin.</p>
        </div>
      )}
    </div>
  )
}
