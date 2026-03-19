import React, { useState, useRef, useEffect, useMemo } from 'react'
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

export default function ParentTypeahead({ parents, anchor, currentParentId, onSelect, onCreate, onRemove, onClose }: Props) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

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
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'Enter' && search.trim() && !exactMatch) {
                onCreate(search.trim())
              }
            }}
            className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
            placeholder="Search or create parent..."
          />
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5">
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto">
        {/* Remove parent option */}
        {currentParentId && (
          <button
            onClick={onRemove}
            className="w-full px-3 py-1.5 text-left text-xs text-red-500 hover:bg-red-50 transition-colors border-b border-gray-50"
          >
            Remove parent
          </button>
        )}

        {/* Create new option */}
        {search.trim() && !exactMatch && (
          <button
            onClick={() => onCreate(search.trim())}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-xs text-violet-600 hover:bg-violet-50 transition-colors border-b border-gray-50"
          >
            <Plus size={12} /> Create "{search.trim()}"
          </button>
        )}

        {/* Existing parents */}
        {filtered.map(p => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`w-full px-3 py-1.5 text-left text-xs transition-colors border-b border-gray-50 last:border-b-0 ${
              p.id === currentParentId
                ? 'bg-violet-50 text-violet-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {p.name}
          </button>
        ))}

        {filtered.length === 0 && !search.trim() && (
          <div className="py-3 px-3 text-xs text-gray-400 text-center">No parents yet</div>
        )}
      </div>
    </div>
  )
}
