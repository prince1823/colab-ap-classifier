import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import type { TransactionStats } from '../../shared/types/transactions'

export default function OutputPage() {
  const [stats, setStats] = useState<TransactionStats | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const s = await ipc.transactions.stats()
        setStats(s)
      } catch {
        // ignore
      }
    }
    load()
  }, [])

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
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Export</h2>
        <p className="mt-1 text-sm text-gray-500">Export your classified transaction data to CSV.</p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}
      {exported && (
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
          Data exported successfully!
        </div>
      )}

      {stats && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-sm font-medium text-gray-700">Export Summary</h3>
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
                ${stats.totalSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Suppliers</p>
              <p className="text-lg font-semibold text-gray-900">{stats.uniqueSuppliers.toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleExport}
          disabled={exporting}
          className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>
    </div>
  )
}
