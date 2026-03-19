import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import type { ProjectSupplierView } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'

interface AliasData {
  rawName: string
  spend: number
  txnCount: number
}

interface Props {
  alias: AliasData
  currentNormalized: ProjectSupplierView
  allSuppliers: ProjectSupplierView[]
  onReassign: (aliasName: string, toSupplierId: string) => void
  onClose: () => void
}

export default function ReassignAliasModal({ alias, currentNormalized, allSuppliers, onReassign, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  // -1 means no list item highlighted (typing mode), 0..n-1 = highlighted row
  const [focusIndex, setFocusIndex] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Always keep the search input focused — focusIndex is purely visual
  useEffect(() => { inputRef.current?.focus() }, [])

  // Scroll highlighted item into view
  useEffect(() => {
    if (focusIndex >= 0) {
      const el = listRef.current?.querySelector(`[data-item-index="${focusIndex}"]`)
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusIndex])

  const targets = useMemo(() => {
    const q = search.toLowerCase()
    return allSuppliers
      .filter(s => s.id !== currentNormalized.id)
      .filter(s => !q || s.supplierName.toLowerCase().includes(q))
      .slice(0, 30)
  }, [allSuppliers, currentNormalized.id, search])

  const handleReassign = useCallback(async (toId: string) => {
    if (loading) return
    setLoading(true)
    await onReassign(alias.rawName, toId)
    setLoading(false)
  }, [loading, alias.rawName, onReassign])

  // ALL key handling goes through the search input — it stays focused throughout
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Escape': {
        e.preventDefault()
        onClose()
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        setFocusIndex(i => Math.min(targets.length - 1, i + 1))
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setFocusIndex(i => Math.max(-1, i - 1))
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (focusIndex >= 0 && focusIndex < targets.length) {
          handleReassign(targets[focusIndex].id)
        } else if (targets.length === 1) {
          // Only one result — Enter picks it directly
          handleReassign(targets[0].id)
        }
        break
      }
    }
  }, [focusIndex, targets, onClose, handleReassign])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl border border-gray-200 w-[420px] max-h-[60vh] flex flex-col outline-none"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">Reassign Alias</h3>
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <div>
              <span className="text-gray-400">Alias:</span>{' '}
              <span className="font-medium text-gray-700">{alias.rawName}</span>
            </div>
            {alias.spend > 0 && (
              <div>
                <span className="text-gray-400">Spend:</span>{' '}
                <span className="font-medium text-gray-700">{fmtAbbrev(alias.spend)}</span>
              </div>
            )}
          </div>
          <div className="mt-1 text-[11px]">
            <span className="text-gray-400">Currently under:</span>{' '}
            <span className="font-medium text-gray-600">{currentNormalized.supplierName}</span>
          </div>
        </div>

        {/* Search — stays focused the whole time */}
        <div className="px-5 py-3 border-b border-gray-100">
          <input
            ref={inputRef}
            value={search}
            onChange={e => { setSearch(e.target.value); setFocusIndex(-1) }}
            onKeyDown={handleKeyDown}
            placeholder="Search supplier to reassign to..."
            className="w-full px-3 py-1.5 text-xs rounded-md border border-gray-200 bg-white outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
          />
        </div>

        {/* Target list */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {targets.length === 0 ? (
            <div className="py-6 text-center text-xs text-gray-400">
              {search ? 'No suppliers match' : 'Type to search'}
            </div>
          ) : targets.map((s, i) => {
            const isHighlighted = focusIndex === i
            return (
              <button
                key={s.id}
                data-item-index={i}
                onClick={() => handleReassign(s.id)}
                onMouseEnter={() => setFocusIndex(i)}
                onMouseLeave={() => setFocusIndex(-1)}
                disabled={loading}
                className={`w-full flex items-center justify-between px-5 py-2 text-left transition-colors border-b border-gray-50 last:border-b-0 disabled:opacity-50 ${
                  isHighlighted ? 'bg-blue-50 ring-2 ring-inset ring-blue-200' : 'hover:bg-blue-50'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-gray-800 truncate">{s.supplierName}</div>
                  {s.parentName && <div className="text-[10px] text-gray-400 truncate">{s.parentName}</div>}
                </div>
                <div className="text-[10px] text-gray-400 tabular-nums flex-shrink-0 ml-2">
                  {fmtAbbrev(s.totalSpend)}
                </div>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <p className="text-[10px] text-gray-400">↑↓ navigate · Enter select · Esc cancel</p>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
