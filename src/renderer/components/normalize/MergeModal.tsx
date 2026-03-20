import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { ProjectSupplierView, SupplierParent } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'

interface MergeItem {
  id: string
  name: string
  subtitle?: string
  spend?: number
  txnCount?: number
}

interface SupplierModeProps {
  mode?: 'supplier'
  suppliers: ProjectSupplierView[]
  onMerge: (survivorId: string, losingIds: string[]) => void
  onClose: () => void
}

interface ParentModeProps {
  mode: 'parent'
  parents: SupplierParent[]
  childCounts: Map<string, number>  // parentId → number of children
  onMerge: (survivorId: string, losingIds: string[]) => void
  onClose: () => void
}

type Props = SupplierModeProps | ParentModeProps

function toItems(props: Props): MergeItem[] {
  if (props.mode === 'parent') {
    return props.parents.map(p => ({
      id: p.id,
      name: p.name,
      subtitle: `${props.childCounts.get(p.id) ?? 0} supplier(s)`,
    }))
  }
  // Default: supplier mode
  return props.suppliers.map(s => ({
    id: s.id,
    name: s.supplierName,
    subtitle: s.parentName ? `Parent: ${s.parentName}` : undefined,
    spend: s.totalSpend,
    txnCount: s.transactionCount,
  }))
}

export default function MergeModal(props: Props) {
  const { onMerge, onClose } = props
  const items = toItems(props)
  const isParentMode = props.mode === 'parent'

  const [survivorId, setSurvivorId] = useState(items[0]?.id ?? '')
  const [loading, setLoading] = useState(false)

  // focusIndex: 0..n-1 = item rows, n = Cancel, n+1 = Merge
  const CANCEL_IDX = items.length
  const MERGE_IDX = items.length + 1
  const [focusIndex, setFocusIndex] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)

  // Grab focus on mount so keydown fires immediately
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleMerge = useCallback(async () => {
    if (!survivorId || loading) return
    setLoading(true)
    const losingIds = items.filter(s => s.id !== survivorId).map(s => s.id)
    await onMerge(survivorId, losingIds)
    setLoading(false)
  }, [survivorId, loading, items, onMerge])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const total = items.length + 2 // rows + Cancel + Merge

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        setFocusIndex(i => (i + 1) % total)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setFocusIndex(i => (i - 1 + total) % total)
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (focusIndex < items.length) {
          setSurvivorId(items[focusIndex].id)
        } else if (focusIndex === CANCEL_IDX) {
          onClose()
        } else if (focusIndex === MERGE_IDX) {
          handleMerge()
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        onClose()
        break
      }
    }
  }, [focusIndex, items, CANCEL_IDX, MERGE_IDX, onClose, handleMerge])

  const isFocusedBtn = (idx: number) => focusIndex === idx

  const survivorName = items.find(s => s.id === survivorId)?.name ?? ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl border border-gray-200 w-[480px] max-h-[70vh] flex flex-col outline-none"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">
            {isParentMode ? 'Merge Parents' : 'Merge Suppliers'}
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {isParentMode
              ? 'Select which parent survives. Children from losing parents move to the winner.'
              : 'Select which name survives. Aliases from losing suppliers fold into the winner.'}
          </p>
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {items.map((item, i) => {
            const isRowFocused = focusIndex === i
            const isSurvivor = survivorId === item.id
            return (
              <label
                key={item.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors mb-1 ${
                  isRowFocused
                    ? 'ring-2 ring-violet-400 bg-violet-50 border border-violet-200'
                    : isSurvivor
                    ? 'bg-violet-50 border border-violet-200'
                    : 'hover:bg-gray-50 border border-transparent'
                }`}
                onClick={() => { setSurvivorId(item.id); setFocusIndex(i) }}
              >
                <input
                  type="radio"
                  name="survivor"
                  checked={isSurvivor}
                  onChange={() => setSurvivorId(item.id)}
                  className="accent-violet-600"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-800 truncate">{item.name}</div>
                  {item.subtitle && (
                    <div className="text-[10px] text-gray-400">{item.subtitle}</div>
                  )}
                </div>
                {(item.spend !== undefined || item.txnCount !== undefined) && (
                  <div className="text-right flex-shrink-0">
                    {item.spend !== undefined && (
                      <div className="text-xs font-medium text-gray-700 tabular-nums">{fmtAbbrev(item.spend)}</div>
                    )}
                    {item.txnCount !== undefined && (
                      <div className="text-[10px] text-gray-400 tabular-nums">{item.txnCount} txn</div>
                    )}
                  </div>
                )}
              </label>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            onMouseEnter={() => setFocusIndex(CANCEL_IDX)}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              isFocusedBtn(CANCEL_IDX)
                ? 'ring-2 ring-gray-300 bg-gray-100 text-gray-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={loading || !survivorId}
            onMouseEnter={() => setFocusIndex(MERGE_IDX)}
            className={`px-4 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors disabled:opacity-50 ${
              isFocusedBtn(MERGE_IDX) ? 'ring-2 ring-violet-400 ring-offset-1' : ''
            }`}
          >
            {loading ? 'Merging...' : `Merge into "${survivorName}"`}
          </button>
        </div>
      </div>
    </div>
  )
}
