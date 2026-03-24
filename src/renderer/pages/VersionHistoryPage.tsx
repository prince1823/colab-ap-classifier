import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { ipc } from '../lib/ipc'
import type { ChangeLog, ChangelogFilter } from '../../shared/types/changelog'
import type { Transaction } from '../../shared/types/transactions'
import type { FeedbackRecommendation } from '../../shared/types/feedback'
import SystemFeedbackModal from '../components/review/SystemFeedbackModal'
import SystemFeedbackDialog from '../components/review/SystemFeedbackDialog'

/** Friendly labels for known fields */
const FIELD_LABELS: Record<string, string> = {
  taxonomy_node_id: 'Classification',
  classification_status: 'Classification Status',
  status: 'Status',
  suggestion: 'Suggestion',
}

const INTERNAL_COLS = new Set([
  'id', 'row_index', 'upload_id', 'taxonomy_node_id',
  'classification_status', 'human_reviewed',
  'original_supplier_name', 'project_supplier_id',
  'created_at', 'updated_at',
])

const PAGE_SIZE = 50

function humanizeField(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** Format a value — resolve taxonomy UUIDs, skip raw IDs */
function formatValue(val: unknown, taxonomyMap: Map<string, string>): string {
  if (val == null) return '-'
  if (typeof val === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
      return taxonomyMap.get(val) || '-'
    }
    return val
  }
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (typeof val === 'number') return val.toLocaleString()
  if (Array.isArray(val)) return val.length === 0 ? '-' : val.join(', ')
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>).filter(([, v]) => v != null)
    if (entries.length === 0) return '-'
    return entries.map(([k, v]) => `${humanizeField(k)}: ${formatValue(v, taxonomyMap)}`).join(', ')
  }
  return String(val)
}

/** Build changed fields diff between old and new values */
function getChangedFields(
  oldVals: Record<string, unknown> | null,
  newVals: Record<string, unknown> | null,
  taxonomyMap: Map<string, string>,
): { field: string; from: string; to: string }[] {
  const changes: { field: string; from: string; to: string }[] = []
  const allKeys = new Set([
    ...Object.keys(oldVals || {}),
    ...Object.keys(newVals || {}),
  ])

  for (const key of allKeys) {
    if (key === 'id' || key === 'updated_at' || key === 'created_at') continue
    const oldVal = oldVals?.[key]
    const newVal = newVals?.[key]
    const oldStr = formatValue(oldVal, taxonomyMap)
    const newStr = formatValue(newVal, taxonomyMap)
    if (oldStr !== newStr) {
      changes.push({ field: humanizeField(key), from: oldStr, to: newStr })
    }
  }
  return changes
}

/** Inline transaction drill-down panel for a changelog entry */
function ChangeTransactionPanel({
  entry,
  onClose,
}: {
  entry: ChangeLog
  onClose: () => void
}) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const result = await ipc.transactions.query({
        conditions: [{ field: 'id', operator: 'in_list', value: entry.affectedIds }],
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
  }, [entry.affectedIds])

  useEffect(() => { fetchPage(1) }, [fetchPage])

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  // Pick display columns from first transaction's canonical fields (exclude internal)
  // Move 'company' to third-from-last position
  const displayCols = (() => {
    if (transactions.length === 0) return []
    const cols = Object.keys(transactions[0].canonicalFields).filter(c => !INTERNAL_COLS.has(c)).slice(0, 8)
    const companyIdx = cols.indexOf('company')
    if (companyIdx !== -1 && cols.length >= 3) {
      cols.splice(companyIdx, 1)
      cols.splice(cols.length - 2, 0, 'company')
    }
    return cols
  })()

  // All column keys: supplier, classification, then dynamic cols
  const allCols = ['__supplier', '__classification', ...displayCols]

  // Column widths state (resizable)
  const defaultWidths: Record<string, number> = { __supplier: 180, __classification: 220 }
  for (const col of displayCols) defaultWidths[col] = 150

  const [colWidths, setColWidths] = useState<Record<string, number>>(defaultWidths)
  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null)

  // Reset widths when columns change
  useEffect(() => {
    const widths: Record<string, number> = { __supplier: 180, __classification: 220 }
    for (const col of displayCols) widths[col] = 150
    setColWidths(widths)
  }, [displayCols.join(',')])

  const onResizeStart = (col: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizingRef.current = { col, startX: e.clientX, startW: colWidths[col] || 150 }

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      const diff = ev.clientX - resizingRef.current.startX
      const newW = Math.max(60, resizingRef.current.startW + diff)
      setColWidths(prev => ({ ...prev, [resizingRef.current!.col]: newW }))
    }
    const onMouseUp = () => {
      resizingRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const colLabel = (col: string) => {
    if (col === '__supplier') return 'Supplier'
    if (col === '__classification') return 'Classification'
    return col.replace(/_/g, ' ')
  }

  const cellValue = (tx: Transaction, col: string) => {
    if (col === '__supplier') return String(tx.canonicalFields.supplier_name ?? '-')
    if (col === '__classification') return tx.classificationPath?.split('|').map(s => s.trim()).join(' > ') ?? '-'
    return String(tx.canonicalFields[col] ?? '-')
  }

  return (
    <div className="border-t border-gray-200 bg-white">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-gray-900 truncate">
            {entry.supplierNames?.[0] || entry.description || 'Affected transactions'}
          </span>
          <span className="text-[10px] text-gray-400 flex-shrink-0">
            {totalCount.toLocaleString()} transaction{totalCount !== 1 ? 's' : ''}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
          <X size={14} />
        </button>
      </div>

      {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}

      {loading && transactions.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-400">Loading...</div>
      ) : (
        <div className="overflow-auto max-h-[300px] border border-gray-200 rounded">
          <table className="text-[11px] border-collapse" style={{ tableLayout: 'fixed', width: allCols.reduce((sum, c) => sum + (colWidths[c] || 150), 0) }}>
            <colgroup>
              {allCols.map(col => (
                <col key={col} style={{ width: colWidths[col] || 150 }} />
              ))}
            </colgroup>
            <thead className="bg-gray-50 sticky top-0">
              <tr className="border-b border-gray-200">
                {allCols.map((col, i) => (
                  <th
                    key={col}
                    className={`relative px-3 py-2 text-left font-semibold text-gray-700 ${i < allCols.length - 1 ? 'border-r border-gray-200' : ''}`}
                    style={{ width: colWidths[col] || 150 }}
                  >
                    <span className="truncate block">{colLabel(col)}</span>
                    {i < allCols.length - 1 && (
                      <div
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/40 z-10"
                        onMouseDown={(e) => onResizeStart(col, e)}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map(tx => (
                <tr key={tx.id} className="border-b border-gray-100 hover:bg-gray-50">
                  {allCols.map((col, i) => (
                    <td
                      key={col}
                      className={`px-3 py-1.5 text-gray-600 truncate ${i < allCols.length - 1 ? 'border-r border-gray-100' : ''}`}
                    >
                      {cellValue(tx, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

export default function VersionHistoryPage() {
  const [entries, setEntries] = useState<ChangeLog[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [taxonomyMap, setTaxonomyMap] = useState<Map<string, string>>(new Map())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null)
  const [supplierDropdownId, setSupplierDropdownId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [viewFilter, setViewFilter] = useState<'all' | 'changes' | 'feedback'>('all')

  // Reset to page 1 when view filter changes
  useEffect(() => { setPage(1) }, [viewFilter])

  // Close supplier dropdown when clicking outside
  useEffect(() => {
    if (!supplierDropdownId) return
    const handleClick = () => setSupplierDropdownId(null)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [supplierDropdownId])

  // Feedback state
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [feedbackText, setFeedbackText] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [recommendation, setRecommendation] = useState<FeedbackRecommendation | null>(null)
  const [applying, setApplying] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const filter: ChangelogFilter = {
        page: p,
        pageSize: PAGE_SIZE,
        viewFilter: viewFilter === 'all' ? undefined : viewFilter,
      }
      const [result, nodes] = await Promise.all([
        ipc.changelog.list(filter),
        ipc.taxonomy.getNodes(),
      ])
      setEntries(result.rows)
      setTotalCount(result.totalCount)
      setTaxonomyMap(new Map(nodes.map(n => [n.id, n.fullPath])))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [viewFilter])

  useEffect(() => { fetchPage(page) }, [fetchPage, page])

  // Client-side search filter (matches supplier names, description, source)
  const filteredEntries = useMemo(() => {
    if (!searchQuery) return entries
    const q = searchQuery.toLowerCase()
    return entries.filter((entry) =>
      entry.description?.toLowerCase().includes(q) ||
      entry.source?.toLowerCase().includes(q) ||
      entry.supplierNames?.some((name) => name.toLowerCase().includes(q))
    )
  }, [entries, searchQuery])

  const handleRevert = async (changeId: string) => {
    setReverting(changeId)
    setError(null)
    try {
      await ipc.changelog.revert(changeId)
      await fetchPage(page)
      if (expandedTxId === changeId) setExpandedTxId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revert')
    } finally {
      setReverting(null)
    }
  }

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleDialogClose = () => {
    setFeedbackDialogOpen(false)
    setSelectedIds(new Set())
    setFeedbackText('')
  }

  const handleAnalyze = async () => {
    if (selectedIds.size === 0 || !feedbackText.trim()) return
    setAnalyzing(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const result = await ipc.feedback.analyze({
        changelogIds: [...selectedIds],
        userFeedback: feedbackText.trim(),
      })
      setFeedbackDialogOpen(false)
      setRecommendation(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  const handleApply = async (edited: FeedbackRecommendation) => {
    setApplying(true)
    setError(null)
    try {
      await ipc.feedback.apply({ recommendation: edited })
      setRecommendation(null)
      setSelectedIds(new Set())
      setFeedbackText('')
      setSuccessMessage('Feedback applied successfully.')
      setTimeout(() => setSuccessMessage(null), 3000)
      await fetchPage(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply feedback')
    } finally {
      setApplying(false)
    }
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Version History</h2>
          <p className="mt-1 text-sm text-gray-500">{totalCount} changes recorded</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewFilter(v => v === 'all' ? 'changes' : v === 'changes' ? 'feedback' : 'all')}
            className={`rounded border px-2 py-1 text-xs font-medium ${
              viewFilter === 'all'
                ? 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                : viewFilter === 'changes'
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-purple-300 bg-purple-50 text-purple-700'
            }`}
          >
            {viewFilter === 'all' ? 'All' : viewFilter === 'changes' ? 'Changes' : 'Feedback'}
          </button>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44"
          />
          <button
            onClick={() => setFeedbackDialogOpen(true)}
            className="rounded border border-blue-600 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
          >
            System Feedback
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {successMessage && <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">{successMessage}</div>}

      {loading ? (
        <div className="flex items-center justify-center p-12">
          <svg className="h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          {searchQuery ? 'No matching changes found.' : 'No changes recorded yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredEntries.map((entry) => {
            const isExpanded = expandedId === entry.id
            const isReverted = entry.isReverted
            const changes = getChangedFields(entry.oldValues, entry.newValues, taxonomyMap)
            const isTxExpanded = expandedTxId === entry.id

            return (
              <div key={entry.id} className="rounded-lg border border-gray-200 bg-white">
                <div
                  className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-gray-50"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`h-2 w-2 flex-shrink-0 rounded-full ${entry.source === 'feedback' ? 'bg-purple-500' : entry.source === 'manual' ? 'bg-blue-500' : 'bg-green-500'}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {entry.description || `${entry.affectedTable} change`}
                        </p>
                        {isReverted && (
                          <span className="flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                            reverted
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                        <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 font-medium ${
                          entry.source === 'feedback' ? 'bg-purple-100 text-purple-700' : entry.source === 'manual' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                        }`}>
                          {entry.source}
                        </span>
                        <span>{entry.affectedCount} {entry.affectedTable === 'transactions' ? 'row' : 'item'}{entry.affectedCount !== 1 ? 's' : ''}</span>
                        {entry.supplierNames && entry.supplierNames.length > 0 && (
                          <span className="relative text-gray-600 font-medium">
                            {entry.supplierNames[0]}
                            {entry.supplierNames.length > 1 && (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSupplierDropdownId(supplierDropdownId === entry.id ? null : entry.id)
                                  }}
                                  className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-blue-600 hover:bg-blue-50 hover:text-blue-800"
                                >
                                  +{entry.supplierNames.length - 1}
                                </button>
                                {supplierDropdownId === entry.id && (
                                  <div className="absolute left-0 top-full mt-1 z-20 rounded border border-gray-200 bg-white shadow-lg py-1 min-w-[180px]">
                                    {entry.supplierNames.map((name) => (
                                      <div key={name} className="px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 truncate">
                                        {name}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </span>
                        )}
                        <span className="text-gray-400">
                          {new Date(entry.createdAt.replace(' ', 'T')).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Revert is only available for manual/classification transaction changes.
                      Feedback changes store nested value structures (e.g. { descriptions: { path: val } })
                      that don't map to flat column→value pairs, so the generic SQL revert cannot handle them. */}
                  {entry.affectedTable === 'transactions' && entry.source !== 'feedback' && (
                      isReverted ? (
                        <span className="rounded px-2 py-1 text-xs text-gray-400 italic">reverted</span>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRevert(entry.id)
                          }}
                          disabled={reverting === entry.id}
                          className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                        >
                          {reverting === entry.id ? 'Reverting...' : 'Revert'}
                        </button>
                      )
                    )}
                    <svg className={`h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {/* Supplier info for classification changes */}
                    {entry.supplierNames && entry.supplierNames.length > 0 && (
                      <div className="mb-2 text-xs text-gray-600">
                        <span className="font-medium">Supplier{entry.supplierNames.length > 1 ? 's' : ''}:</span>{' '}
                        {entry.supplierNames.join(', ')}
                      </div>
                    )}

                    {/* Special layout for taxonomy description feedback */}
                    {entry.source === 'feedback' && entry.affectedTable === 'taxonomy' && entry.oldValues?.descriptions && entry.newValues?.descriptions ? (
                      <div className="space-y-3">
                        {Object.keys(entry.newValues.descriptions as Record<string, string>).map((nodePath) => {
                          const oldDesc = (entry.oldValues!.descriptions as Record<string, string | null>)[nodePath]
                          const newDesc = (entry.newValues!.descriptions as Record<string, string>)[nodePath]
                          return (
                            <div key={nodePath} className="rounded border border-gray-200 p-3">
                              <p className="text-xs font-semibold text-gray-800 mb-2">
                                {nodePath.replace(/\|/g, ' > ')}
                              </p>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <p className="text-[10px] font-medium text-gray-500 uppercase mb-1">Before</p>
                                  <p className="text-xs text-red-700 bg-red-50 rounded p-2 leading-relaxed">
                                    {oldDesc || <span className="italic text-gray-400">No description</span>}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-medium text-gray-500 uppercase mb-1">After</p>
                                  <p className="text-xs text-green-700 bg-green-50 rounded p-2 leading-relaxed">
                                    {newDesc}
                                  </p>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : entry.source === 'feedback' && entry.affectedTable === 'project_settings' && entry.oldValues?.priorities && entry.newValues?.priorities ? (
                      /* Column priorities feedback */
                      <div className="rounded border border-gray-200 p-3">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-[10px] font-medium text-gray-500 uppercase mb-2">Before</p>
                            <ol className="list-decimal list-inside space-y-1">
                              {(entry.oldValues.priorities as string[]).map((col, i) => (
                                <li key={i} className="text-xs text-red-700 bg-red-50 rounded px-2 py-1">
                                  {humanizeField(col)}
                                </li>
                              ))}
                            </ol>
                          </div>
                          <div>
                            <p className="text-[10px] font-medium text-gray-500 uppercase mb-2">After</p>
                            <ol className="list-decimal list-inside space-y-1">
                              {(entry.newValues.priorities as string[]).map((col, i) => (
                                <li key={i} className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">
                                  {humanizeField(col)}
                                </li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      </div>
                    ) : entry.source === 'feedback' && entry.affectedTable === 'override_rules' && entry.newValues?.name ? (
                      /* Create rule feedback */
                      <div className="rounded border border-gray-200 p-3 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-medium text-gray-500 uppercase">Rule Name</span>
                          <span className="text-xs font-semibold text-gray-800">{entry.newValues.name as string}</span>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-gray-500 uppercase mb-1">Target Classification</p>
                          <p className="text-xs text-green-700 bg-green-50 rounded px-2 py-1 inline-block">
                            {(entry.newValues.targetPath as string).replace(/\|/g, ' > ')}
                          </p>
                        </div>
                        {entry.newValues.conditions && Array.isArray(entry.newValues.conditions) && (
                          <div>
                            <p className="text-[10px] font-medium text-gray-500 uppercase mb-1">Conditions</p>
                            <div className="space-y-1">
                              {(entry.newValues.conditions as Array<{ field: string; operator: string; value: string }>).map((cond, i) => (
                                <div key={i} className="text-xs bg-gray-50 rounded px-2 py-1 flex items-center gap-1">
                                  <span className="font-medium text-gray-700">{humanizeField(cond.field)}</span>
                                  <span className="text-gray-500">{cond.operator}</span>
                                  <span className="text-gray-900">"{cond.value}"</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : changes.length > 0 ? (
                      <table className="w-full text-xs table-fixed">
                        <colgroup>
                          <col className="w-1/5" />
                          <col className="w-2/5" />
                          <col className="w-2/5" />
                        </colgroup>
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="pb-1.5 pr-4 font-medium">Field</th>
                            <th className="pb-1.5 pr-4 font-medium">Before</th>
                            <th className="pb-1.5 font-medium">After</th>
                          </tr>
                        </thead>
                        <tbody className="text-gray-700">
                          {changes.map((c) => (
                            <tr key={c.field}>
                              <td className="py-1 pr-4 font-medium text-gray-600 align-top">{c.field}</td>
                              <td className="py-1 pr-4 align-top break-words">
                                <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{c.from}</span>
                              </td>
                              <td className="py-1 align-top break-words">
                                <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">{c.to}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-xs text-gray-500 italic">No detailed changes available.</p>
                    )}

                    {/* Expandable transaction details — same style as DrillDownPanel */}
                    {entry.affectedTable === 'transactions' && entry.affectedIds.length > 0 && (
                      <div className="mt-3 border-t border-gray-100 pt-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpandedTxId(isTxExpanded ? null : entry.id)
                          }}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          <svg
                            className={`h-3.5 w-3.5 transition-transform ${isTxExpanded ? 'rotate-90' : ''}`}
                            viewBox="0 0 20 20"
                            fill="currentColor"
                          >
                            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                          </svg>
                          {entry.affectedCount} transaction{entry.affectedCount !== 1 ? 's' : ''} affected
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Full transaction table panel (rendered outside the expandable details) */}
                {isTxExpanded && (
                  <ChangeTransactionPanel
                    entry={entry}
                    onClose={() => setExpandedTxId(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-2">
          <span className="text-xs text-gray-500">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded p-1 hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded p-1 hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Recommendation modal */}
      {recommendation && (
        <SystemFeedbackModal
          recommendation={recommendation}
          onClose={() => setRecommendation(null)}
          onApply={handleApply}
          applying={applying}
        />
      )}

      <SystemFeedbackDialog
        isOpen={feedbackDialogOpen}
        onClose={handleDialogClose}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        feedbackText={feedbackText}
        onFeedbackChange={setFeedbackText}
        onAnalyze={handleAnalyze}
        analyzing={analyzing}
      />
    </div>
  )
}
