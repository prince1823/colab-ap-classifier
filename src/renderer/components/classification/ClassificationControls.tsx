import { useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { GroupedFilter } from '../../../shared/types/transactions'

interface Props {
  isRunning: boolean
  groupedFilter: GroupedFilter
  onStarted: () => void
  onError: (msg: string) => void
  onCancelled: () => void
}

/** Check if a GroupedFilter has any real conditions (non-empty groups with non-empty fields). */
function hasConditions(gf: GroupedFilter): boolean {
  return gf.groups.length > 0 && gf.groups.some(g => g.conditions.length > 0 && g.conditions.some(c => c.field !== ''))
}

export default function ClassificationControls({ isRunning, groupedFilter, onStarted, onError, onCancelled }: Props) {
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [confirmCount, setConfirmCount] = useState<number | null>(null)
  const [loadingCount, setLoadingCount] = useState(false)

  const handleStartClick = async () => {
    setLoadingCount(true)
    onError('')
    try {
      const count = await ipc.classification.scopeCount(
        hasConditions(groupedFilter) ? groupedFilter : undefined
      )
      setConfirmCount(count)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to get scope count'
      onError(msg)
    } finally {
      setLoadingCount(false)
    }
  }

  const handleConfirm = async () => {
    setConfirmCount(null)
    setStarting(true)
    try {
      await ipc.classification.start(
        hasConditions(groupedFilter) ? groupedFilter : undefined
      )
      onStarted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start classification'
      onError(msg)
    } finally {
      setStarting(false)
    }
  }

  const handleCancelConfirm = () => {
    setConfirmCount(null)
  }

  const handleCancel = async () => {
    setCancelling(true)
    try {
      await ipc.classification.cancel()
      useWorkflowStore.getState().setClassificationProgress({
        status: 'cancelled',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: 'Cancelled',
      })
      onCancelled()
    } catch (e) {
      console.error('Failed to cancel classification:', e)
    } finally {
      setCancelling(false)
    }
  }

  // Confirmation dialog
  if (confirmCount !== null) {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
        <p className="text-sm text-blue-800">
          Start classification on <strong>{confirmCount.toLocaleString()}</strong> {confirmCount === 1 ? 'row' : 'rows'}?
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={starting || confirmCount === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {starting ? 'Starting...' : 'Start Classification'}
          </button>
          <button
            onClick={handleCancelConfirm}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          {confirmCount === 0 && (
            <span className="text-sm text-gray-500">No rows match the current filter.</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4">
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
          onClick={handleStartClick}
          disabled={loadingCount}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loadingCount ? 'Checking...' : 'Start Classification'}
        </button>
      )}
    </div>
  )
}
