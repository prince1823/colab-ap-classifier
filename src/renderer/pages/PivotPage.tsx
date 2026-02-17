import { useMemo } from 'react'
import { useTransactions } from '../hooks/useTransactions'
import { transactionToDashboardRow } from '../utils/transactionTransform'
import PivotView from '../components/review/PivotView'

export default function PivotPage() {
  const { data: transactions, loading, error } = useTransactions()

  const rows = useMemo(() => {
    if (!transactions) return []
    return transactions.map((t, idx) => transactionToDashboardRow(t, idx))
  }, [transactions])

  const availableColumns = useMemo(() => {
    if (!rows.length) return []
    // Collect all string/number-valued keys across transactions
    const keys = new Set<string>()
    for (const row of rows.slice(0, 100)) {
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
          keys.add(k)
        }
      }
    }
    // Filter out internal / id-like fields
    const exclude = new Set(['id', 'row_index', 'taxonomy_node_id', 'classification_reasoning', 'invoice_group_key'])
    return [...keys].filter((k) => !exclude.has(k)).sort()
  }, [rows])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          <span className="text-sm text-gray-500">Loading transactions…</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-red-600 font-medium">Failed to load transactions</p>
          <p className="text-sm text-gray-500 mt-1">{String(error)}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full p-6">
      <div className="mb-4 flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-900">Pivot Analysis</h1>
        <p className="text-sm text-gray-500 mt-1">
          Cross-tabulate spend by any two dimensions. Rows and columns are sorted by total spend.
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <PivotView transactions={rows} availableColumns={availableColumns} />
      </div>
    </div>
  )
}
