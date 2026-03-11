import { useState, useEffect, useCallback } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { FlattenedPivotRow, PathSegment } from '../../types/pivot'
import type { Transaction, FilterCondition } from '../../../shared/types/transactions'

const UNCLASSIFIED_LABEL = '(Unclassified)'
const CLASSIFICATION_DIMS = new Set(['classification_l1', 'classification_l2', 'classification_l3'])
const PAGE_SIZE = 50

function buildConditionsFromSegments(pathSegments: PathSegment[]): FilterCondition[] {
  const conditions: FilterCondition[] = []
  for (const segment of pathSegments) {
    if (segment.value === UNCLASSIFIED_LABEL && CLASSIFICATION_DIMS.has(segment.dimensionField)) {
      conditions.push({ field: 'taxonomy_node_id', operator: 'is_null', value: '' })
    } else {
      conditions.push({ field: segment.dimensionField, operator: 'equals', value: segment.value })
    }
  }
  return conditions
}

interface DrillDownPanelProps {
  row: FlattenedPivotRow
  onClose: () => void
}

export default function DrillDownPanel({ row, onClose }: DrillDownPanelProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const conditions = buildConditionsFromSegments(row.pathSegments)
      const result = await ipc.transactions.query({
        conditions,
        page: p,
        pageSize: PAGE_SIZE,
        sortBy: 'row_index',
        sortOrder: 'asc',
      })
      setTransactions(result.rows)
      setTotalCount(result.totalCount)
      setPage(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transactions')
    } finally {
      setLoading(false)
    }
  }, [row.pathSegments])

  useEffect(() => {
    fetchPage(1)
  }, [fetchPage])

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)
  const breadcrumb = row.pathSegments.map(s => s.value).join(' > ')

  // Pick display columns from first transaction's canonical fields
  const displayCols = transactions.length > 0
    ? Object.keys(transactions[0].canonicalFields).slice(0, 6)
    : []

  return (
    <div className="border-t border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-gray-900 truncate">{breadcrumb}</span>
          <span className="text-[10px] text-gray-400 flex-shrink-0">
            {totalCount.toLocaleString()} transaction{totalCount !== 1 ? 's' : ''}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      {error && (
        <div className="px-4 py-2 text-xs text-red-600">{error}</div>
      )}

      {loading && transactions.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-400">Loading...</div>
      ) : (
        <div className="overflow-auto max-h-[300px]">
          <table className="min-w-full text-[11px]">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium text-gray-500">Supplier</th>
                <th className="px-3 py-1.5 text-left font-medium text-gray-500">Classification</th>
                {displayCols.map(col => (
                  <th key={col} className="px-3 py-1.5 text-left font-medium text-gray-500">
                    {col.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {transactions.map(tx => (
                <tr key={tx.id} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 text-gray-700 truncate max-w-[180px]">
                    {String(tx.canonicalFields.supplier_name ?? '-')}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500 truncate max-w-[200px]">
                    {tx.classificationPath?.split('|').map(s => s.trim()).join(' > ') ?? '-'}
                  </td>
                  {displayCols.map(col => (
                    <td key={col} className="px-3 py-1.5 text-gray-600 truncate max-w-[150px]">
                      {String(tx.canonicalFields[col] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-100 text-[10px] text-gray-500">
          <span>Page {page} of {totalPages}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => fetchPage(page - 1)}
              disabled={page <= 1}
              className="p-0.5 rounded hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              onClick={() => fetchPage(page + 1)}
              disabled={page >= totalPages}
              className="p-0.5 rounded hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
