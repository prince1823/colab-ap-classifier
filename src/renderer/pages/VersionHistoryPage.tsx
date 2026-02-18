import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import type { ChangeLog } from '../../shared/types/changelog'

export default function VersionHistoryPage() {
  const [entries, setEntries] = useState<ChangeLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await ipc.changelog.list()
      setEntries(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const handleRevert = async (changeId: string) => {
    setReverting(changeId)
    setError(null)
    try {
      await ipc.changelog.revert(changeId)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revert')
    } finally {
      setReverting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Version History</h2>
        <p className="mt-1 text-sm text-gray-500">{entries.length} changes recorded</p>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {entries.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          No changes recorded yet.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const isExpanded = expandedId === entry.id
            return (
              <div key={entry.id} className="rounded-lg border border-gray-200 bg-white">
                <div
                  className="flex cursor-pointer items-center justify-between p-4 hover:bg-gray-50"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className={`h-2 w-2 rounded-full ${entry.source === 'manual' ? 'bg-blue-500' : 'bg-green-500'}`} />
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {entry.description || `${entry.affectedTable} change`}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                        <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
                          entry.source === 'manual' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                        }`}>
                          {entry.source}
                        </span>
                        <span>{entry.affectedTable}</span>
                        <span>{entry.affectedCount} affected</span>
                        <span>{new Date(entry.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {entry.description?.startsWith('Reverted:') ? (
                      <span className="rounded px-3 py-1 text-xs text-gray-400">Revert entry</span>
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
                    )}
                    <svg className={`h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {entry.oldValues && (
                      <div className="mb-2">
                        <p className="mb-1 text-xs font-medium text-gray-500">Old Values</p>
                        <pre className="rounded bg-gray-50 p-2 text-xs text-gray-700">
                          {JSON.stringify(entry.oldValues, null, 2)}
                        </pre>
                      </div>
                    )}
                    {entry.newValues && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-gray-500">New Values</p>
                        <pre className="rounded bg-gray-50 p-2 text-xs text-gray-700">
                          {JSON.stringify(entry.newValues, null, 2)}
                        </pre>
                      </div>
                    )}
                    {entry.affectedIds.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-gray-500">
                          Affected IDs: {entry.affectedIds.slice(0, 10).join(', ')}
                          {entry.affectedIds.length > 10 && ` (+${entry.affectedIds.length - 10} more)`}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
