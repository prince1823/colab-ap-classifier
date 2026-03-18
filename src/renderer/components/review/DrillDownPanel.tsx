import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { FlattenedPivotRow, PathSegment } from '../../types/pivot'
import type { Transaction, FilterCondition } from '../../../shared/types/transactions'
import { fmtAbbrev } from '../../utils/formatSpend'

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

/** Default column widths */
const DEFAULT_WIDTHS: Record<string, number> = {
  supplier_name: 180,
  classification: 220,
}
const DEFAULT_COL_WIDTH = 150

export default function DrillDownPanel({ row, onClose }: DrillDownPanelProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})

  // Resize state
  const resizingCol = useRef<string | null>(null)
  const startX = useRef(0)
  const startWidth = useRef(0)

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
  // Ensure creation_date is always last
  const AMOUNT_COLS = new Set(['spend_amount', 'amount', 'invoice_amount', 'total_amount'])
  const displayCols = (() => {
    if (transactions.length === 0) return []
    const keys = Object.keys(transactions[0].canonicalFields).filter(k => k !== 'supplier_name')
    const hasCreationDate = keys.includes('creation_date')
    const rest = keys.filter(k => k !== 'creation_date').slice(0, hasCreationDate ? 5 : 6)
    return hasCreationDate ? [...rest, 'creation_date'] : rest
  })()

  // All columns: supplier + classification + dynamic
  const allCols = ['supplier_name', 'classification', ...displayCols]

  const getWidth = (col: string) =>
    colWidths[col] ?? DEFAULT_WIDTHS[col] ?? DEFAULT_COL_WIDTH

  const handleMouseDown = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault()
    resizingCol.current = col
    startX.current = e.clientX
    startWidth.current = getWidth(col)

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizingCol.current) return
      const diff = ev.clientX - startX.current
      const newWidth = Math.max(60, startWidth.current + diff)
      setColWidths(prev => ({ ...prev, [resizingCol.current!]: newWidth }))
    }

    const handleMouseUp = () => {
      resizingCol.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [colWidths])

  const colLabel = (col: string) => {
    if (col === 'classification') return 'Classification'
    return col.replace(/_/g, ' ')
  }

  const getCellValue = (tx: Transaction, col: string): string => {
    if (col === 'supplier_name') return String(tx.canonicalFields.supplier_name ?? '-')
    if (col === 'classification') return tx.classificationPath?.split('|').map(s => s.trim()).join(' > ') ?? '-'
    const raw = tx.canonicalFields[col]
    if (raw == null) return '-'
    // Format amount columns with $K/$M
    if (AMOUNT_COLS.has(col)) {
      const num = Number(raw)
      if (!isNaN(num)) return fmtAbbrev(num)
    }
    return String(raw)
  }

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
          <table className="text-[11px]" style={{ tableLayout: 'fixed', width: allCols.reduce((sum, col) => sum + getWidth(col), 0) }}>
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {allCols.map(col => (
                  <th
                    key={col}
                    className="text-left font-medium text-gray-500 relative"
                    style={{ width: getWidth(col), minWidth: 60, padding: '6px 12px' }}
                  >
                    <span className="truncate block">{colLabel(col)}</span>
                    {/* Resize handle — visible border line */}
                    <div
                      onMouseDown={(e) => handleMouseDown(col, e)}
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 4,
                        bottom: 4,
                        width: 3,
                        cursor: 'col-resize',
                        borderRight: '1px solid #d1d5db',
                        transition: 'border-color 0.15s',
                      }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.borderRight = '2px solid #3b82f6' }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.borderRight = '1px solid #d1d5db' }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {transactions.map(tx => (
                <tr key={tx.id} className="hover:bg-gray-50">
                  {allCols.map(col => {
                    const value = getCellValue(tx, col)
                    return (
                      <td
                        key={col}
                        className="text-gray-600 truncate"
                        style={{ width: getWidth(col), maxWidth: getWidth(col), padding: '6px 12px' }}
                        title={value}
                      >
                        {value}
                      </td>
                    )
                  })}
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
