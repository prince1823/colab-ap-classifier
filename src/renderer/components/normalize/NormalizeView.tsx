import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Trash2, Plus, Search, X,
  Merge, ArrowRightLeft,
} from 'lucide-react'
import { ipc } from '../../lib/ipc'
import { showError } from '../../lib/toast-errors'
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

interface FlatRow {
  normalized: NormalizedRow
}

// ── Component ────────────────────────────────────────────────────────

interface NormalizeViewProps {
  onDataChange?: () => void
}

export default function NormalizeView({ onDataChange }: NormalizeViewProps = {}) {
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [parents, setParents] = useState<SupplierParent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')

  // Alias cache: supplierId → AliasData[]
  const [aliasCache, setAliasCache] = useState<Map<string, AliasData[]>>(new Map())

  // Selection: set of normalized supplier IDs
  const [selectedSupplierIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Focus — row + column (spreadsheet-style nav)
  // Columns: 0=parent, 1=name, 2=alias, 3=spend, 4=txns, 5=actions
  const COL_COUNT = 6
  const [focusedRowIndex, setFocusedRowIndex] = useState(0)
  const [focusedColIndex, setFocusedColIndex] = useState(0) // start on Parent
  const [focusedAliasIndex, setFocusedAliasIndex] = useState(0) // which alias mini-cell is focused when col=2
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

  // Track which supplier rows show all aliases vs first 4
  const [expandedAliases, setExpandedAliases] = useState<Set<string>>(new Set())

  // Selected alias: { supplierId, alias } — single select
  const [selectedAlias, setSelectedAlias] = useState<{ supplierId: string; alias: AliasData; normalized: NormalizedRow } | null>(null)

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

  // ── Auto-load all aliases ────────────────────────────────────────

  const loadAllAliases = useCallback(async (supplierIds: string[]) => {
    const results = await Promise.all(
      supplierIds.map(async (id) => {
        try {
          const aliases = await ipc.suppliers.getAliases(id)
          return [id, (aliases as string[]).map(name => ({ rawName: name, spend: 0, txnCount: 0 }))] as const
        } catch {
          return [id, []] as const
        }
      })
    )
    setAliasCache(prev => {
      const next = new Map(prev)
      for (const [id, data] of results) next.set(id, data)
      return next
    })
  }, [])

  useEffect(() => {
    if (suppliers.length > 0) {
      const unloaded = suppliers.filter(s => !aliasCache.has(s.id))
      if (unloaded.length > 0) loadAllAliases(unloaded.map(s => s.id))
    }
  }, [suppliers, aliasCache, loadAllAliases])

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

  // ── Flatten into table rows (aliases shown inline) ───────────────

  const flatRows: FlatRow[] = useMemo(() => {
    // Sort by parent name so same-parent rows are adjacent (no-parent rows go last)
    const sorted = [...filtered].sort((a, b) => {
      const pa = a.supplier.parentName?.toLowerCase() ?? '\uffff'
      const pb = b.supplier.parentName?.toLowerCase() ?? '\uffff'
      if (pa !== pb) return pa < pb ? -1 : 1
      return a.supplier.supplierName.toLowerCase() < b.supplier.supplierName.toLowerCase() ? -1 : 1
    })
    return sorted.map(r => ({ normalized: r }))
  }, [filtered])

  // Compute parent grouping: for each row, whether it's the first in its parent group and the group span
  const parentGroupInfo = useMemo(() => {
    const info: { isFirst: boolean; rowSpan: number }[] = []
    let i = 0
    while (i < flatRows.length) {
      const parentName = flatRows[i].normalized.supplier.parentName
      if (!parentName) {
        info.push({ isFirst: true, rowSpan: 1 })
        i++
        continue
      }
      let j = i + 1
      while (j < flatRows.length && flatRows[j].normalized.supplier.parentName === parentName) j++
      const span = j - i
      for (let k = i; k < j; k++) {
        info.push({ isFirst: k === i, rowSpan: span })
      }
      i = j
    }
    return info
  }, [flatRows])

  // ── Actions ───────────────────────────────────────────────────────

  const handleRename = useCallback(async (supplierId: string, newName: string) => {
    try {
      await ipc.suppliers.rename(supplierId, newName)
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, supplierName: newName } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed')
    }
    setEditingId(null)
  }, [onDataChange])

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
      setSelectedIds(prev => { const n = new Set(prev); n.delete(supplierId); return n })
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [suppliers, aliasCache, onDataChange])

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
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change parent')
    }
    setParentTypeahead(null)
  }, [parents, onDataChange])

  const handleRenameParent = useCallback(async (parentId: string, newName: string) => {
    try {
      await ipc.suppliers.renameParent(parentId, newName)
      setParents(prev => prev.map(p => p.id === parentId ? { ...p, name: newName } : p))
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentName: newName } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename parent failed')
    }
    setEditingParentId(null)
  }, [onDataChange])

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
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete parent')
    }
    setPendingDeleteParentRowId(null)
  }, [suppliers, onDataChange])

  const handleCreateParentAndAssign = useCallback(async (supplierId: string, name: string) => {
    try {
      const parent = await ipc.suppliers.addParent(name) as SupplierParent
      setParents(prev => [...prev, parent])
      await ipc.suppliers.assignParent([supplierId], parent.id)
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parent.id, parentName: parent.name } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create parent')
    }
    setParentTypeahead(null)
  }, [onDataChange])

  const handleMerge = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      await ipc.suppliers.merge(survivorId, losingIds)

      const losingSet = new Set(losingIds)

      // Immediately remove losers from local state — no full reload, no visual disruption
      setSuppliers(prev => prev.filter(s => !losingSet.has(s.id)))
      setSelectedIds(prev => { const n = new Set(prev); losingSet.forEach(id => n.delete(id)); n.delete(survivorId); return n })
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
      }).catch((e) => showError('Failed to reload supplier aliases', e))

      // Silently refresh spend/txn counts in background — no loading state, no collapse
      ipc.suppliers.list().then(fresh => {
        setSuppliers(fresh as ProjectSupplierView[])
      }).catch((e) => showError('Failed to refresh supplier list', e))

      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    }
    setShowMergeModal(false)
  }, [onDataChange])

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
      }).catch((e) => showError('Failed to refresh supplier data after parent merge', e))

      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge parents failed')
    }
    setShowMergeModal(false)
  }, [parents, onDataChange])

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
      }).catch((e) => showError('Failed to refresh supplier list after alias reassign', e))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
    }
    setReassigningAlias(null)
  }, [onDataChange])

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

  // Track which column the selection was made in so yellow stays there
  const [selectedColIndex, setSelectedColIndex] = useState(0)

  const toggleSelect = useCallback((id: string) => {
    setSelectedColIndex(focusedColIndex)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [focusedColIndex])

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
        if (selectedColIndex === 0) {
          // Parent column selected — merge parents
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

    // Cmd+P: parent typeahead
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault()
      if (row.normalized) {
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

    // Helper: get visible alias count for current row
    const getVisibleAliasCount = () => {
      const nr = row.normalized
      if (!nr.aliasesLoaded || nr.aliases.length === 0) return 0
      const showAll = expandedAliases.has(nr.supplier.id)
      return showAll ? nr.aliases.length : Math.min(4, nr.aliases.length)
    }

    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault()
        if (focusedColIndex === 2) {
          // Navigate within alias mini-cells
          if (focusedAliasIndex > 0) {
            setFocusedAliasIndex(focusedAliasIndex - 1)
            return
          }
          // At top alias — move to previous row, stay on alias col, focus last alias
          if (focusedRowIndex > 0) {
            setFocusedRowIndex(focusedRowIndex - 1)
            const prevRow = flatRows[focusedRowIndex - 1]
            const prevShowAll = expandedAliases.has(prevRow.normalized.supplier.id)
            const prevCount = prevRow.normalized.aliasesLoaded
              ? (prevShowAll ? prevRow.normalized.aliases.length : Math.min(4, prevRow.normalized.aliases.length))
              : 0
            setFocusedAliasIndex(Math.max(0, prevCount - 1))
          }
        } else if (e.shiftKey) {
          const prev = focusedRowIndex - 1
          if (prev >= 0) {
            setFocusedRowIndex(prev)
            toggleSelect(flatRows[prev].normalized.supplier.id)
          }
        } else {
          setFocusedRowIndex(Math.max(0, focusedRowIndex - 1))
          setFocusedAliasIndex(0)
        }
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        if (focusedColIndex === 2) {
          const visCount = getVisibleAliasCount()
          if (focusedAliasIndex < visCount - 1) {
            setFocusedAliasIndex(focusedAliasIndex + 1)
            return
          }
          // At bottom alias — move to next row, stay on alias col, focus first alias
          if (focusedRowIndex < flatRows.length - 1) {
            setFocusedRowIndex(focusedRowIndex + 1)
            setFocusedAliasIndex(0)
          }
        } else if (e.shiftKey) {
          const next = focusedRowIndex + 1
          if (next < flatRows.length) {
            setFocusedRowIndex(next)
            toggleSelect(flatRows[next].normalized.supplier.id)
          }
        } else {
          setFocusedRowIndex(Math.min(flatRows.length - 1, focusedRowIndex + 1))
          setFocusedAliasIndex(0)
        }
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (focusedColIndex < COL_COUNT - 1) {
          setFocusedColIndex(focusedColIndex + 1)
          if (focusedColIndex + 1 === 2) setFocusedAliasIndex(0) // entering alias col
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (focusedColIndex > 0) {
          setFocusedColIndex(focusedColIndex - 1)
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        const nr = row.normalized
        if (focusedColIndex === 2 && nr.aliasesLoaded && nr.aliases.length > 0) {
          // Enter on a focused alias → toggle select it
          const showAll = expandedAliases.has(nr.supplier.id)
          const visible = showAll ? nr.aliases : nr.aliases.slice(0, 4)
          const alias = visible[focusedAliasIndex]
          if (alias) {
            setSelectedAlias(prev =>
              prev && prev.supplierId === nr.supplier.id && prev.alias.rawName === alias.rawName
                ? null
                : { supplierId: nr.supplier.id, alias, normalized: nr }
            )
          }
        } else if (e.shiftKey) {
          if (focusedColIndex === 0 && nr.supplier.parentName) {
            startEditParent(nr.supplier.id, nr.supplier.parentName)
          } else if (focusedColIndex === 1) {
            startEdit(nr.supplier.id, nr.supplier.supplierName)
          }
        } else if (focusedColIndex <= 1) {
          toggleSelect(nr.supplier.id)
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        if (selectedAlias) setSelectedAlias(null)
        else if (editingId) setEditingId(null)
        else if (editingParentId) setEditingParentId(null)
        else setSelectedIds(new Set())
        break
      }
      default: {
        // Shift+R → reassign selected alias
        if (e.shiftKey && e.key.toLowerCase() === 'r' && selectedAlias) {
          e.preventDefault()
          setReassigningAlias({ alias: selectedAlias.alias, normalized: selectedAlias.normalized })
          setSelectedAlias(null)
        }
        break
      }
    }
  }, [flatRows, focusedRowIndex, focusedColIndex, focusedAliasIndex, selectedSupplierIds, editingId, editingParentId, showMergeModal, reassigningAlias, parentTypeahead, toggleSelect, startEdit, startEditParent, suppliers, focusOuter, expandedAliases, selectedAlias])

  // Global Cmd+key shortcuts — work even when focus is on search input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (showMergeModal || reassigningAlias || parentTypeahead) return

      const row = flatRows[focusedRowIndex]
      if (!row) return

      if (e.key === 'm') {
        e.preventDefault()
        if (selectedSupplierIds.size >= 2) {
          if (selectedColIndex === 0) {
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
      }

      if (e.key === 'p') {
        e.preventDefault()
        if (row.normalized) {
          const el = tableRef.current?.querySelector(`[data-row-index="${focusedRowIndex}"]`)
          if (el) {
            const rect = el.getBoundingClientRect()
            setParentTypeahead({
              supplierId: row.normalized.supplier.id,
              anchor: { top: rect.bottom + 4, left: rect.left + 100 },
            })
          }
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [flatRows, focusedRowIndex, selectedSupplierIds, selectedColIndex, showMergeModal, reassigningAlias, parentTypeahead, suppliers])

  // Scroll focused row into view
  useEffect(() => {
    const el = tableRef.current?.querySelector(`[data-row-index="${focusedRowIndex}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focusedRowIndex])

  // Helper: focused cell ring style (suppress on alias col when navigating within aliases)
  const cellFocus = (rowIdx: number, colIdx: number) =>
    rowIdx === focusedRowIndex && colIdx === focusedColIndex && !(colIdx === 2 && flatRows[rowIdx]?.normalized?.aliasesLoaded && flatRows[rowIdx]?.normalized?.aliases.length > 0)
      ? 'ring-2 ring-inset ring-blue-400'
      : ''

  // Helper: selection highlight — yellow stays on the column where Enter was pressed
  const cellSelect = (colIdx: number, isSelected: boolean) =>
    isSelected && colIdx === selectedColIndex
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
              if (selectedColIndex === 0) {
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

        {/* Keyboard shortcut hints */}
        <div className="flex-1 flex items-center justify-center gap-3 text-[10px] text-gray-400 select-none">
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[9px]">Up / Down</kbd> Navigate</span>
          <span className="text-gray-300">·</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[9px]">Cmd + P</kbd> Assign Parent</span>
          <span className="text-gray-300">·</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[9px]">Cmd + M</kbd> Merge</span>
          <span className="text-gray-300">·</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[9px]">Shift + Enter</kbd> Edit</span>
          <span className="text-gray-300">·</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[9px]">Enter</kbd> Select Alias</span>
          <span className="text-gray-300">·</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[9px]">Shift + R</kbd> Reassign Alias</span>
        </div>

        {/* Right: search */}
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
                <th className="w-[22%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Aliases</th>
                <th className="w-[10%] px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Spend</th>
                <th className="w-[7%] px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Txns</th>
                <th className="w-24 px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody>
              {flatRows.map((row, idx) => {
                const isFocused = idx === focusedRowIndex
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
                      {/* Col 0: Parent (rowSpan for same-parent groups) */}
                      {parentGroupInfo[idx]?.isFirst && (
                      <td
                        rowSpan={parentGroupInfo[idx]?.rowSpan ?? 1}
                        className={`px-3 py-2.5 text-gray-400 border border-gray-300 align-top ${cellFocus(idx, 0)} ${cellSelect(0, isSelected)}`}
                        onClick={(e) => { e.stopPropagation(); setFocusedRowIndex(idx); setFocusedColIndex(0) }}
                      >
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
                                onDoubleClick={(e) => { e.stopPropagation(); startEditParent(s.id, s.parentName!) }}
                                title="Double-click or Shift+Enter to rename"
                              >
                                {s.parentName}
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); setPendingDeleteParentRowId(s.id) }}
                                className="rounded p-0.5 text-stone-300 hover:text-red-400 transition-colors"
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
                      )}

                      {/* Col 1: Normalized name */}
                      <td className={`px-3 py-2.5 border border-gray-300 align-top ${cellFocus(idx, 1)} ${cellSelect(1, isSelected)}`} onClick={() => { setFocusedColIndex(1) }}>
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
                              onDoubleClick={(e) => { e.stopPropagation(); startEdit(s.id, s.supplierName) }}
                              title="Double-click to rename"
                            >
                              {s.supplierName}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Col 2: Aliases (each in its own mini cell) */}
                      <td className={`p-0 border border-gray-300 align-top ${cellFocus(idx, 2)} ${cellSelect(2, isSelected)}`} onClick={() => { setFocusedColIndex(2) }}>
                        {nr.aliasesLoaded ? (
                          nr.aliases.length > 0 ? (() => {
                            const showAll = expandedAliases.has(s.id)
                            const visible = showAll ? nr.aliases : nr.aliases.slice(0, 4)
                            const remaining = nr.aliases.length - 4
                            return (
                              <div className="flex flex-col">
                                {visible.map((alias, aliasIdx) => (
                                  <div
                                    key={alias.rawName}
                                    className={`flex items-center justify-between gap-1 px-3 py-1 border-b border-gray-200 last:border-b-0 ${
                                      selectedAlias && selectedAlias.supplierId === s.id && selectedAlias.alias.rawName === alias.rawName
                                        ? 'bg-blue-100 ring-1 ring-inset ring-blue-400'
                                        : isFocused && focusedColIndex === 2 && focusedAliasIndex === aliasIdx
                                          ? 'bg-blue-50 ring-1 ring-inset ring-blue-300'
                                          : ''
                                    }`}
                                    onClick={(e) => { e.stopPropagation(); setFocusedRowIndex(idx); setFocusedColIndex(2); setFocusedAliasIndex(aliasIdx) }}
                                  >
                                    <span className="text-stone-500 text-[11px] truncate" title={alias.rawName}>{alias.rawName}</span>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setReassigningAlias({ alias, normalized: nr })
                                      }}
                                      className="flex-shrink-0 rounded p-0.5 text-stone-300 hover:text-amber-500 transition-colors"
                                      title="Reassign alias"
                                    >
                                      <ArrowRightLeft size={10} />
                                    </button>
                                  </div>
                                ))}
                                {remaining > 0 && !showAll && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setExpandedAliases(prev => { const n = new Set(prev); n.add(s.id); return n })
                                    }}
                                    className="text-[10px] text-blue-500 hover:text-blue-700 px-3 py-1 text-left transition-colors"
                                  >
                                    +{remaining} more
                                  </button>
                                )}
                                {showAll && nr.aliases.length > 4 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setExpandedAliases(prev => { const n = new Set(prev); n.delete(s.id); return n })
                                    }}
                                    className="text-[10px] text-blue-500 hover:text-blue-700 px-3 py-1 text-left border-t border-gray-200 transition-colors"
                                  >
                                    show less
                                  </button>
                                )}
                              </div>
                            )
                          })() : (
                            <div className="px-3 py-2"><span className="text-gray-300 italic text-[10px]">no aliases</span></div>
                          )
                        ) : (
                          <div className="px-3 py-2"><span className="text-gray-300 text-[10px]">loading...</span></div>
                        )}
                      </td>

                      {/* Col 3: Spend */}
                      <td className={`px-3 py-2.5 text-right font-medium text-gray-700 tabular-nums border border-gray-300 align-top ${cellFocus(idx, 3)} ${cellSelect(3, isSelected)}`} onClick={() => { setFocusedColIndex(3) }}>
                        {fmtAbbrev(s.totalSpend)}
                      </td>

                      {/* Col 4: Txns */}
                      <td className={`px-3 py-2.5 text-right text-gray-600 tabular-nums border border-gray-300 align-top ${cellFocus(idx, 4)} ${cellSelect(4, isSelected)}`} onClick={() => { setFocusedColIndex(4) }}>
                        {s.transactionCount.toLocaleString()}
                      </td>

                      {/* Col 5: Actions */}
                      <td className={`px-2 py-2.5 border border-gray-300 align-top ${cellFocus(idx, 5)} ${cellSelect(5, isSelected)}`} onClick={() => { setFocusedColIndex(5) }}>
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
