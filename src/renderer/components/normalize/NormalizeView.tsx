import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ChevronRight, ChevronDown, ChevronsDown, ChevronsUp, Trash2, Plus, Search, X,
  Merge, ArrowRightLeft,
} from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { ProjectSupplierView, SupplierParent } from '../../../shared/types/suppliers'
import MergeModal from './MergeModal'
import ReassignAliasModal from './ReassignAliasModal'
import ParentTypeahead from './ParentTypeahead'
import { fmtAbbrev } from '../../utils/formatSpend'

// ── Types ────────────────────────────────────────────────────────────

interface AliasData {
  rawName: string
  spend: number
  txnCount: number
}

interface NormalizedRow {
  supplier: ProjectSupplierView
  aliases: AliasData[]
  aliasesLoaded: boolean
}

type RowType = 'normalized' | 'alias'

interface FlatRow {
  type: RowType
  // For normalized rows
  normalized?: NormalizedRow
  // For alias rows
  alias?: AliasData
  aliasNormalized?: NormalizedRow
}

// ── Component ────────────────────────────────────────────────────────

export default function NormalizeView() {
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [parents, setParents] = useState<SupplierParent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')

  // Expanded state: set of supplier IDs whose aliases are visible
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Alias cache: supplierId → AliasData[]
  const [aliasCache, setAliasCache] = useState<Map<string, AliasData[]>>(new Map())

  // Selection: set of normalized supplier IDs
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Focus
  const [focusedRowIndex, setFocusedRowIndex] = useState(0)
  const outerRef = useRef<HTMLDivElement>(null)  // owns onKeyDown — always focus this
  const tableRef = useRef<HTMLDivElement>(null)  // scroll container

  const focusOuter = useCallback(() => {
    setTimeout(() => outerRef.current?.focus(), 50)
  }, [])

  // Inline editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Modals
  const [showMergeModal, setShowMergeModal] = useState(false)
  const [reassigningAlias, setReassigningAlias] = useState<{ alias: AliasData; normalized: NormalizedRow } | null>(null)

  // Parent typeahead
  const [parentTypeahead, setParentTypeahead] = useState<{ supplierId: string; anchor: { top: number; left: number } } | null>(null)

  // Re-focus outer div whenever all modals/popovers/edits are closed (also on initial load)
  useEffect(() => {
    if (!loading && !showMergeModal && !reassigningAlias && !parentTypeahead && !editingId) {
      outerRef.current?.focus()
    }
  }, [loading, showMergeModal, reassigningAlias, parentTypeahead, editingId])

  // ── Data loading ──────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setError(null)
    try {
      const [supplierData, parentData] = await Promise.all([
        ipc.suppliers.list(),
        ipc.suppliers.listParents(),
      ])
      setSuppliers(supplierData as ProjectSupplierView[])
      setParents(parentData as SupplierParent[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ── Load aliases on expand ────────────────────────────────────────

  const loadAliases = useCallback(async (supplierId: string) => {
    if (aliasCache.has(supplierId)) return
    try {
      const aliases = await ipc.suppliers.getAliases(supplierId)
      // getAliases returns string[] of raw alias names
      // We don't have per-alias spend/txn from backend yet, so we'll show the name only
      const aliasData: AliasData[] = (aliases as string[]).map(name => ({
        rawName: name,
        spend: 0,
        txnCount: 0,
      }))
      setAliasCache(prev => new Map(prev).set(supplierId, aliasData))
    } catch {
      // non-fatal
    }
  }, [aliasCache])

  const toggleExpand = useCallback((supplierId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(supplierId)) {
        next.delete(supplierId)
      } else {
        next.add(supplierId)
        loadAliases(supplierId)
      }
      return next
    })
  }, [loadAliases])

  const allExpanded = suppliers.length > 0 && suppliers.every(s => expanded.has(s.id))

  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpanded(new Set())
    } else {
      const allIds = suppliers.map(s => s.id)
      setExpanded(new Set(allIds))
      allIds.forEach(id => loadAliases(id))
    }
  }, [allExpanded, suppliers, loadAliases])

  // ── Build normalized rows ─────────────────────────────────────────

  const normalizedRows: NormalizedRow[] = useMemo(() => {
    return suppliers
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .map(s => ({
        supplier: s,
        aliases: aliasCache.get(s.id) ?? [],
        aliasesLoaded: aliasCache.has(s.id),
      }))
  }, [suppliers, aliasCache])

  // ── Search filter ─────────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!searchQuery) return normalizedRows
    const q = searchQuery.toLowerCase()
    return normalizedRows.filter(r =>
      r.supplier.supplierName.toLowerCase().includes(q) ||
      r.supplier.parentName?.toLowerCase().includes(q) ||
      r.aliases.some(a => a.rawName.toLowerCase().includes(q))
    )
  }, [normalizedRows, searchQuery])

  // ── Flatten into table rows ───────────────────────────────────────

  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = []
    for (const r of filtered) {
      rows.push({ type: 'normalized', normalized: r })
      if (expanded.has(r.supplier.id)) {
        for (const a of r.aliases) {
          rows.push({ type: 'alias', alias: a, aliasNormalized: r })
        }
      }
    }
    return rows
  }, [filtered, expanded])

  // ── Actions ───────────────────────────────────────────────────────

  const handleRename = useCallback(async (supplierId: string, newName: string) => {
    try {
      await ipc.suppliers.rename(supplierId, newName)
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, supplierName: newName } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed')
    }
    setEditingId(null)
  }, [])

  const handleDeleteNormalized = useCallback(async (supplierId: string) => {
    const supplier = suppliers.find(s => s.id === supplierId)
    if (!supplier) return
    const aliases = aliasCache.get(supplierId)
    if (aliases && aliases.length > 0) {
      if (!window.confirm(`"${supplier.supplierName}" has ${aliases.length} alias(es). Reassign them first, or delete anyway?`)) return
    } else {
      if (!window.confirm(`Delete "${supplier.supplierName}"?`)) return
    }
    try {
      await ipc.suppliers.delete(supplierId)
      setSuppliers(prev => prev.filter(s => s.id !== supplierId))
      setExpanded(prev => { const n = new Set(prev); n.delete(supplierId); return n })
      setSelectedIds(prev => { const n = new Set(prev); n.delete(supplierId); return n })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [suppliers, aliasCache])

  const handleDeleteAlias = useCallback(async (alias: AliasData, normalizedId: string) => {
    if (!window.confirm(`Remove alias "${alias.rawName}"?`)) return
    try {
      // Reassign alias to itself is essentially a no-op — we need a delete alias endpoint
      // For now, we'll just remove from cache (backend may need a dedicated endpoint)
      setAliasCache(prev => {
        const next = new Map(prev)
        const aliases = next.get(normalizedId) ?? []
        next.set(normalizedId, aliases.filter(a => a.rawName !== alias.rawName))
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove alias')
    }
  }, [])

  const handleChangeParent = useCallback(async (supplierId: string, parentId: string | null) => {
    try {
      if (parentId) {
        await ipc.suppliers.changeParent(supplierId, parentId)
        const parent = parents.find(p => p.id === parentId)
        setSuppliers(prev => prev.map(s =>
          s.id === supplierId ? { ...s, parentSupplierId: parentId, parentName: parent?.name ?? null } : s
        ))
      } else {
        await ipc.suppliers.removeParent(supplierId)
        setSuppliers(prev => prev.map(s =>
          s.id === supplierId ? { ...s, parentSupplierId: null, parentName: null } : s
        ))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change parent')
    }
    setParentTypeahead(null)
  }, [parents])

  const handleCreateParentAndAssign = useCallback(async (supplierId: string, name: string) => {
    try {
      const parent = await ipc.suppliers.addParent(name) as SupplierParent
      setParents(prev => [...prev, parent])
      await ipc.suppliers.changeParent(supplierId, parent.id)
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parent.id, parentName: parent.name } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create parent')
    }
    setParentTypeahead(null)
  }, [])

  const handleMerge = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      await ipc.suppliers.merge(survivorId, losingIds)

      const losingSet = new Set(losingIds)

      // Immediately remove losers from local state — no full reload, no visual disruption
      setSuppliers(prev => prev.filter(s => !losingSet.has(s.id)))
      setSelectedIds(prev => { const n = new Set(prev); losingSet.forEach(id => n.delete(id)); n.delete(survivorId); return n })
      setExpanded(prev => { const n = new Set(prev); losingSet.forEach(id => n.delete(id)); return n })
      setAliasCache(prev => {
        const n = new Map(prev)
        losingSet.forEach(id => n.delete(id))
        n.delete(survivorId) // invalidate survivor so aliases reload fresh on next expand
        return n
      })

      // Silently refresh spend/txn counts in background — no loading state, no collapse
      ipc.suppliers.list().then(fresh => {
        setSuppliers(fresh as ProjectSupplierView[])
      }).catch(() => { /* non-fatal */ })

    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    }
    setShowMergeModal(false)
  }, [])

  const handleReassignAlias = useCallback(async (aliasName: string, fromId: string, toId: string) => {
    try {
      await ipc.suppliers.assignAlias(toId, aliasName)
      // Update alias cache: remove from old, add to new
      setAliasCache(prev => {
        const next = new Map(prev)
        const fromAliases = next.get(fromId) ?? []
        next.set(fromId, fromAliases.filter(a => a.rawName !== aliasName))
        const toAliases = next.get(toId) ?? []
        next.set(toId, [...toAliases, { rawName: aliasName, spend: 0, txnCount: 0 }])
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
    }
    setReassigningAlias(null)
  }, [])

  // ── Inline edit helpers ───────────────────────────────────────────

  const startEdit = useCallback((id: string, currentName: string) => {
    setEditingId(id)
    setEditDraft(currentName)
    setTimeout(() => editInputRef.current?.focus(), 0)
  }, [])

  const commitEdit = useCallback((supplierId: string) => {
    const trimmed = editDraft.trim()
    if (trimmed && trimmed !== suppliers.find(s => s.id === supplierId)?.supplierName) {
      handleRename(supplierId, trimmed)
    } else {
      setEditingId(null)
    }
    focusOuter()
  }, [editDraft, suppliers, handleRename, focusOuter])

  // ── Selection ─────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedSuppliers = useMemo(() =>
    suppliers.filter(s => selectedIds.has(s.id)),
    [suppliers, selectedIds]
  )

  // ── Keyboard navigation ───────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't handle table shortcuts while a modal is open — let the modal own the keyboard
    if (showMergeModal || reassigningAlias || parentTypeahead) return

    const row = flatRows[focusedRowIndex]
    if (!row) return

    // Cmd+M: merge modal
    if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
      e.preventDefault()
      if (selectedIds.size >= 2) setShowMergeModal(true)
      return
    }

    // Cmd+P: parent typeahead (normalized rows only)
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault()
      if (row.type === 'normalized' && row.normalized) {
        const el = tableRef.current?.querySelector(`[data-row-index="${focusedRowIndex}"]`)
        if (el) {
          const rect = el.getBoundingClientRect()
          setParentTypeahead({
            supplierId: row.normalized.supplier.id,
            anchor: { top: rect.bottom + 4, left: rect.left + 100 },
          })
        }
      }
      return
    }

    // Shift+R: reassign alias (alias rows only)
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key === 'R') {
      e.preventDefault()
      if (row.type === 'alias' && row.alias && row.aliasNormalized) {
        setReassigningAlias({ alias: row.alias, normalized: row.aliasNormalized })
      }
      return
    }

    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault()
        if (e.shiftKey) {
          // Extend selection (normalized rows only)
          for (let i = focusedRowIndex - 1; i >= 0; i--) {
            if (flatRows[i].type === 'normalized' && flatRows[i].normalized) {
              setFocusedRowIndex(i)
              toggleSelect(flatRows[i].normalized!.supplier.id)
              break
            }
          }
        } else {
          setFocusedRowIndex(Math.max(0, focusedRowIndex - 1))
        }
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        if (e.shiftKey) {
          for (let i = focusedRowIndex + 1; i < flatRows.length; i++) {
            if (flatRows[i].type === 'normalized' && flatRows[i].normalized) {
              setFocusedRowIndex(i)
              toggleSelect(flatRows[i].normalized!.supplier.id)
              break
            }
          }
        } else {
          setFocusedRowIndex(Math.min(flatRows.length - 1, focusedRowIndex + 1))
        }
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (row.type === 'normalized' && row.normalized) {
          if (!expanded.has(row.normalized.supplier.id)) {
            toggleExpand(row.normalized.supplier.id)
          }
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (row.type === 'normalized' && row.normalized) {
          if (expanded.has(row.normalized.supplier.id)) {
            toggleExpand(row.normalized.supplier.id)
          }
        } else if (row.type === 'alias' && row.aliasNormalized) {
          // Collapse parent and jump to it
          const parentIdx = flatRows.findIndex(
            r => r.type === 'normalized' && r.normalized?.supplier.id === row.aliasNormalized!.supplier.id
          )
          if (parentIdx >= 0) {
            setFocusedRowIndex(parentIdx)
            toggleExpand(row.aliasNormalized.supplier.id)
          }
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (row.type === 'normalized' && row.normalized) {
          if (e.shiftKey) {
            startEdit(row.normalized.supplier.id, row.normalized.supplier.supplierName)
          } else {
            toggleSelect(row.normalized.supplier.id)
          }
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        if (editingId) setEditingId(null)
        else setSelectedIds(new Set())
        break
      }
    }
  }, [flatRows, focusedRowIndex, expanded, selectedIds, editingId, showMergeModal, reassigningAlias, parentTypeahead, toggleExpand, toggleSelect, startEdit])

  // Scroll focused row into view
  useEffect(() => {
    const el = tableRef.current?.querySelector(`[data-row-index="${focusedRowIndex}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focusedRowIndex])

  // ── Loading state ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 flex-1">
        <svg className="h-6 w-6 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div ref={outerRef} className="flex flex-col flex-1 overflow-hidden outline-none" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Header: left side (count + merge) + right side (group-by + search) */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-shrink-0">
        {/* Left: supplier count + merge button */}
        <span className="text-[10px] text-gray-400 flex-shrink-0">
          {filtered.length} supplier{filtered.length !== 1 ? 's' : ''}
        </span>

        {selectedIds.size >= 2 && (
          <button
            onClick={() => setShowMergeModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 transition-colors flex-shrink-0"
          >
            <Merge size={13} />
            Merge {selectedIds.size}
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: expand-all + search */}
        <button
          onClick={toggleExpandAll}
          className="inline-flex items-center justify-center p-1.5 text-gray-500 border border-gray-200 rounded-md hover:bg-gray-50 hover:text-gray-700 transition-colors flex-shrink-0 select-none"
          title={allExpanded ? 'Collapse all' : 'Expand all'}
        >
          {allExpanded ? <ChevronsUp size={13} /> : <ChevronsDown size={13} />}
        </button>

        <div className="relative w-48">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md border border-gray-200 bg-white text-gray-700 placeholder:text-gray-300 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 flex items-center justify-between rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      {/* Table */}
      <div ref={tableRef} className="flex-1 overflow-auto outline-none" tabIndex={-1} onClick={focusOuter}>
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
            {searchQuery ? 'No suppliers match your search' : 'No suppliers found'}
          </div>
        ) : (
          <table className="w-full border-collapse text-xs border border-gray-300">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-50">
                <th className="w-8 px-2 py-2.5 border border-gray-300" />
                <th className="w-[18%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Parent</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Normalized Name</th>
                <th className="w-[22%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Raw Alias</th>
                <th className="w-[10%] px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Spend</th>
                <th className="w-[7%] px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Txns</th>
                <th className="w-24 px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody>
              {flatRows.map((row, idx) => {
                const isFocused = idx === focusedRowIndex

                // ── Normalized name row ──
                if (row.type === 'normalized' && row.normalized) {
                  const nr = row.normalized
                  const s = nr.supplier
                  const isExpanded = expanded.has(s.id)
                  const isSelected = selectedIds.has(s.id)
                  const hasAliases = nr.aliasesLoaded ? nr.aliases.length > 0 : (s.aliases?.length ?? 0) > 0

                  return (
                    <tr
                      key={`norm-${s.id}`}
                      data-row-index={idx}
                      className={`cursor-pointer transition-colors ${
                        isFocused ? 'bg-blue-50' : isSelected ? 'bg-violet-50/50' : 'hover:bg-gray-50/50'
                      }`}
                      onClick={() => { setFocusedRowIndex(idx) }}
                    >
                      {/* Expand toggle */}
                      <td className="px-2 py-2 text-center border border-gray-200">
  <button
                          onClick={(e) => { e.stopPropagation(); if (hasAliases) toggleExpand(s.id) }}
                          className={`rounded p-0.5 transition-colors ${hasAliases ? 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 cursor-pointer' : 'text-gray-200 cursor-default'}`}
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>

                      {/* Parent column — always visible */}
                      <td className="px-3 py-2 text-gray-400 border border-gray-200">
                        {s.parentName ? (
                          <span className="text-gray-600">{s.parentName}</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-0.5 text-gray-300 hover:text-violet-500 cursor-pointer transition-colors"
                            onClick={(e) => {
                              e.stopPropagation()
                              const rect = (e.target as HTMLElement).getBoundingClientRect()
                              setParentTypeahead({ supplierId: s.id, anchor: { top: rect.bottom + 4, left: rect.left } })
                            }}
                          >
                            <Plus size={11} /> assign
                          </span>
                        )}
                      </td>

                      {/* Normalized name */}
                      <td className="px-3 py-2 border border-gray-200">
                        <div className="flex items-center gap-2">
                          {editingId === s.id ? (
                            <input
                              ref={editInputRef}
                              value={editDraft}
                              onChange={e => setEditDraft(e.target.value)}
                              onBlur={() => commitEdit(s.id)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.stopPropagation(); commitEdit(s.id) }
                                if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); focusOuter() }
                              }}
                              className="flex-1 px-2 py-0.5 border border-blue-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-400"
                              autoFocus
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            <span
                              className={`font-medium cursor-pointer transition-colors hover:text-blue-600 ${
                                isSelected
                                  ? 'bg-yellow-100 text-yellow-900 px-1 rounded'
                                  : 'text-gray-800'
                              }`}
                              onDoubleClick={() => startEdit(s.id, s.supplierName)}
                              title="Double-click to rename"
                            >
                              {s.supplierName}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Raw alias (empty for normalized row) */}
                      <td className="px-3 py-2 text-gray-300 italic border border-gray-200">
                        {nr.aliasesLoaded ? `${nr.aliases.length} alias${nr.aliases.length !== 1 ? 'es' : ''}` : '—'}
                      </td>

                      {/* Spend */}
                      <td className="px-3 py-2 text-right font-medium text-gray-700 tabular-nums border border-gray-200">
                        {fmtAbbrev(s.totalSpend)}
                      </td>

                      {/* Txns */}
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums border border-gray-200">
                        {s.transactionCount.toLocaleString()}
                      </td>

                      {/* Actions */}
                      <td className="px-2 py-2 border border-gray-200">
                        <div className="flex items-center justify-end gap-1 pr-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteNormalized(s.id) }}
                            className="rounded p-1 text-red-400 hover:bg-red-50 transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                }

                // ── Alias row ──
                if (row.type === 'alias' && row.alias && row.aliasNormalized) {
                  const alias = row.alias
                  const nr = row.aliasNormalized

                  return (
                    <tr
                      key={`alias-${nr.supplier.id}-${alias.rawName}`}
                      data-row-index={idx}
                      className={`cursor-pointer transition-colors ${
                        isFocused ? 'bg-blue-50/60' : 'bg-gray-50/40 hover:bg-gray-50'
                      }`}
                      onClick={() => setFocusedRowIndex(idx)}
                    >
                      {/* Indent */}
                      <td className="px-2 py-1.5 border border-gray-200" />

                      {/* Empty parent cell */}
                      <td className="px-3 py-1.5 border border-gray-200" />

                      {/* Empty normalized name cell */}
                      <td className="px-3 py-1.5 border border-gray-200" />

                      {/* Alias name */}
                      <td className="px-3 py-1.5 border border-gray-200">
                        <div className="flex items-center gap-2 pl-2 border-l-2 border-gray-200">
                          <span className="text-gray-600">{alias.rawName}</span>
                        </div>
                      </td>

                      {/* Spend */}
                      <td className="px-3 py-1.5 text-right text-gray-400 tabular-nums border border-gray-200">
                        {alias.spend > 0 ? fmtAbbrev(alias.spend) : '—'}
                      </td>

                      {/* Txns */}
                      <td className="px-3 py-1.5 text-right text-gray-400 tabular-nums border border-gray-200">
                        {alias.txnCount > 0 ? alias.txnCount.toLocaleString() : '—'}
                      </td>

                      {/* Actions */}
                      <td className="px-2 py-1.5 border border-gray-200">
                        <div className="flex items-center justify-end gap-1 pr-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setReassigningAlias({ alias, normalized: nr })
                            }}
                            className="rounded p-1 text-amber-500 hover:bg-amber-50 transition-colors"
                            title="Reassign alias (Shift+R)"
                          >
                            <ArrowRightLeft size={13} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteAlias(alias, nr.supplier.id) }}
                            className="rounded p-1 text-red-400 hover:bg-red-50 transition-colors"
                            title="Remove alias"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                }

                return null
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Merge modal */}
      {showMergeModal && selectedSuppliers.length >= 2 && (
        <MergeModal
          suppliers={selectedSuppliers}
          onMerge={handleMerge}
          onClose={() => { setShowMergeModal(false); focusOuter() }}
        />
      )}

      {/* Reassign alias modal */}
      {reassigningAlias && (
        <ReassignAliasModal
          alias={reassigningAlias.alias}
          currentNormalized={reassigningAlias.normalized.supplier}
          allSuppliers={suppliers}
          onReassign={(aliasName, toId) =>
            handleReassignAlias(aliasName, reassigningAlias.normalized.supplier.id, toId)
          }
          onClose={() => setReassigningAlias(null)}
        />
      )}

      {/* Parent typeahead popover */}
      {parentTypeahead && (
        <ParentTypeahead
          parents={parents}
          anchor={parentTypeahead.anchor}
          onSelect={(parentId) => handleChangeParent(parentTypeahead.supplierId, parentId)}
          onCreate={(name) => handleCreateParentAndAssign(parentTypeahead.supplierId, name)}
          onRemove={() => handleChangeParent(parentTypeahead.supplierId, null)}
          onClose={() => setParentTypeahead(null)}
          currentParentId={suppliers.find(s => s.id === parentTypeahead.supplierId)?.parentSupplierId ?? null}
        />
      )}
    </div>
  )
}
