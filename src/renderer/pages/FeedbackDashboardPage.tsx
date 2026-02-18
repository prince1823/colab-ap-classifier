import { useState, useEffect, useCallback } from 'react'
import { ipc } from '../lib/ipc'
import type { SystemFeedback, FeedbackType, FeedbackActionDetails } from '../../shared/types/feedback'
import {
  CheckCircle,
  X,
  Edit2,
  FileText,
  Building2,
  List,
  AlertCircle,
  Sparkles,
  RefreshCw,
} from 'lucide-react'

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected'

export default function FeedbackDashboardPage() {
  const [feedback, setFeedback] = useState<SystemFeedback[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  const loadFeedback = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const items = await ipc.feedback.list()
      setFeedback(items)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feedback')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadFeedback()
  }, [loadFeedback])

  const handleApprove = async (item: SystemFeedback) => {
    setActionInProgress(item.id)
    try {
      await ipc.feedback.approve(item.id)
      setFeedback((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'approved' as const } : f)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve')
    } finally {
      setActionInProgress(null)
    }
  }

  const handleReject = async (item: SystemFeedback) => {
    setActionInProgress(item.id)
    try {
      await ipc.feedback.reject(item.id)
      setFeedback((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'rejected' as const } : f)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject')
    } finally {
      setActionInProgress(null)
    }
  }

  const handleApproveWithEdit = async (item: SystemFeedback) => {
    if (!editText.trim()) return
    setActionInProgress(item.id)
    try {
      // Build modifications based on feedback type
      let modifications: Partial<FeedbackActionDetails> = {}
      if (item.feedbackType === 'company_context') {
        modifications = { proposedValue: editText } as Partial<FeedbackActionDetails>
      } else if (item.feedbackType === 'taxonomy_description') {
        modifications = { proposedDescription: editText } as Partial<FeedbackActionDetails>
      }
      await ipc.feedback.approve(item.id, modifications)
      setFeedback((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'approved' as const } : f)))
      setEditingId(null)
      setEditText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve')
    } finally {
      setActionInProgress(null)
    }
  }

  const filtered = feedback.filter((f) => statusFilter === 'all' || f.status === statusFilter)

  const pendingCount = feedback.filter((f) => f.status === 'pending').length
  const approvedCount = feedback.filter((f) => f.status === 'approved').length
  const rejectedCount = feedback.filter((f) => f.status === 'rejected').length

  const getTypeIcon = (type: FeedbackType) => {
    switch (type) {
      case 'taxonomy_description':
        return <FileText className="h-4 w-4" />
      case 'company_context':
        return <Building2 className="h-4 w-4" />
      case 'supplier_rule':
        return <List className="h-4 w-4" />
      case 'uncategorized_feedback':
        return <AlertCircle className="h-4 w-4" />
    }
  }

  const getTypeLabel = (type: FeedbackType) => {
    switch (type) {
      case 'taxonomy_description':
        return 'Taxonomy Description'
      case 'company_context':
        return 'Company Context'
      case 'supplier_rule':
        return 'Supplier Rule'
      case 'uncategorized_feedback':
        return 'Uncategorized'
    }
  }

  const getSuggestionSummary = (item: SystemFeedback): string => {
    const s = item.suggestion
    if (item.feedbackType === 'company_context' && 'fieldName' in s) {
      return `Change ${s.fieldName}: "${s.currentValue}" → "${s.proposedValue}"`
    }
    if (item.feedbackType === 'taxonomy_description' && 'taxonomyPath' in s) {
      return `Update description for ${s.taxonomyPath}`
    }
    if (item.feedbackType === 'supplier_rule' && 'supplierName' in s) {
      return `Create rule for ${s.supplierName} → ${s.classificationPaths.join(', ')}`
    }
    if (item.feedbackType === 'uncategorized_feedback' && 'issueType' in s) {
      return s.description
    }
    return 'Feedback suggestion'
  }

  const getEditableValue = (item: SystemFeedback): string => {
    const s = item.suggestion
    if (item.feedbackType === 'company_context' && 'proposedValue' in s) return s.proposedValue
    if (item.feedbackType === 'taxonomy_description' && 'proposedDescription' in s) return s.proposedDescription
    if (item.feedbackType === 'uncategorized_feedback' && 'suggestedFix' in s) return s.suggestedFix
    return ''
  }

  // Group by type
  const grouped = filtered.reduce<Record<string, SystemFeedback[]>>((acc, item) => {
    const key = item.feedbackType
    if (!acc[key]) acc[key] = []
    acc[key].push(item)
    return acc
  }, {})

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Feedback Dashboard</h2>
          <p className="mt-1 text-sm text-gray-500">
            Review AI-generated suggestions for improving taxonomy, rules, and company context.
          </p>
        </div>
        <button
          onClick={loadFeedback}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <button
          onClick={() => setStatusFilter('all')}
          className={`rounded-lg border p-4 text-left transition-colors ${statusFilter === 'all' ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <p className="text-xs text-gray-500">Total</p>
          <p className="text-2xl font-semibold text-gray-900">{feedback.length}</p>
        </button>
        <button
          onClick={() => setStatusFilter('pending')}
          className={`rounded-lg border p-4 text-left transition-colors ${statusFilter === 'pending' ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <p className="text-xs text-gray-500">Pending</p>
          <p className="text-2xl font-semibold text-yellow-600">{pendingCount}</p>
        </button>
        <button
          onClick={() => setStatusFilter('approved')}
          className={`rounded-lg border p-4 text-left transition-colors ${statusFilter === 'approved' ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <p className="text-xs text-gray-500">Approved</p>
          <p className="text-2xl font-semibold text-green-600">{approvedCount}</p>
        </button>
        <button
          onClick={() => setStatusFilter('rejected')}
          className={`rounded-lg border p-4 text-left transition-colors ${statusFilter === 'rejected' ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <p className="text-xs text-gray-500">Rejected</p>
          <p className="text-2xl font-semibold text-red-600">{rejectedCount}</p>
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
          <Sparkles className="mx-auto h-10 w-10 text-gray-300" />
          <h3 className="mt-3 text-sm font-medium text-gray-700">
            {feedback.length === 0 ? 'No feedback yet' : `No ${statusFilter} feedback`}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            {feedback.length === 0
              ? 'Feedback is generated when you reclassify transactions with feedback enabled.'
              : 'Try a different filter to see other feedback items.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type} className="rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                {getTypeIcon(type as FeedbackType)}
                <h3 className="text-sm font-medium text-gray-700">{getTypeLabel(type as FeedbackType)}</h3>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{items.length}</span>
              </div>
              <div className="divide-y divide-gray-100">
                {items.map((item) => (
                  <div key={item.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-800">{getSuggestionSummary(item)}</p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                          <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                          {item.affectedTransactionIds && (
                            <span>{item.affectedTransactionIds.length} affected row{item.affectedTransactionIds.length !== 1 ? 's' : ''}</span>
                          )}
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              item.status === 'pending'
                                ? 'bg-yellow-100 text-yellow-700'
                                : item.status === 'approved'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>

                        {/* Edit area */}
                        {editingId === item.id && (
                          <div className="mt-2 space-y-2">
                            <textarea
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              rows={3}
                              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleApproveWithEdit(item)}
                                disabled={actionInProgress === item.id}
                                className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                              >
                                <CheckCircle className="h-3 w-3" />
                                Approve with edits
                              </button>
                              <button
                                onClick={() => { setEditingId(null); setEditText('') }}
                                className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      {item.status === 'pending' && editingId !== item.id && (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => { setEditingId(item.id); setEditText(getEditableValue(item)) }}
                            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                            title="Edit before approving"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleApprove(item)}
                            disabled={actionInProgress === item.id}
                            className="rounded p-1.5 text-green-500 hover:bg-green-50 hover:text-green-700 disabled:opacity-50"
                            title="Approve"
                          >
                            <CheckCircle className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleReject(item)}
                            disabled={actionInProgress === item.id}
                            className="rounded p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                            title="Reject"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
