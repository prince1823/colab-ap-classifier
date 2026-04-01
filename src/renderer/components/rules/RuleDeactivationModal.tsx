import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { ChangeLog } from '../../../shared/types/changelog'
import type { Transaction } from '../../../shared/types/transactions'

const TX_PAGE_SIZE = 20

const INTERNAL_COLS = new Set([
  'id', 'row_index', 'upload_id', 'taxonomy_node_id',
  'classification_status', 'human_reviewed',
  'flagged_for_review', 'applied_rule_id', 'applied_rule_name',
  'project_supplier_id', 'original_supplier_name',
  'created_at', 'updated_at',
])

interface Props {
  ruleId: string
  ruleName: string
  onClose: (allReverted: boolean) => void
}

export default function RuleDeactivationModal({ ruleId, ruleName, onClose }: Props) {
  const [entries, setEntries] = useState<ChangeLog[]>([])
  const [loading, setLoading] = useState(true)
  const [reverting, setReverting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null) // changeId to confirm
  const [confirmRevertAll, setConfirmRevertAll] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)

  const fetchEntries = useCallback(async () => {
    try {
      const result = await ipc.changelog.listByRule(ruleId)
      setEntries(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load changes')
    } finally {
      setLoading(false)
    }
  }, [ruleId])

  useEffect(() => { fetchEntries() }, [fetchEntries])

  const executeRevert = async (changeId: string) => {
    setConfirmRevert(null)
    setReverting(changeId)
    setError(null)
    try {
      await ipc.changelog.revert(changeId)
      await fetchEntries()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revert')
    } finally {
      setReverting(null)
    }
  }

  const executeRevertAll = async () => {
    setConfirmRevertAll(false)
    const unrevertedEntries = entries.filter(e => !e.isReverted)
    if (unrevertedEntries.length === 0) return
    setError(null)
    for (const entry of unrevertedEntries) {
      setReverting(entry.id)
      try {
        await ipc.changelog.revert(entry.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to revert some changes')
        setReverting(null)
        await fetchEntries()
        return
      }
    }
    setReverting(null)
    await fetchEntries()
  }

  const handleDeactivateClick = () => {
    if (allReverted) {
      onClose(true)
    } else {
      setConfirmDeactivate(true)
    }
  }

  const allReverted = entries.length > 0 && entries.every(e => e.isReverted)
  const unrevertedCount = entries.filter(e => !e.isReverted).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Deactivate Rule</h2>
            <p className="text-xs text-gray-500 mt-0.5">{ruleName}</p>
          </div>
          <button onClick={() => onClose(allReverted)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {error && (
            <div className="mb-3 rounded-md bg-red-50 p-3 text-xs text-red-700">{error}</div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <svg className="h-6 w-6 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : entries.length === 0 ? (
            <p className="text-center text-xs text-gray-500 py-8">
              No transactions are currently classified by this rule.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-gray-600">
                  The following transaction sets were classified by this rule. Revert to undo classifications before deactivating.
                </p>
                {unrevertedCount > 1 && (
                  <button
                    onClick={() => setConfirmRevertAll(true)}
                    disabled={reverting !== null}
                    className="flex-shrink-0 ml-3 rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                  >
                    Revert All ({unrevertedCount})
                  </button>
                )}
              </div>
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  reverting={reverting}
                  onRevert={(changeId) => setConfirmRevert(changeId)}
                  expanded={expandedEntryId === entry.id}
                  onToggleExpand={() => setExpandedEntryId(prev => prev === entry.id ? null : entry.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4 flex-shrink-0">
          <p className="text-[10px] text-gray-400">
            {allReverted
              ? 'All transactions reverted — rule will be marked fully reverted.'
              : unrevertedCount > 0
                ? `${unrevertedCount} set(s) not yet reverted — rule will be marked partially reverted.`
                : ''}
          </p>
          <button
            onClick={handleDeactivateClick}
            className="rounded-md bg-gray-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
          >
            {allReverted ? 'Deactivate Rule' : 'Deactivate Anyway'}
          </button>
        </div>

        {/* ── Confirmation: Revert single set ── */}
        {confirmRevert && (
          <ConfirmDialog
            title="Revert transactions?"
            message="This will undo the classifications made by this rule. Past classifications will be removed and transactions will return to their previous state. This action cannot be undone."
            confirmLabel="Revert"
            confirmClassName="bg-red-600 hover:bg-red-700"
            onConfirm={() => executeRevert(confirmRevert)}
            onCancel={() => setConfirmRevert(null)}
          />
        )}

        {/* ── Confirmation: Revert all sets ── */}
        {confirmRevertAll && (
          <ConfirmDialog
            title="Revert all transactions?"
            message={`This will undo all ${unrevertedCount} set(s) of classifications made by this rule. Past classifications will be removed and transactions will return to their previous state. This action cannot be undone.`}
            confirmLabel="Revert All"
            confirmClassName="bg-red-600 hover:bg-red-700"
            onConfirm={executeRevertAll}
            onCancel={() => setConfirmRevertAll(false)}
          />
        )}

        {/* ── Confirmation: Deactivate without revert ── */}
        {confirmDeactivate && (
          <ConfirmDialog
            title="Deactivate without reverting?"
            message="The rule will stop applying to new data, but past classifications will remain. Transactions already classified by this rule will keep their current classification."
            confirmLabel="Deactivate Anyway"
            confirmClassName="bg-gray-800 hover:bg-gray-700"
            onConfirm={() => { setConfirmDeactivate(false); onClose(false) }}
            onCancel={() => setConfirmDeactivate(false)}
          />
        )}
      </div>
    </div>
  )
}


/* ── Entry row with expandable transaction panel ─────────────── */

function EntryRow({
  entry,
  reverting,
  onRevert,
  expanded,
  onToggleExpand,
}: {
  entry: ChangeLog
  reverting: string | null
  onRevert: (changeId: string) => void
  expanded: boolean
  onToggleExpand: () => void
}) {
  return (
    <div
      className={`rounded-lg border ${
        entry.isReverted
          ? 'border-gray-200 bg-gray-50'
          : 'border-gray-200 bg-white'
      }`}
    >
      {/* Entry header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
            : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          }
          <div className="min-w-0">
            <p className={`text-xs font-medium ${entry.isReverted ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
              {entry.description || `${entry.affectedCount} transaction(s)`}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-gray-400">
                {entry.affectedCount} txn{entry.affectedCount !== 1 ? 's' : ''}
              </span>
              {entry.supplierNames && entry.supplierNames.length > 0 && (
                <span className="text-[10px] text-gray-400">
                  {entry.supplierNames.slice(0, 3).join(', ')}
                  {entry.supplierNames.length > 3 && ` +${entry.supplierNames.length - 3}`}
                </span>
              )}
              <span className="text-[10px] text-gray-400">
                {new Date(entry.createdAt.replace(' ', 'T')).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 ml-3" onClick={(e) => e.stopPropagation()}>
          {entry.isReverted ? (
            <span className="rounded px-2 py-1 text-[10px] text-gray-400 italic bg-gray-100">
              Reverted
            </span>
          ) : (
            <button
              onClick={() => onRevert(entry.id)}
              disabled={reverting === entry.id}
              className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
            >
              {reverting === entry.id ? 'Reverting...' : 'Revert Set'}
            </button>
          )}
        </div>
      </div>

      {/* Expanded transaction panel */}
      {expanded && (
        <TransactionPanel entry={entry} />
      )}
    </div>
  )
}


/* ── Transaction drill-down panel ──────────────────────────── */

function TransactionPanel({ entry }: { entry: ChangeLog }) {
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
        pageSize: TX_PAGE_SIZE,
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

  const totalPages = Math.ceil(totalCount / TX_PAGE_SIZE)

  // Pick display columns from canonical fields
  const displayCols = (() => {
    if (transactions.length === 0) return []
    return Object.keys(transactions[0].canonicalFields)
      .filter(c => !INTERNAL_COLS.has(c))
      .slice(0, 6)
  })()

  const allCols = ['__supplier', '__classification', ...displayCols]

  const colWidthsRef = useRef<Record<string, number>>({})
  if (Object.keys(colWidthsRef.current).length === 0 || displayCols.length > 0) {
    const w: Record<string, number> = { __supplier: 160, __classification: 200 }
    for (const col of displayCols) w[col] = 140
    colWidthsRef.current = w
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
    <div className="border-t border-gray-200 bg-gray-50/50">
      {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}

      {loading && transactions.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-gray-400">Loading transactions...</div>
      ) : transactions.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-gray-400">No transactions found.</div>
      ) : (
        <div className="overflow-auto max-h-[250px]">
          <table className="w-full text-[11px] border-collapse" style={{ tableLayout: 'fixed', width: allCols.reduce((sum, c) => sum + (colWidthsRef.current[c] || 140), 0) }}>
            <colgroup>
              {allCols.map(col => (
                <col key={col} style={{ width: colWidthsRef.current[col] || 140 }} />
              ))}
            </colgroup>
            <thead className="bg-gray-100 sticky top-0">
              <tr className="border-b border-gray-200">
                {allCols.map((col) => (
                  <th key={col} className="px-3 py-1.5 text-left font-semibold text-gray-600 border-r border-gray-200 last:border-r-0">
                    <span className="truncate block capitalize">{colLabel(col)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map(tx => (
                <tr key={tx.id} className="border-b border-gray-100 hover:bg-white/80">
                  {allCols.map((col) => (
                    <td key={col} className="px-3 py-1.5 text-gray-600 truncate border-r border-gray-100 last:border-r-0">
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
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-200 text-[10px] text-gray-500">
          <span>Page {page} of {totalPages} ({totalCount} transactions)</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => fetchPage(page - 1)}
              disabled={page <= 1 || loading}
              className="p-0.5 rounded hover:bg-gray-200 disabled:opacity-30"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              onClick={() => fetchPage(page + 1)}
              disabled={page >= totalPages || loading}
              className="p-0.5 rounded hover:bg-gray-200 disabled:opacity-30"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


/* ── Confirmation dialog ───────────────────────────────────── */

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmClassName,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  confirmClassName: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-xs text-gray-600 leading-relaxed mb-5">{message}</p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${confirmClassName}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
