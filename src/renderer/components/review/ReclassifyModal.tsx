import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { FlattenedPivotRow } from '../../types/pivot'
import type { TaxonomyNode } from '../../../shared/types/taxonomy'

interface ReclassifyModalProps {
  isOpen: boolean
  onClose: () => void
  targetRows: FlattenedPivotRow[]
  // Taxonomy state
  filteredNodes: TaxonomyNode[]
  search: string
  onSearchChange: (value: string) => void
  focusedIdx: number
  onFocusedIdxChange: (idx: number) => void
  searchRef: React.RefObject<HTMLInputElement>
  // Actions
  onApply: (node: TaxonomyNode) => void
  applying: boolean
  error: string | null
}

export default function ReclassifyModal({
  isOpen,
  onClose,
  targetRows,
  filteredNodes,
  search,
  onSearchChange,
  focusedIdx,
  onFocusedIdxChange,
  searchRef,
  onApply,
  applying,
  error,
}: ReclassifyModalProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll focused item into view
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[focusedIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [focusedIdx])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        onFocusedIdxChange(Math.min(filteredNodes.length - 1, focusedIdx + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        onFocusedIdxChange(Math.max(0, focusedIdx - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (filteredNodes[focusedIdx]) {
          onApply(filteredNodes[focusedIdx])
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
            onChange={e => { onSearchChange(e.target.value); onFocusedIdxChange(0) }}
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
              onClick={() => onApply(node)}
              onMouseEnter={() => onFocusedIdxChange(idx)}
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
