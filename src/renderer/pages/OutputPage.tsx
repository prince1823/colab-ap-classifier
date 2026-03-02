import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { ipc } from '../lib/ipc'
import type { TransactionStats } from '../../shared/types/transactions'
import { fmtAbbrev } from '../utils/formatSpend'

interface ClassificationBreakdown {
  path: string
  displayPath: string
  count: number
  spend: number
}

export default function OutputPage() {
  const location = useLocation()
  const [stats, setStats] = useState<TransactionStats | null>(null)
  const [breakdown, setBreakdown] = useState<ClassificationBreakdown[]>([])
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      // Fetch stats and transactions in parallel
      const [s, transactions] = await Promise.all([
        ipc.transactions.stats(),
        ipc.transactions.query(),
      ])
      setStats(s)

      // Build classification breakdown from transactions
      const groups = new Map<string, { count: number; spend: number }>()
      for (const t of transactions) {
        const path = t.classificationPath || 'Unclassified'
        const existing = groups.get(path) || { count: 0, spend: 0 }
        existing.count += 1
        const spend = t.canonicalFields?.spend_amount
        if (spend != null) {
          const num = typeof spend === 'number' ? spend : parseFloat(String(spend))
          if (!isNaN(num)) existing.spend += num
        }
        groups.set(path, existing)
      }

      const breakdownList: ClassificationBreakdown[] = Array.from(groups.entries())
        .map(([path, data]) => ({
          path,
          displayPath: path === 'Unclassified' ? 'Unclassified' : path.replace(/\|/g, ' → '),
          count: data.count,
          spend: data.spend,
        }))
        .sort((a, b) => b.spend - a.spend)

      setBreakdown(breakdownList)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-fetch every time this page is navigated to
  useEffect(() => {
    loadData()
  }, [location.key, loadData])

  const handleExport = async () => {
    setExporting(true)
    setExported(false)
    setError(null)
    try {
      const filePath = await ipc.export.selectPath()
      if (!filePath) {
        setExporting(false)
        return
      }
      await ipc.export.export(filePath)
      setExported(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Export</h2>
          <p className="mt-1 text-sm text-gray-500">Export your classified transaction data to CSV.</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}
      {exported && (
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
          Data exported successfully!
        </div>
      )}

      {loading && (
        <div className="text-sm text-gray-500">Loading stats...</div>
      )}

      {stats && !loading && (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-700">Export Summary</h3>
              <button
                onClick={loadData}
                className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
              >
                Refresh
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-gray-500">Total Rows</p>
                <p className="text-lg font-semibold text-gray-900">{stats.totalRows.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Classified</p>
                <p className="text-lg font-semibold text-gray-900">{stats.classifiedRows.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Total Spend</p>
                <p className="text-lg font-semibold text-gray-900">
                  {fmtAbbrev(stats.totalSpend)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Suppliers</p>
                <p className="text-lg font-semibold text-gray-900">{stats.uniqueSuppliers.toLocaleString()}</p>
              </div>
            </div>
          </div>

          {breakdown.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h3 className="mb-4 text-sm font-medium text-gray-700">Classification Breakdown</h3>
              <div className="overflow-hidden rounded-md border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Classification Path</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Rows</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Spend</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">% of Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {breakdown.map((item) => (
                      <tr key={item.path} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-sm text-gray-900">
                          {item.path === 'Unclassified' ? (
                            <span className="italic text-gray-400">Unclassified</span>
                          ) : (
                            item.displayPath
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-sm text-gray-700">{item.count.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-sm text-gray-700">
                          {fmtAbbrev(item.spend)}
                        </td>
                        <td className="px-4 py-2 text-right text-sm text-gray-700">
                          {stats.totalSpend > 0 ? ((item.spend / stats.totalSpend) * 100).toFixed(1) : '0.0'}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleExport}
          disabled={exporting || loading}
          className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>
    </div>
  )
}
