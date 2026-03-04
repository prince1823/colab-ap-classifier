import { useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useWorkflowStore } from '../../stores/workflowStore'

interface Props {
  isRunning: boolean
  onStarted: () => void
  onError: (msg: string) => void
  onCancelled: () => void
}

export default function ClassificationControls({ isRunning, onStarted, onError, onCancelled }: Props) {
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const handleStart = async () => {
    setStarting(true)
    onError('')
    try {
      await ipc.classification.start()
      onStarted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start classification'
      onError(msg)
    } finally {
      setStarting(false)
    }
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
