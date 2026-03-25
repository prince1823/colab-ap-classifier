import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import { showError } from '../../lib/toast-errors'
import type { ChangeLog } from '../../../shared/types/changelog'

interface SystemFeedbackDialogProps {
  isOpen: boolean
  onClose: () => void
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  feedbackText: string
  onFeedbackChange: (text: string) => void
  onAnalyze: () => void
  analyzing: boolean
}

export default function SystemFeedbackDialog({
  isOpen,
  onClose,
  selectedIds,
  onToggleSelect,
  feedbackText,
  onFeedbackChange,
  onAnalyze,
  analyzing,
}: SystemFeedbackDialogProps) {
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<ChangeLog[]>([])
  const [loadingEntries, setLoadingEntries] = useState(false)

  // Self-fetch all entries when dialog opens
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoadingEntries(true)
    ipc.changelog.list({ pageSize: 10000 }).then(result => {
      if (!cancelled) {
        setEntries(result.rows)
        setLoadingEntries(false)
      }
    }).catch((e) => {
      if (!cancelled) {
        setLoadingEntries(false)
        showError('Failed to load changelog', e)
      }
    })
    return () => { cancelled = true }
  }, [isOpen])

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries
    const q = search.trim().toLowerCase()
    return entries.filter(e => {
      const haystack = [
        e.description,
        ...(e.supplierNames || []),
        e.source,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [entries, search])

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-[560px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">System Feedback</h3>
            <p className="text-xs text-gray-400 mt-0.5">Select changes to include in feedback</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-3 pb-1">
          <input
            type="text"
            placeholder="Search changes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
          {loadingEntries ? (
            <p className="text-sm text-gray-400 italic text-center py-4">Loading changes...</p>
          ) : filteredEntries.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-4">
              {entries.length === 0 ? 'No changes recorded yet.' : 'No matching changes.'}
            </p>
          ) : (
            filteredEntries.map(entry => {
              const isSelected = selectedIds.has(entry.id)
              return (
                <label
                  key={entry.id}
                  className="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-2.5 cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(entry.id)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-900 truncate">
                      {entry.description || `${entry.affectedTable} change`}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-500">
                      <span className={`rounded-full px-1.5 py-0.5 font-medium ${
                        entry.source === 'manual' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {entry.source}
                      </span>
                      <span>{new Date(entry.createdAt.replace(' ', 'T')).toLocaleString()}</span>
                    </div>
                  </div>
                </label>
              )
            })
          )}
        </div>

        {/* Feedback textarea */}
        <div className="px-5 py-3 border-t border-gray-100">
          <label className="mb-1.5 block text-xs font-medium text-gray-600">
            Your feedback
          </label>
          <textarea
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Describe what the classifier got wrong..."
            value={feedbackText}
            onChange={e => onFeedbackChange(e.target.value)}
            rows={3}
          />
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
          {analyzing ? (
            <div className="px-5 py-4 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-xs font-medium text-blue-600">Analyzing feedback...</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1 overflow-hidden">
                <div className="bg-blue-500 h-1 rounded-full animate-pulse" style={{ width: '60%' }} />
              </div>
              <p className="text-[10px] text-gray-400">Reviewing changes and generating recommendations</p>
            </div>
          ) : (
            <div className="flex items-center justify-between px-5 py-3">
              <p className="text-xs text-gray-400">
                {selectedIds.size} change{selectedIds.size !== 1 ? 's' : ''} selected
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={onAnalyze}
                  disabled={selectedIds.size === 0 || !feedbackText.trim()}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-lg transition-colors"
                >
                  Analyze
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
