import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ipc } from '../../lib/ipc'
import { showError } from '../../lib/toast-errors'
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
      await ipc.classification.stop()
      onCancelled()
    } catch (e) {
      showError('Failed to cancel classification', e)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <>
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

      {/* Confirmation modal */}
      {confirmCount !== null && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={handleCancelConfirm} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[400px] p-6">
            <h3 className="text-base font-semibold text-gray-900">
              Confirm Classification
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              {confirmCount === 0
                ? 'No rows match the current filter.'
                : <>Start classification on <strong>{confirmCount.toLocaleString()}</strong> {confirmCount === 1 ? 'row' : 'rows'}?</>
              }
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={handleCancelConfirm}
                className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={starting || confirmCount === 0}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                {starting ? 'Starting...' : 'Start Classification'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
