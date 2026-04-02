import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { ProjectSupplierView } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'
import { Search, X, ArrowUpAZ, ArrowDownZA, ArrowUpDown } from 'lucide-react'

export type NameSort = 'none' | 'asc' | 'desc'
type QuickFilter = 'all' | 'unresearched' | 'unconfirmed'

interface SupplierListPanelProps {
  suppliers: ProjectSupplierView[]
  focusedIndex: number
  selectedIds: Set<string>
  selectedSupplierId: string | null
  searchQuery: string
  quickFilter: QuickFilter
  unresearchedCount: number
  unconfirmedCount: number
  onSearchChange: (q: string) => void
  onQuickFilterChange: (f: QuickFilter) => void
  onSupplierClick: (index: number) => void
  onToggleCheck: (id: string) => void
  onToggleSelectAll: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  allChecked: boolean
  isActive?: boolean
  onResearch?: (supplier: ProjectSupplierView) => void
  onResearchSelected?: () => void
  onCategorizeSelected?: () => void
  onConfirmSelected?: () => void
  nameSort: NameSort
  onNameSortChange: (sort: NameSort) => void
}

function ConfirmedChip({ supplier }: { supplier: ProjectSupplierView }) {
  if (supplier.confirmationStatus !== 'confirmed') return null
  return (
    <span className="inline-block px-1.5 py-0 rounded text-[9px] font-medium bg-green-50 text-green-600 flex-shrink-0">
      confirmed
    </span>
  )
}

function CatAChip({ supplier }: { supplier: ProjectSupplierView }) {
  if (!supplier.categoryASupplier) return null
  return (
    <span className="inline-block px-1.5 py-0 rounded text-[9px] font-medium bg-amber-50 text-amber-600 flex-shrink-0">
      Cat A
    </span>
  )
}

function ResearchButton({ supplier, onResearch }: { supplier: ProjectSupplierView; onResearch?: (s: ProjectSupplierView) => void }) {
  if (supplier.isResearched || supplier.isTailSpend || !onResearch) return null
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onResearch(supplier) }}
      className="inline-block px-1.5 py-0 rounded text-[9px] font-medium bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 flex-shrink-0 cursor-pointer transition-colors"
    >
      research
    </button>
  )
}

export default function SupplierListPanel({
  suppliers,
  focusedIndex,
  selectedIds,
  selectedSupplierId,
  searchQuery,
  quickFilter,
  unresearchedCount,
  unconfirmedCount,
  onSearchChange,
  onQuickFilterChange,
  onSupplierClick,
  onToggleCheck,
  onToggleSelectAll,
  onKeyDown,
  allChecked,
  isActive = true,
  onResearch,
  onResearchSelected,
  onCategorizeSelected,
  onConfirmSelected,
  nameSort,
  onNameSortChange,
}: SupplierListPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const researchBtnRef = useRef<HTMLButtonElement>(null)
  const categorizeBtnRef = useRef<HTMLButtonElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const [actionFocused, setActionFocused] = useState<'research' | 'categorize' | 'confirm' | null>(null)

  // Auto-focus list for keyboard nav
  useEffect(() => {
    if (isActive) listRef.current?.focus()
  }, [isActive])

  // Handle Cmd+Enter to focus action buttons, and arrow keys within them
  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd+Enter (or Ctrl+Enter) to jump to action buttons
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && selectedIds.size > 0) {
      e.preventDefault()
      e.stopPropagation()
      const firstBtn = onResearchSelected ? 'research' : onCategorizeSelected ? 'categorize' : onConfirmSelected ? 'confirm' : null
      if (firstBtn) {
        setActionFocused(firstBtn)
        setTimeout(() => {
          if (firstBtn === 'research') researchBtnRef.current?.focus()
          else if (firstBtn === 'categorize') categorizeBtnRef.current?.focus()
          else confirmBtnRef.current?.focus()
        }, 0)
      }
      return
    }
    onKeyDown(e)
  }, [onKeyDown, selectedIds.size, onResearchSelected, onCategorizeSelected, onConfirmSelected])

  const handleActionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const btns: { key: 'research' | 'categorize' | 'confirm'; ref: React.RefObject<HTMLButtonElement | null> }[] = []
      if (onResearchSelected) btns.push({ key: 'research', ref: researchBtnRef })
      if (onCategorizeSelected) btns.push({ key: 'categorize', ref: categorizeBtnRef })
      if (onConfirmSelected) btns.push({ key: 'confirm', ref: confirmBtnRef })
      const idx = btns.findIndex(b => b.ref.current === document.activeElement)
      if (idx >= 0) {
        const next = e.key === 'ArrowRight' ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length
        setActionFocused(btns[next].key)
        btns[next].ref.current?.focus()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setActionFocused(null)
      listRef.current?.focus()
    }
  }, [onResearchSelected, onCategorizeSelected, onConfirmSelected])

  const chipClass = (f: QuickFilter) =>
    `px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors cursor-pointer border ${
      quickFilter === f
        ? 'bg-blue-100 text-blue-700 border-blue-300'
        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
    }`

  return (
    <div className="supplier-list-panel">
      {/* Search */}
      <div className="supplier-list-search">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search suppliers..."
            className="w-full pl-8 pr-7 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200 outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Quick filter chips */}
      <div className="supplier-list-filters">
        <button type="button" className={chipClass('all')} onClick={() => onQuickFilterChange('all')}>
          All
        </button>
        <button type="button" className={chipClass('unresearched')} onClick={() => onQuickFilterChange('unresearched')}>
          Unresearched <span className="ml-0.5 text-[10px] opacity-70">{unresearchedCount}</span>
        </button>
        <button type="button" className={chipClass('unconfirmed')} onClick={() => onQuickFilterChange('unconfirmed')}>
          Unconfirmed <span className="ml-0.5 text-[10px] opacity-70">{unconfirmedCount}</span>
        </button>
      </div>

      {/* Select all row */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50/50">
        <input
          type="checkbox"
          checked={allChecked}
          onChange={onToggleSelectAll}
          className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
        />
        <span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">
          {suppliers.length} supplier{suppliers.length !== 1 ? 's' : ''}
          {selectedIds.size > 0 && ` · ${selectedIds.size} checked`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          title={nameSort === 'none' ? 'Sort by name A–Z' : nameSort === 'asc' ? 'Sort by name Z–A' : 'Sort by spend'}
          onClick={() => onNameSortChange(nameSort === 'none' ? 'asc' : nameSort === 'asc' ? 'desc' : 'none')}
          className={`p-0.5 rounded transition-colors ${
            nameSort !== 'none'
              ? 'text-blue-600 bg-blue-50 hover:bg-blue-100'
              : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
          }`}
        >
          {nameSort === 'asc' ? <ArrowUpAZ size={14} /> : nameSort === 'desc' ? <ArrowDownZA size={14} /> : <ArrowUpDown size={14} />}
        </button>
      </div>

      {/* Supplier list */}
      <div
        ref={listRef}
        className="supplier-list-scroll"
        tabIndex={0}
        onKeyDown={handleListKeyDown}
      >
        {suppliers.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-gray-400">
            No suppliers match
          </div>
        ) : (
          suppliers.map((s, i) => {
            const isFocused = i === focusedIndex
            const isActive = s.id === selectedSupplierId
            return (
              <div
                key={s.id}
                data-supplier-index={i}
                onClick={() => onSupplierClick(i)}
                className={`supplier-list-item ${isFocused ? 'focused' : ''} ${isActive ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(s.id)}
                  onChange={(e) => { e.stopPropagation(); onToggleCheck(s.id) }}
                  className="w-3.5 h-3.5 accent-blue-600 cursor-pointer flex-shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-gray-800 truncate">{s.supplierName}</span>
                    <span className="flex-1" />
                    <CatAChip supplier={s} />
                    <ConfirmedChip supplier={s} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-400">{fmtAbbrev(s.totalSpend)}</span>
                    <span className="text-[10px] text-gray-300">·</span>
                    <span className="text-[10px] text-gray-400">{s.transactionCount} txns</span>
                    {s.l1L2Path && s.l1L2Path.length > 0 && (
                      <>
                        <span className="text-[10px] text-gray-300">·</span>
                        <span className="text-[10px] text-blue-500 truncate max-w-[120px]" title={s.l1L2Path.join(', ')}>{s.l1L2Path.join(', ')}</span>
                      </>
                    )}
                    <span className="flex-1" />
                    <ResearchButton supplier={s} onResearch={onResearch} />
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Batch actions footer */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-blue-200 bg-blue-50">
          <span className="text-[10px] font-semibold text-blue-700">{selectedIds.size} selected</span>
          <div className="flex-1" />
          {onResearchSelected && (
            <button
              ref={researchBtnRef}
              type="button"
              onClick={onResearchSelected}
              onKeyDown={handleActionKeyDown}
              onBlur={(e) => { if (!researchBtnRef.current?.contains(e.relatedTarget as Node) && !categorizeBtnRef.current?.contains(e.relatedTarget as Node) && !confirmBtnRef.current?.contains(e.relatedTarget as Node)) setActionFocused(null) }}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors ${actionFocused === 'research' ? 'ring-2 ring-blue-300 ring-offset-1' : ''}`}
            >
              Research
            </button>
          )}
          {onCategorizeSelected && (
            <button
              ref={categorizeBtnRef}
              type="button"
              onClick={onCategorizeSelected}
              onKeyDown={handleActionKeyDown}
              onBlur={(e) => { if (!researchBtnRef.current?.contains(e.relatedTarget as Node) && !categorizeBtnRef.current?.contains(e.relatedTarget as Node) && !confirmBtnRef.current?.contains(e.relatedTarget as Node)) setActionFocused(null) }}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-600 text-white hover:bg-purple-700 transition-colors ${actionFocused === 'categorize' ? 'ring-2 ring-purple-300 ring-offset-1' : ''}`}
            >
              Categorize
            </button>
          )}
          {onConfirmSelected && (
            <button
              ref={confirmBtnRef}
              type="button"
              onClick={onConfirmSelected}
              onKeyDown={handleActionKeyDown}
              onBlur={(e) => { if (!researchBtnRef.current?.contains(e.relatedTarget as Node) && !categorizeBtnRef.current?.contains(e.relatedTarget as Node) && !confirmBtnRef.current?.contains(e.relatedTarget as Node)) setActionFocused(null) }}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold bg-green-600 text-white hover:bg-green-700 transition-colors ${actionFocused === 'confirm' ? 'ring-2 ring-green-300 ring-offset-1' : ''}`}
            >
              Confirm
            </button>
          )}
        </div>
      )}
    </div>
  )
}
