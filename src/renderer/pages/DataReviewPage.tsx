import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import StatsCards from '../components/data-review/StatsCards'
import SupplierTable from '../components/data-review/SupplierTable'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import { useWorkflowState } from '../contexts/WorkflowStateContext'
import type { TransactionStats } from '../../shared/types/transactions'
import type { ProjectSupplier } from '../../shared/types/suppliers'

export default function DataReviewPage() {
  const [stats, setStats] = useState<TransactionStats | null>(null)
  const [suppliers, setSuppliers] = useState<ProjectSupplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const markDataReviewed = useWorkflowStore((s) => s.markDataReviewed)
  const ws = useWorkflowState()

  const canProceedToClassification = ws.hasCanonicalizedData && ws.hasTaxonomy

  const handleNext = () => {
    markDataReviewed()
    navigate('/workflow/classification')
  }

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, sup] = await Promise.all([
        ipc.transactions.stats(),
        ipc.suppliers.list(),
      ])
      setStats(s)
      setSuppliers(sup)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

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

      {/* Next step button */}
      <div className="flex justify-end pt-2">
        <button
          onClick={handleNext}
          disabled={!canProceedToClassification}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
          title={!canProceedToClassification ? 'Requires canonicalized data and taxonomy' : ''}
        >
          Next: Classification
          <ArrowRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
