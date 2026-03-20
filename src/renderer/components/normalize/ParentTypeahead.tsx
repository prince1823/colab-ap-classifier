import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Plus, X as XIcon } from 'lucide-react'
import type { SupplierParent } from '../../../shared/types/suppliers'

interface Props {
  parents: SupplierParent[]
  anchor: { top: number; left: number }
  currentParentId: string | null
  onSelect: (parentId: string) => void
  onCreate: (name: string) => void
  onRemove: () => void
  onClose: () => void
}

type ListItem =
  | { kind: 'remove' }
  | { kind: 'create'; name: string }
  | { kind: 'parent'; parent: SupplierParent }

export default function ParentTypeahead({ parents, anchor, currentParentId, onSelect, onCreate, onRemove, onClose }: Props) {
  const [search, setSearch] = useState('')
  // -1 = input focused (no highlight), 0..n-1 = list item highlighted
  const [focusIndex, setFocusIndex] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Always keep input focused on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // Scroll highlighted item into view
  useEffect(() => {
    if (focusIndex >= 0) {
      const el = listRef.current?.querySelector(`[data-item-index="${focusIndex}"]`)
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusIndex])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return parents
      .filter(p => !q || p.name.toLowerCase().includes(q))
      .slice(0, 20)
  }, [parents, search])

  const exactMatch = parents.some(p => p.name.toLowerCase() === search.trim().toLowerCase())

  // Flat navigable list: remove? + create? + parents
  const items: ListItem[] = useMemo(() => {
    const list: ListItem[] = []
    if (currentParentId) list.push({ kind: 'remove' })
    if (search.trim() && !exactMatch) list.push({ kind: 'create', name: search.trim() })
    for (const p of filtered) list.push({ kind: 'parent', parent: p })
    return list
  }, [currentParentId, search, exactMatch, filtered])

  const activateItem = useCallback((item: ListItem) => {
    if (item.kind === 'remove') onRemove()
    else if (item.kind === 'create') onCreate(item.name)
    else onSelect(item.parent.id)
  }, [onRemove, onCreate, onSelect])

  // All key events route through the input — it stays focused throughout
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Escape': {
        e.preventDefault()
        onClose()
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        setFocusIndex(i => Math.min(items.length - 1, i + 1))
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setFocusIndex(i => Math.max(-1, i - 1))
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (focusIndex >= 0 && focusIndex < items.length) {
          activateItem(items[focusIndex])
        } else if (search.trim() && !exactMatch) {
          // Enter with no highlight + new text = create
          onCreate(search.trim())
        } else if (items.length === 1) {
          activateItem(items[0])
        }
        break
      }
    }
  }, [focusIndex, items, search, exactMatch, onClose, onCreate, activateItem])

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-64 rounded-lg border border-violet-200 bg-white shadow-lg"
      style={{ top: anchor.top, left: Math.min(anchor.left, window.innerWidth - 280) }}
    >
      <div className="px-3 py-2 border-b border-violet-100 bg-violet-50/40 rounded-t-lg">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={search}
            onChange={e => { setSearch(e.target.value); setFocusIndex(-1) }}
            onKeyDown={handleKeyDown}
            className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
            placeholder="Search or create parent..."
          />
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5">
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div ref={listRef} className="max-h-48 overflow-y-auto">
        {/* Remove parent option */}
        {currentParentId && (() => {
          const idx = items.findIndex(i => i.kind === 'remove')
          const isHighlighted = focusIndex === idx
          return (
            <button
              key="remove"
              data-item-index={idx}
              onClick={onRemove}
              onMouseEnter={() => setFocusIndex(idx)}
              onMouseLeave={() => setFocusIndex(-1)}
              className={`w-full px-3 py-1.5 text-left text-xs text-red-500 transition-colors border-b border-gray-50 ${
                isHighlighted ? 'bg-red-50 ring-2 ring-inset ring-red-100' : 'hover:bg-red-50'
              }`}
            >
              Remove parent
            </button>
          )
        })()}

        {/* Create new option */}
        {search.trim() && !exactMatch && (() => {
          const idx = items.findIndex(i => i.kind === 'create')
          const isHighlighted = focusIndex === idx
          return (
            <button
              key="create"
              data-item-index={idx}
              onClick={() => onCreate(search.trim())}
              onMouseEnter={() => setFocusIndex(idx)}
              onMouseLeave={() => setFocusIndex(-1)}
              className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-xs text-violet-600 transition-colors border-b border-gray-50 ${
                isHighlighted ? 'bg-violet-50 ring-2 ring-inset ring-violet-100' : 'hover:bg-violet-50'
              }`}
            >
              <Plus size={12} /> Create "{search.trim()}"
            </button>
          )
        })()}

        {/* Existing parents */}
        {filtered.map(p => {
          const idx = items.findIndex(i => i.kind === 'parent' && i.parent.id === p.id)
          const isHighlighted = focusIndex === idx
          return (
            <button
              key={p.id}
              data-item-index={idx}
              onClick={() => onSelect(p.id)}
              onMouseEnter={() => setFocusIndex(idx)}
              onMouseLeave={() => setFocusIndex(-1)}
              className={`w-full px-3 py-1.5 text-left text-xs transition-colors border-b border-gray-50 last:border-b-0 ${
                isHighlighted
                  ? 'bg-violet-50 ring-2 ring-inset ring-violet-100 text-violet-700'
                  : p.id === currentParentId
                  ? 'bg-violet-50 text-violet-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p.name}
            </button>
          )
        })}

        {filtered.length === 0 && !search.trim() && (
          <div className="py-3 px-3 text-xs text-gray-400 text-center">No parents yet</div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-gray-100 rounded-b-lg">
        <p className="text-[10px] text-gray-400">↑↓ navigate · Enter select · Esc close</p>
      </div>
    </div>
  )
}
