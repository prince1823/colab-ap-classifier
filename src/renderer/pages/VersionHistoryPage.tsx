import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import type { ChangeLog } from '../../shared/types/changelog'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

/** Friendly labels for known fields */
const FIELD_LABELS: Record<string, string> = {
  taxonomy_node_id: 'Classification',
  classification_status: 'Classification Status',
  status: 'Status',
  suggestion: 'Suggestion',
}

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
    // Check if it's a UUID and try to resolve from taxonomy
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

export default function VersionHistoryPage() {
  const [entries, setEntries] = useState<ChangeLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)
  const [taxonomyMap, setTaxonomyMap] = useState<Map<string, string>>(new Map())

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [data, nodes] = await Promise.all([
        ipc.changelog.list(),
        ipc.taxonomy.getNodes(),
      ])
      setEntries(data)
      setTaxonomyMap(new Map(nodes.map(n => [n.id, n.fullPath])))
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
        <div className="space-y-2">
          {entries.map((entry) => {
            const isExpanded = expandedId === entry.id
            const changes = getChangedFields(entry.oldValues, entry.newValues, taxonomyMap)
            return (
              <div key={entry.id} className="rounded-lg border border-gray-200 bg-white">
                <div
                  className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-gray-50"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`h-2 w-2 flex-shrink-0 rounded-full ${entry.source === 'manual' ? 'bg-blue-500' : 'bg-green-500'}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {entry.description || `${entry.affectedTable} change`}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                        <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 font-medium ${
                          entry.source === 'manual' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                        }`}>
                          {entry.source}
                        </span>
                        <span>{entry.affectedCount} row{entry.affectedCount !== 1 ? 's' : ''}</span>
                        <span className="text-gray-400">
                          {new Date(entry.createdAt.replace(' ', 'T')).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {entry.description?.startsWith('Reverted:') ? (
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
                    )}
                    <svg className={`h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {changes.length > 0 ? (
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
