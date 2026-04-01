import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { ChangeLog } from '../../../shared/types/changelog'

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

  const handleRevert = async (changeId: string) => {
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

  const allReverted = entries.length > 0 && entries.every(e => e.isReverted)

  const handleClose = () => {
    onClose(allReverted)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Deactivate Rule</h2>
            <p className="text-xs text-gray-500 mt-0.5">{ruleName}</p>
          </div>
          <button onClick={handleClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
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
              <p className="text-xs text-gray-600 mb-3">
                The following transaction sets were classified by this rule. You can revert them before deactivating.
              </p>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`rounded-lg border px-4 py-3 ${
                    entry.isReverted
                      ? 'border-gray-200 bg-gray-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium ${entry.isReverted ? 'text-gray-400' : 'text-gray-800'}`}>
                        {entry.description || `${entry.affectedCount} transaction(s)`}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-gray-400">
                          {entry.affectedCount} txn{entry.affectedCount !== 1 ? 's' : ''}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {new Date(entry.createdAt.replace(' ', 'T')).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex-shrink-0 ml-3">
                      {entry.isReverted ? (
                        <span className="rounded px-2 py-1 text-[10px] text-gray-400 italic bg-gray-100">
                          Reverted
                        </span>
                      ) : (
                        <button
                          onClick={() => handleRevert(entry.id)}
                          disabled={reverting === entry.id}
                          className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                        >
                          {reverting === entry.id ? 'Reverting...' : 'Revert'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
          <p className="text-[10px] text-gray-400">
            {allReverted
              ? 'All transactions reverted.'
              : entries.filter(e => !e.isReverted).length > 0
                ? `${entries.filter(e => !e.isReverted).length} set(s) not yet reverted.`
                : ''}
          </p>
          <button
            onClick={handleClose}
            className="rounded-md bg-gray-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
          >
            {allReverted ? 'Deactivate Rule' : 'Deactivate Anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}
