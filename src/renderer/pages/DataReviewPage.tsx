import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import StatsCards from '../components/data-review/StatsCards'
import SupplierTable from '../components/data-review/SupplierTable'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { TransactionStats } from '../../shared/types/transactions'
import type { ProjectSupplierView } from '../../shared/types/suppliers'

export default function DataReviewPage() {
  const navigate = useNavigate()
  const projectFilePath = useWorkflowStore((s) => s.projectFilePath)
  const totalRows = useWorkflowStore((s) => s.totalRows)
  const classifiedRows = useWorkflowStore((s) => s.classifiedRows)
  const confirmedSupplierCount = useWorkflowStore((s) => s.confirmedSupplierCount)

  const [stats, setStats] = useState<TransactionStats | null>(null)
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [taxonomyNodeCount, setTaxonomyNodeCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!projectFilePath) return
    setLoading(true)
    setError(null)
    try {
      const [s, sup, nodeCount] = await Promise.all([
        ipc.transactions.stats(),
        ipc.suppliers.list(),
        ipc.taxonomy.getNodeCount(),
      ])
      setStats(s)
      setSuppliers(sup)
      setTaxonomyNodeCount(nodeCount)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [projectFilePath])

  useEffect(() => {
    if (!projectFilePath) {
      setStats(null)
      setSuppliers([])
      setTaxonomyNodeCount(0)
      return
    }
    loadData()
  }, [projectFilePath, totalRows, classifiedRows, confirmedSupplierCount, loadData])

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

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button onClick={loadData} className="ml-2 font-medium underline">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Data Review</h2>
        <p className="mt-1 text-sm text-gray-500">
          Review uploaded data, manage suppliers, and view spend distribution.
        </p>
      </div>

      {stats && <StatsCards stats={stats} />}

      <div>
        <h3 className="mb-3 text-sm font-medium text-gray-700">Suppliers</h3>
        <SupplierTable suppliers={suppliers} onUpdated={loadData} />
      </div>

      {/* Next step */}
      <div className="flex items-center justify-between border-t border-gray-200 pt-4">
        <div className="text-xs text-gray-500">
          {taxonomyNodeCount === 0 && (
            <span>
              Import a taxonomy via{' '}
              <button onClick={() => navigate('/taxonomy')} className="font-medium text-blue-600 hover:underline">
                Project Setup → Taxonomy
              </button>{' '}
              to enable classification.
            </span>
          )}
        </div>
        <button
          onClick={() => navigate('/classification')}
          disabled={taxonomyNodeCount === 0}
          className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
        >
          Next: Classification →
        </button>
      </div>
    </div>
  )
}
