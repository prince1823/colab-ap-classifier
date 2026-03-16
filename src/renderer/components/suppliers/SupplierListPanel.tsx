import React, { useRef, useEffect } from 'react'
import type { ProjectSupplierView } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'
import { Search, X } from 'lucide-react'

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
}

const TYPE_COLORS: Record<string, string> = {
  company: 'bg-blue-50 text-blue-600',
  individual: 'bg-amber-50 text-amber-600',
  government: 'bg-emerald-50 text-emerald-600',
}

function SupplierTypeChip({ type }: { type?: string }) {
  if (!type) return null
  const colors = TYPE_COLORS[type] ?? 'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-block px-1.5 py-0 rounded text-[9px] font-medium capitalize flex-shrink-0 ${colors}`}>
      {type}
    </span>
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
}: SupplierListPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Auto-focus list for keyboard nav
  useEffect(() => {
    if (isActive) listRef.current?.focus()
  }, [isActive])

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
      </div>

      {/* Supplier list */}
      <div
        ref={listRef}
        className="supplier-list-scroll"
        tabIndex={0}
        onKeyDown={onKeyDown}
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
                    <SupplierTypeChip type={s.supplierInfo?.supplierType} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-400">{fmtAbbrev(s.totalSpend)}</span>
                    <span className="text-[10px] text-gray-300">·</span>
                    <span className="text-[10px] text-gray-400">{s.transactionCount} txns</span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
