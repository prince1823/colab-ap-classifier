import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { FlattenedPivotRow } from '../../types/pivot'
import type { TaxonomyNode } from '../../../shared/types/taxonomy'
import type { PivotFilterState } from './PivotFilterBar'

interface ReclassifyModalProps {
  isOpen: boolean
  onClose: () => void
  targetRows: FlattenedPivotRow[]
  onSuccess: () => void
  filterState: PivotFilterState
}

export default function ReclassifyModal({
  isOpen,
  onClose,
  targetRows,
  onSuccess,
  filterState,
}: ReclassifyModalProps) {
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [search, setSearch] = useState('')
  const [focusedIdx, setFocusedIdx] = useState(0)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch taxonomy on open
  useEffect(() => {
    if (!isOpen) return
    setSearch('')
    setFocusedIdx(0)
    setError(null)
    ipc.taxonomy.getNodes().then(setTaxonomyNodes).catch(() => {})
    // Focus search input
    setTimeout(() => searchRef.current?.focus(), 50)
  }, [isOpen])

  // Filter to leaf nodes (depth === 3 or no children)
  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase()
    const leafNodes = taxonomyNodes.filter(n => n.depth >= 2) // L2+ nodes
    if (!q) return leafNodes.slice(0, 50)
    return leafNodes.filter(n =>
      n.fullPath.toLowerCase().includes(q) ||
      n.l1.toLowerCase().includes(q) ||
      (n.l2 && n.l2.toLowerCase().includes(q)) ||
      (n.l3 && n.l3.toLowerCase().includes(q))
    ).slice(0, 50)
  }, [taxonomyNodes, search])

  // Clamp focused index
  useEffect(() => {
    setFocusedIdx(prev => Math.min(prev, Math.max(0, filteredNodes.length - 1)))
  }, [filteredNodes.length])

  // Scroll focused item into view
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[focusedIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [focusedIdx])

  const handleApply = useCallback(async (node: TaxonomyNode) => {
    if (applying) return
    setApplying(true)
    setError(null)

    try {
      // Build filter conditions from target rows to find matching transaction IDs
      // Use getIdsByValue for each row's deepest path segment
      const allIds: string[] = []

      for (const row of targetRows) {
        const deepest = row.pathSegments[row.pathSegments.length - 1]
        if (!deepest) continue

        // Build a filter that combines the row's path with existing pivot filters
        const ids = await ipc.transactions.getIdsByValue(
          deepest.dimensionField,
          deepest.value,
        )
        allIds.push(...ids)
      }

      // Deduplicate
      const uniqueIds = [...new Set(allIds)]
      if (uniqueIds.length === 0) {
        setError('No matching transactions found.')
        setApplying(false)
        return
      }

      await ipc.transactions.update({
        ids: uniqueIds,
        taxonomyNodeId: node.id,
        classificationStatus: 'classified_by_ai',
      })

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reclassification failed')
    } finally {
      setApplying(false)
    }
  }, [targetRows, onSuccess, applying])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setFocusedIdx(prev => Math.min(filteredNodes.length - 1, prev + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setFocusedIdx(prev => Math.max(0, prev - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (filteredNodes[focusedIdx]) {
          handleApply(filteredNodes[focusedIdx])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }

  if (!isOpen) return null

  const rowSummary = targetRows.length === 1
    ? targetRows[0].label
    : `${targetRows.length} selected groups`

  const totalTxns = targetRows.reduce((sum, r) => sum + r.transactionCount, 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-[480px] max-h-[500px] flex flex-col"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Reclassify</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {rowSummary}
              {totalTxns > 0 && <span className="text-gray-400"> ({totalTxns.toLocaleString()} transactions)</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-gray-100">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setFocusedIdx(0) }}
            placeholder="Search taxonomy..."
            className="w-full rounded border border-gray-200 px-3 py-1.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
            autoFocus
          />
        </div>

        {/* Taxonomy list */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-1">
          {filteredNodes.map((node, idx) => (
            <div
              key={node.id}
              className={`px-3 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                idx === focusedIdx
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
              onClick={() => handleApply(node)}
              onMouseEnter={() => setFocusedIdx(idx)}
            >
              <span className="font-medium">{node.l3 || node.l2 || node.l1}</span>
              <span className="text-xs text-gray-400 ml-2">
                {node.fullPath.split('|').map(s => s.trim()).join(' > ')}
              </span>
            </div>
          ))}
          {filteredNodes.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">No matching taxonomy nodes</p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-xs text-red-600 border-t border-gray-100">
            {error}
          </div>
        )}

        {/* Footer */}
        {applying && (
          <div className="px-4 py-2 text-xs text-blue-600 border-t border-gray-100">
            Applying reclassification...
          </div>
        )}
      </div>
    </div>
  )
}
