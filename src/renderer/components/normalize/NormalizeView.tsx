import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Maximize2, Minimize2, Trash2, Plus, Search, X,
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
  const [selectedSupplierIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Focus — row + column (spreadsheet-style nav)
  // Columns: 0=parent, 1=name, 2=alias, 3=spend, 4=txns, 5=actions
  const COL_COUNT = 6
  const [focusedRowIndex, setFocusedRowIndex] = useState(0)
  const [focusedColIndex, setFocusedColIndex] = useState(0) // start on Parent
  const outerRef = useRef<HTMLDivElement>(null)  // owns onKeyDown — always focus this
  const tableRef = useRef<HTMLDivElement>(null)  // scroll container

  const focusOuter = useCallback(() => {
    setTimeout(() => outerRef.current?.focus(), 50)
  }, [])

  // Inline editing — normalized name
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Inline editing — parent name
  const [editingParentId, setEditingParentId] = useState<string | null>(null)
  const [editParentDraft, setEditParentDraft] = useState('')
  const editParentInputRef = useRef<HTMLInputElement>(null)

  // Modals
  const [showMergeModal, setShowMergeModal] = useState(false)
  const [mergeMode, setMergeMode] = useState<'supplier' | 'parent'>('supplier')
  const [reassigningAlias, setReassigningAlias] = useState<{ alias: AliasData; normalized: NormalizedRow } | null>(null)

  // Parent typeahead
  const [parentTypeahead, setParentTypeahead] = useState<{ supplierId: string; anchor: { top: number; left: number } } | null>(null)

  // Pending parent delete confirmation (holds parentSupplierId)
  const [pendingDeleteParentRowId, setPendingDeleteParentRowId] = useState<string | null>(null)

  // Re-focus outer div whenever all modals/popovers/edits are closed (also on initial load)
  useEffect(() => {
    if (!loading && !showMergeModal && !reassigningAlias && !parentTypeahead && !editingId && !editingParentId) {
      outerRef.current?.focus()
    }
  }, [loading, showMergeModal, reassigningAlias, parentTypeahead, editingId, editingParentId])

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
      await ipc.suppliers.assignParent([supplierId], parentId)
      const parent = parentId ? parents.find(p => p.id === parentId) : null
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parentId, parentName: parent?.name ?? null } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change parent')
    }
    setParentTypeahead(null)
  }, [parents])

  const handleRenameParent = useCallback(async (parentId: string, newName: string) => {
    try {
      await ipc.suppliers.renameParent(parentId, newName)
      setParents(prev => prev.map(p => p.id === parentId ? { ...p, name: newName } : p))
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentName: newName } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename parent failed')
    }
    setEditingParentId(null)
  }, [])

  const handleDeleteParent = useCallback(async (parentId: string) => {
    // Unassign all children first
    const children = suppliers.filter(s => s.parentSupplierId === parentId)
    try {
      await ipc.suppliers.assignParent(children.map(s => s.id), null)
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentSupplierId: null, parentName: null } : s
      ))
      await ipc.suppliers.deleteParent(parentId)
      setParents(prev => prev.filter(p => p.id !== parentId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete parent')
    }
    setPendingDeleteParentRowId(null)
  }, [suppliers])

  const handleCreateParentAndAssign = useCallback(async (supplierId: string, name: string) => {
    try {
      const parent = await ipc.suppliers.addParent(name) as SupplierParent
      setParents(prev => [...prev, parent])
      await ipc.suppliers.assignParent([supplierId], parent.id)
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
        n.delete(survivorId) // invalidate survivor so aliases reload fresh
        return n
      })

      // Reload survivor aliases directly (not inside a setState updater)
      ipc.suppliers.getAliases(survivorId).then(aliases => {
        const aliasData: AliasData[] = (aliases as string[]).map(name => ({
          rawName: name, spend: 0, txnCount: 0,
        }))
        setAliasCache(c => new Map(c).set(survivorId, aliasData))
      }).catch(() => {})

      // Silently refresh spend/txn counts in background — no loading state, no collapse
      ipc.suppliers.list().then(fresh => {
        setSuppliers(fresh as ProjectSupplierView[])
      }).catch(() => { /* non-fatal */ })

    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    }
    setShowMergeModal(false)
  }, [])

  const handleMergeParents = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      await ipc.suppliers.mergeParents(survivorId, losingIds)

      const losingSet = new Set(losingIds)
      const survivorParent = parents.find(p => p.id === survivorId)

      // Update local state: reassign children of losers to survivor, remove loser parents
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId && losingSet.has(s.parentSupplierId)
          ? { ...s, parentSupplierId: survivorId, parentName: survivorParent?.name ?? null }
          : s
      ))
      setParents(prev => prev.filter(p => !losingSet.has(p.id)))
      setSelectedIds(new Set())

      // Background refresh
      Promise.all([
        ipc.suppliers.list(),
        ipc.suppliers.listParents(),
      ]).then(([freshSuppliers, freshParents]) => {
        setSuppliers(freshSuppliers as ProjectSupplierView[])
        setParents(freshParents as SupplierParent[])
      }).catch(() => {})

    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge parents failed')
    }
    setShowMergeModal(false)
  }, [parents])

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
      // Refresh spend totals — transactions moved, so both suppliers' spend changed
      ipc.suppliers.list().then(fresh => {
        setSuppliers(fresh as ProjectSupplierView[])
      }).catch(() => {})
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

  const startEditParent = useCallback((supplierId: string, currentParentName: string) => {
    setEditingParentId(supplierId)
    setEditParentDraft(currentParentName)
    setTimeout(() => editParentInputRef.current?.focus(), 0)
  }, [])

  const commitEditParent = useCallback((supplierId: string) => {
    const trimmed = editParentDraft.trim()
    const supplier = suppliers.find(s => s.id === supplierId)
    if (trimmed && supplier?.parentSupplierId && trimmed !== supplier.parentName) {
      handleRenameParent(supplier.parentSupplierId, trimmed)
    } else {
      setEditingParentId(null)
    }
    focusOuter()
  }, [editParentDraft, suppliers, handleRenameParent, focusOuter])

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
    suppliers.filter(s => selectedSupplierIds.has(s.id)),
    [suppliers, selectedSupplierIds]
  )

  // Unique parents from selected suppliers (for parent merge mode)
  const selectedParents = useMemo(() => {
    const parentIds = new Set<string>()
    for (const sid of selectedSupplierIds) {
      const sup = suppliers.find(s => s.id === sid)
      if (sup?.parentSupplierId) parentIds.add(sup.parentSupplierId)
    }
    return parents.filter(p => parentIds.has(p.id))
  }, [suppliers, parents, selectedSupplierIds])

  const parentChildCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of selectedParents) {
      counts.set(p.id, suppliers.filter(s => s.parentSupplierId === p.id).length)
    }
    return counts
  }, [selectedParents, suppliers])

  // ── Keyboard navigation ───────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't handle table shortcuts while a modal is open — let the modal own the keyboard
    if (showMergeModal || reassigningAlias || parentTypeahead) return

    const row = flatRows[focusedRowIndex]
    if (!row) return

    // Cmd+M: merge modal
    if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
      e.preventDefault()
      if (selectedSupplierIds.size >= 2) {
        if (focusedColIndex === 0) {
          // Parent column focused — merge parents
          const uniqueParentIds = new Set<string>()
          for (const sid of selectedSupplierIds) {
            const sup = suppliers.find(s => s.id === sid)
            if (sup?.parentSupplierId) uniqueParentIds.add(sup.parentSupplierId)
          }
          if (uniqueParentIds.size >= 2) {
            setMergeMode('parent')
            setShowMergeModal(true)
          }
        } else {
          setMergeMode('supplier')
          setShowMergeModal(true)
        }
      }
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
        if (e.metaKey || e.ctrlKey) {
          // Cmd+Right: expand aliases
          const nr = row.type === 'normalized' ? row.normalized
            : row.type === 'alias' ? row.aliasNormalized : null
          if (nr && !expanded.has(nr.supplier.id)) toggleExpand(nr.supplier.id)
        } else {
          setFocusedColIndex(c => Math.min(COL_COUNT - 1, c + 1))
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) {
          // Cmd+Left: collapse aliases
          const nr = row.type === 'normalized' ? row.normalized
            : row.type === 'alias' ? row.aliasNormalized : null
          if (nr && expanded.has(nr.supplier.id)) {
            // If on an alias row, jump up to the normalized row first
            if (row.type === 'alias') {
              const parentIdx = flatRows.findIndex(
                r => r.type === 'normalized' && r.normalized?.supplier.id === nr.supplier.id
              )
              if (parentIdx >= 0) setFocusedRowIndex(parentIdx)
            }
            toggleExpand(nr.supplier.id)
          }
        } else {
          setFocusedColIndex(c => Math.max(0, c - 1))
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (row.type === 'normalized' && row.normalized) {
          if (e.shiftKey) {
            // Shift+Enter on parent column → inline edit parent name
            if (focusedColIndex === 0 && row.normalized.supplier.parentName) {
              startEditParent(row.normalized.supplier.id, row.normalized.supplier.parentName)
            }
            // Shift+Enter on name column → inline edit normalized name
            else if (focusedColIndex === 1) {
              startEdit(row.normalized.supplier.id, row.normalized.supplier.supplierName)
            }
          } else if (focusedColIndex <= 2) {
            toggleSelect(row.normalized.supplier.id)
          }
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        if (editingId) setEditingId(null)
        else if (editingParentId) setEditingParentId(null)
        else setSelectedIds(new Set())
        break
      }
    }
  }, [flatRows, focusedRowIndex, focusedColIndex, expanded, selectedSupplierIds, editingId, editingParentId, showMergeModal, reassigningAlias, parentTypeahead, toggleExpand, toggleSelect, startEdit, startEditParent])

  // Scroll focused row into view
  useEffect(() => {
    const el = tableRef.current?.querySelector(`[data-row-index="${focusedRowIndex}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focusedRowIndex])

  // Helper: focused cell ring style
  const cellFocus = (rowIdx: number, colIdx: number) =>
    rowIdx === focusedRowIndex && colIdx === focusedColIndex
      ? 'ring-2 ring-inset ring-blue-400'
      : ''

  // Helper: selection highlight — only the focused column gets yellow bg on selected rows
  const cellSelect = (colIdx: number, isSelected: boolean) =>
    isSelected && colIdx === focusedColIndex
      ? 'bg-yellow-100'
      : ''

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
      {/* Header: left side (count + merge) + right side (expand-all + search) */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-shrink-0">
        {/* Left: supplier count + merge button */}
        <span className="text-[10px] text-gray-400 flex-shrink-0">
          {filtered.length} supplier{filtered.length !== 1 ? 's' : ''}
        </span>

        {selectedSupplierIds.size >= 2 && (
          <button
            onClick={() => {
              if (focusedColIndex === 0) {
                const uniqueParentIds = new Set<string>()
                for (const sid of selectedSupplierIds) {
                  const sup = suppliers.find(s => s.id === sid)
                  if (sup?.parentSupplierId) uniqueParentIds.add(sup.parentSupplierId)
                }
                if (uniqueParentIds.size >= 2) {
                  setMergeMode('parent')
                } else {
                  setMergeMode('supplier')
                }
              } else {
                setMergeMode('supplier')
              }
              setShowMergeModal(true)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 transition-colors flex-shrink-0"
          >
            <Merge size={13} />
            Merge {selectedSupplierIds.size}
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
          {allExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
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
                  const isSelected = selectedSupplierIds.has(s.id)

                  return (
                    <tr
                      key={`norm-${s.id}`}
                      data-row-index={idx}
                      className={`cursor-pointer transition-colors ${
                        isFocused ? 'bg-slate-100' : 'bg-slate-50/40 hover:bg-slate-50'
                      }`}
                      onClick={() => setFocusedRowIndex(idx)}
                    >
                      {/* Col 0: Parent */}
                      <td className={`px-3 py-2.5 text-gray-400 border border-gray-300 ${cellFocus(idx, 0)} ${cellSelect(0, isSelected)}`} onClick={() => { setFocusedColIndex(0) }}>
                        {editingParentId === s.id ? (
                          <input
                            ref={editParentInputRef}
                            value={editParentDraft}
                            onChange={e => setEditParentDraft(e.target.value)}
                            onBlur={() => commitEditParent(s.id)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.stopPropagation(); commitEditParent(s.id) }
                              if (e.key === 'Escape') { e.stopPropagation(); setEditingParentId(null); focusOuter() }
                            }}
                            className="w-full px-2 py-0.5 border border-blue-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-400"
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                        ) : s.parentName ? (
                          pendingDeleteParentRowId === s.id ? (
                            <div className="flex flex-col gap-1.5">
                              <span className="text-[10px] text-amber-600 leading-tight">
                                Reassign or remove all suppliers under this parent before deleting
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDeleteParent(s.parentSupplierId!) }}
                                  className="text-[10px] px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
                                >
                                  Confirm Delete
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setPendingDeleteParentRowId(null) }}
                                  className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <span className="group/parent inline-flex items-center gap-1">
                              <span
                                className="font-semibold text-gray-700 cursor-pointer hover:text-blue-600 transition-colors"
                                onDoubleClick={() => startEditParent(s.id, s.parentName!)}
                                title="Double-click or Shift+Enter to rename"
                              >
                                {s.parentName}
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); setPendingDeleteParentRowId(s.id) }}
                                className="opacity-0 group-hover/parent:opacity-100 rounded p-0.5 text-gray-300 hover:text-red-400 hover:bg-red-50 transition-all"
                                title="Delete parent"
                              >
                                <X size={11} />
                              </button>
                            </span>
                          )
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

                      {/* Col 1: Normalized name */}
                      <td className={`px-3 py-2.5 border border-gray-300 ${cellFocus(idx, 1)} ${cellSelect(1, isSelected)}`} onClick={() => { setFocusedColIndex(1) }}>
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
                              className="font-medium cursor-pointer transition-colors hover:text-blue-600 text-gray-800"
                              onDoubleClick={() => startEdit(s.id, s.supplierName)}
                              title="Double-click to rename"
                            >
                              {s.supplierName}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Col 2: Raw alias (empty for normalized row) */}
                      <td className={`px-3 py-2.5 text-gray-400 italic border border-gray-300 ${cellFocus(idx, 2)} ${cellSelect(2, isSelected)}`} onClick={() => { setFocusedColIndex(2) }}>
                        {nr.aliasesLoaded ? `${nr.aliases.length} alias${nr.aliases.length !== 1 ? 'es' : ''}` : '—'}
                      </td>

                      {/* Col 3: Spend */}
                      <td className={`px-3 py-2.5 text-right font-medium text-gray-700 tabular-nums border border-gray-300 ${cellFocus(idx, 3)} ${cellSelect(3, isSelected)}`} onClick={() => { setFocusedColIndex(3) }}>
                        {fmtAbbrev(s.totalSpend)}
                      </td>

                      {/* Col 4: Txns */}
                      <td className={`px-3 py-2.5 text-right text-gray-600 tabular-nums border border-gray-300 ${cellFocus(idx, 4)} ${cellSelect(4, isSelected)}`} onClick={() => { setFocusedColIndex(4) }}>
                        {s.transactionCount.toLocaleString()}
                      </td>

                      {/* Col 5: Actions */}
                      <td className={`px-2 py-2.5 border border-gray-300 ${cellFocus(idx, 5)} ${cellSelect(5, isSelected)}`} onClick={() => { setFocusedColIndex(5) }}>
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
                        isFocused ? 'bg-amber-50' : 'bg-orange-50/30 hover:bg-orange-50/50'
                      }`}
                      onClick={() => setFocusedRowIndex(idx)}
                    >
                      {/* Col 0: Empty parent cell */}
                      <td className={`px-3 py-1.5 border border-orange-100 ${cellFocus(idx, 0)}`} onClick={() => { setFocusedColIndex(0) }} />

                      {/* Col 1: Empty normalized name cell */}
                      <td className={`px-3 py-1.5 border border-orange-100 ${cellFocus(idx, 1)}`} onClick={() => { setFocusedColIndex(1) }} />

                      {/* Col 2: Alias name */}
                      <td className={`px-3 py-1.5 border border-orange-100 ${cellFocus(idx, 2)}`} onClick={() => { setFocusedColIndex(2) }}>
                        <div className="flex items-center gap-2 pl-3 border-l-2 border-orange-200">
                          <span className="text-stone-500 text-[11px]">{alias.rawName}</span>
                        </div>
                      </td>

                      {/* Col 3: Spend */}
                      <td className={`px-3 py-1.5 text-right text-stone-400 tabular-nums border border-orange-100 ${cellFocus(idx, 3)}`} onClick={() => { setFocusedColIndex(3) }}>
                        {alias.spend > 0 ? fmtAbbrev(alias.spend) : '—'}
                      </td>

                      {/* Col 4: Txns */}
                      <td className={`px-3 py-1.5 text-right text-stone-400 tabular-nums border border-orange-100 ${cellFocus(idx, 4)}`} onClick={() => { setFocusedColIndex(4) }}>
                        {alias.txnCount > 0 ? alias.txnCount.toLocaleString() : '—'}
                      </td>

                      {/* Col 5: Actions */}
                      <td className={`px-2 py-1.5 border border-orange-100 ${cellFocus(idx, 5)}`} onClick={() => { setFocusedColIndex(5) }}>
                        <div className="flex items-center justify-end gap-1 pr-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setReassigningAlias({ alias, normalized: nr })
                            }}
                            className="rounded p-1 text-stone-300 hover:text-amber-500 hover:bg-amber-50 transition-colors"
                            title="Reassign alias (Shift+R)"
                          >
                            <ArrowRightLeft size={12} />
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
      {showMergeModal && mergeMode === 'parent' && selectedParents.length >= 2 && (
        <MergeModal
          mode="parent"
          parents={selectedParents}
          childCounts={parentChildCounts}
          onMerge={handleMergeParents}
          onClose={() => { setShowMergeModal(false); focusOuter() }}
        />
      )}
      {showMergeModal && mergeMode === 'supplier' && selectedSuppliers.length >= 2 && (
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
