import { useState, useEffect, useRef, useCallback } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import Dashboard from '../components/review/Dashboard'
import { ipc } from '../lib/ipc'
import type { TransactionStats } from '../../shared/types/transactions'
import { fmtAbbrev } from '../utils/formatSpend'

/**
 * Light-weight loader: fetches only the first page of raw transactions
 * (for classification tree, currentSelection, reclassification) + stats.
 * Tables use server-side grouped data exclusively (managed by Dashboard).
 */
function useLightTransactions() {
  const [data, setData] = useState<Record<string, unknown>[]>([])
  const [stats, setStats] = useState<TransactionStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const fetchData = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const [statsResult, pageResult] = await Promise.all([
        ipc.transactions.stats(),
        ipc.transactions.queryPaginated({ page: 1, pageSize: 5000 }),
      ])
      if (!mountedRef.current) return
      const transformed = pageResult.rows.map((t, idx) => transactionToDashboardRow(t, idx))
      setData(transformed)
      setStats(statsResult)
      setLoading(false)
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Unknown error')
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchData()
    return () => { mountedRef.current = false }
  }, [fetchData])

  return { data, stats, loading, error, refetch: fetchData, setData }
}

const DashboardContent = () => {
  const { data: transactions, stats, loading, error, refetch, setData: setTransactions } = useLightTransactions()

  return (
    <div className="flex flex-col h-full">
      {/* Stats bar */}
      {stats && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 bg-gray-50">
          <span className="text-xs text-gray-500">
            {stats.totalRows.toLocaleString()} rows | {fmtAbbrev(stats.totalSpend)} total spend
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <Dashboard
          transactions={transactions}
          loading={loading && transactions.length === 0}
          error={error}
          datasetId="default"
          setDatasetId={() => {}}
          foldername="default"
          setFoldername={() => {}}
          refreshTransactions={refetch}
          setTransactions={setTransactions}
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
