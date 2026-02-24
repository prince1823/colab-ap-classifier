import { useState, useMemo, useEffect, useDeferredValue, useRef } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { useTransactions } from '../hooks/useTransactions'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import Dashboard from '../components/review/Dashboard'

const DashboardContent = () => {
  const { data: transactions, loading, loadingMore, error, totalCount, loadedCount, refetch } = useTransactions()

  // Transform backend transactions to the shape Dashboard expects.
  // Use a stable ref to avoid re-transforming when the array reference changes
  // but the content is the same (e.g. during chunk loading).
  const prevLengthRef = useRef(0)
  const transformedRef = useRef<Record<string, unknown>[]>([])

  const initialTransactions = useMemo(() => {
    if (!transactions || transactions.length === 0) {
      prevLengthRef.current = 0
      transformedRef.current = []
      return []
    }
    // Only re-transform if the row count actually changed
    if (transactions.length === prevLengthRef.current && transformedRef.current.length > 0) {
      return transformedRef.current
    }
    const result = transactions.map((t, idx) => transactionToDashboardRow(t, idx))
    prevLengthRef.current = transactions.length
    transformedRef.current = result
    return result
  }, [transactions])

  // Local state for transactions (can be updated by reclassification).
  // Initialize directly from the memo (not via useEffect) to avoid the
  // one-frame gap that causes the "No Data Available" flash.
  const [localTransactions, setLocalTransactions] = useState(initialTransactions)

  // Sync when upstream data changes (new chunks, refetch after reclassification)
  useEffect(() => {
    setLocalTransactions(initialTransactions)
  }, [initialTransactions])

  // Use deferred value so React keeps the UI responsive during heavy
  // re-renders triggered by filter changes or chunk loading.
  // But during first load (no data yet), pass the raw value to avoid deferral lag.
  const deferredTransactions = useDeferredValue(localTransactions)
  const hasLoadedOnce = localTransactions.length > 0
  const effectiveTransactions = hasLoadedOnce ? deferredTransactions : localTransactions

  // Treat as loading if the hook says loading OR if we have no data yet
  // (prevents the "No Data Available" flash during first chunk fetch)
  const effectiveLoading = loading || (!error && !hasLoadedOnce && !transactions)

  const datasetId = 'default'
  const foldername = 'default'
  const setDatasetId = () => {}
  const setFoldername = () => {}

  return (
    <div className="flex flex-col h-full">
      {/* Progress indicator for background chunk loading */}
      {loadingMore && totalCount > 0 && (
        <div className="loading-progress-bar">
          <div
            className="loading-progress-fill"
            style={{ width: `${Math.round((loadedCount / totalCount) * 100)}%` }}
          />
          <span className="loading-progress-text">
            Loading {loadedCount.toLocaleString()} / {totalCount.toLocaleString()} rows...
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <Dashboard
          transactions={effectiveTransactions}
          loading={effectiveLoading}
          error={error}
          datasetId={datasetId}
          setDatasetId={setDatasetId}
          foldername={foldername}
          setFoldername={setFoldername}
          refreshTransactions={refetch}
          setTransactions={setLocalTransactions}
        />
      </div>
    </div>
  )
}

export default function ReviewPage() {
  return (
    <DndProvider backend={HTML5Backend}>
      <DashboardContent />
    </DndProvider>
  )
}
