import { useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { ClassificationScope } from '../../../shared/types/classification'

interface Props {
  isRunning: boolean
  runId: string | null
  onStarted: () => void
  onError: (msg: string) => void
  onCancelled: () => void
}

export default function ClassificationControls({ isRunning, runId, onStarted, onError, onCancelled }: Props) {
  const [scope, setScope] = useState<ClassificationScope>('all')
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const handleStart = async () => {
    setStarting(true)
    onError('')
    try {
      await ipc.classification.start({ scope })
      onStarted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start classification'
      onError(msg)
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = async () => {
    if (!runId) return
    setCancelling(true)
    try {
      await ipc.classification.cancel(runId)
      // Force the cancelled state into the store immediately so the UI updates
      // even if the backend progress event gets lost or overwritten by stale events
      useWorkflowStore.getState().setClassificationProgress({
        runId,
        status: 'cancelled',
        phase: 'researching',
        total: 0,
        processed: 0,
        percentage: 0,
        currentStep: 'Cancelled',
      })
      onCancelled()
    } catch (e) {
      console.error('Failed to cancel classification:', e)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-gray-700">Scope:</label>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as ClassificationScope)}
          disabled={isRunning}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        >
          <option value="all">All transactions</option>
          <option value="new">New / unclassified only</option>
          <option value="filtered">Current filter</option>
        </select>
      </div>

      {isRunning ? (
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {cancelling ? 'Cancelling...' : 'Cancel'}
        </button>
      ) : (
        <button
          onClick={handleStart}
          disabled={starting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {starting ? 'Starting...' : 'Start Classification'}
        </button>
      )}
    </div>
  )
}
