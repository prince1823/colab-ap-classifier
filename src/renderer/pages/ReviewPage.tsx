import { useState, useMemo, useEffect } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { useTransactions } from '../hooks/useTransactions'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import Dashboard from '../components/review/Dashboard'

const DashboardContent = () => {
  const { data: transactions, loading, error, refetch } = useTransactions()

  // Transform backend transactions to the shape Dashboard expects
  const initialTransactions = useMemo(() => {
    if (!transactions) return []
    return transactions.map((t, idx) => transactionToDashboardRow(t, idx))
  }, [transactions])

  // Local state for transactions (can be updated by reclassification)
  const [localTransactions, setLocalTransactions] = useState(initialTransactions)

  // Update when data changes from IPC
  useEffect(() => {
    setLocalTransactions(initialTransactions)
  }, [initialTransactions])

  const datasetId = 'default'
  const foldername = 'default'
  const setDatasetId = () => {}
  const setFoldername = () => {}

  return (
    <Dashboard
      transactions={localTransactions}
      loading={loading}
      error={error}
      datasetId={datasetId}
      setDatasetId={setDatasetId}
      foldername={foldername}
      setFoldername={setFoldername}
      refreshTransactions={refetch}
      setTransactions={setLocalTransactions}
    />
  )
}

export default function ReviewPage() {
  return (
    <DndProvider backend={HTML5Backend}>
      <DashboardContent />
    </DndProvider>
  )
}
