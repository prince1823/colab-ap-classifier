import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ChevronRight, ChevronDown, Plus, Trash2, Merge, Maximize2, Minimize2, Upload } from 'lucide-react'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

// ── Inline editable cell ─────────────────────────────────────────────
function EditableCell({
  value,
  onSave,
  placeholder,
  className = '',
}: {
  value: string
  onSave: (val: string) => void
  placeholder?: string
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }, [draft, value, onSave])

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="w-full bg-white border border-blue-300 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-400"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(value); setEditing(false) }
        }}
      />
    )
  }

  return (
    <span
      className={`cursor-pointer rounded px-1.5 py-0.5 hover:bg-blue-50 transition-colors ${className}`}
      onDoubleClick={() => { setDraft(value); setEditing(true) }}
      title="Double-click to edit"
    >
      {value || <span className="italic text-gray-300">{placeholder ?? '—'}</span>}
    </span>
  )
}

// ── Truncated description cell with "more"/"less" ───────────────────
function DescriptionCell({
  value,
  onSave,
}: {
  value: string
  onSave: (val: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }, [draft, value, onSave])

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        className="w-full bg-white border border-blue-300 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-400 resize-none"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(value); setEditing(false) }
        }}
      />
    )
  }

  if (!value) {
    return (
      <span
        className="cursor-pointer text-xs italic text-gray-300 hover:text-blue-400 transition-colors px-1 py-0.5"
        onDoubleClick={() => { setDraft(''); setEditing(true) }}
        title="Double-click to add description"
      >
        —
      </span>
    )
  }

  const needsTruncation = value.length > 100

  return (
    <div>
      <span
        className="text-xs text-gray-600 cursor-pointer hover:bg-blue-50 rounded px-1 py-0.5 transition-colors inline-block"
        style={!expanded && needsTruncation ? {
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        } : undefined}
        onDoubleClick={() => { setDraft(value); setEditing(true) }}
        title="Double-click to edit"
      >
        {value}
      </span>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-[10px] font-medium text-blue-500 hover:text-blue-700 hover:underline transition-colors"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

// ── Tree node types ──────────────────────────────────────────────────
type L3Tree = TaxonomyNode
type L2Tree = TaxonomyNode & { children: L3Tree[] }
type L1Tree = TaxonomyNode & { children: L2Tree[] }

// ── Flattened row for table ──────────────────────────────────────────
interface FlatRow {
  node: TaxonomyNode
  level: 1 | 2 | 3
  isFirstInL1: boolean
  isFirstInL2: boolean
  l1RowSpan: number
  l2RowSpan: number
  l1Node: L1Tree
  l2Node: L2Tree | null
  addRow?: 'add-l1' | 'add-l2' | 'add-l3'
}

export default function TaxonomyPage() {
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  const [nodes, setNodes] = useState<TaxonomyNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const [collapsedL1, setCollapsedL1] = useState<Set<string>>(new Set())
  const [collapsedL2, setCollapsedL2] = useState<Set<string>>(new Set())

  const [addingUnder, setAddingUnder] = useState<string | null>(null)
  const [addName, setAddName] = useState('')
  const [addDescription, setAddDescription] = useState('')
  const [addSaving, setAddSaving] = useState(false)

  const [mergingNodeId, setMergingNodeId] = useState<string | null>(null)
  const [mergeSearch, setMergeSearch] = useState('')
  const [mergeAnchor, setMergeAnchor] = useState<{ top: number; left: number } | null>(null)
  const mergePopoverRef = useRef<HTMLDivElement>(null)
  const mergeInputRef = useRef<HTMLInputElement>(null)

  const [searchQuery, setSearchQuery] = useState('')

  // Close merge popover on click outside
  useEffect(() => {
    if (!mergingNodeId) return
    const handler = (e: MouseEvent) => {
      if (mergePopoverRef.current && !mergePopoverRef.current.contains(e.target as Node)) {
        setMergingNodeId(null); setMergeSearch(''); setMergeAnchor(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [mergingNodeId])

  // Focus merge input when popover opens
  useEffect(() => {
    if (mergingNodeId && mergeInputRef.current) mergeInputRef.current.focus()
  }, [mergingNodeId])

  const openMergeAt = useCallback((nodeId: string, buttonEl: HTMLButtonElement) => {
    const rect = buttonEl.getBoundingClientRect()
    setMergingNodeId(nodeId)
    setMergeSearch('')
    setAddingUnder(null)
    setMergeAnchor({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 340) })
  }, [])

  // ── Data loading ────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const n = await ipc.taxonomy.getNodes()
      setNodes(n)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load taxonomy')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ── Build tree ──────────────────────────────────────────────────────
  const tree: L1Tree[] = useMemo(() => {
    const l1s = nodes.filter((n) => n.depth === 1).sort((a, b) => a.l1.localeCompare(b.l1))
    return l1s.map((l1) => ({
      ...l1,
      children: nodes
        .filter((n) => n.depth === 2 && n.l1 === l1.l1)
        .sort((a, b) => (a.l2 ?? '').localeCompare(b.l2 ?? ''))
        .map((l2) => ({
          ...l2,
          children: nodes
            .filter((n) => n.depth === 3 && n.l1 === l2.l1 && n.l2 === l2.l2)
            .sort((a, b) => (a.l3 ?? '').localeCompare(b.l3 ?? '')),
        })),
    }))
  }, [nodes])

  // ── Flatten tree into table rows with rowSpan calculations ──────────
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = []
    const query = searchQuery.toLowerCase()

    for (const l1 of tree) {
      const l1IsCollapsed = collapsedL1.has(l1.fullPath)

      // Search filter: skip L1 if no descendant matches
      if (query) {
        const l1Match = l1.l1.toLowerCase().includes(query)
        const anyDescendant = l1.children.some(l2 =>
          (l2.l2 ?? '').toLowerCase().includes(query) ||
          l2.children.some(l3 =>
            (l3.l3 ?? '').toLowerCase().includes(query) ||
            (l3.description ?? '').toLowerCase().includes(query)
          )
        )
        if (!l1Match && !anyDescendant) continue
      }

      // If collapsed or no children — single row for L1
      if (l1IsCollapsed || l1.children.length === 0) {
        rows.push({
          node: l1, level: 1,
          isFirstInL1: true, isFirstInL2: false,
          l1RowSpan: 1, l2RowSpan: 0,
          l1Node: l1, l2Node: null,
        })
        continue
      }

      // Build visible L2s
      const visibleL2s: { l2: L2Tree; visibleL3s: L3Tree[]; isEmpty: boolean }[] = []
      for (const l2 of l1.children) {
        if (query) {
          const l2Match = (l2.l2 ?? '').toLowerCase().includes(query) || l1.l1.toLowerCase().includes(query)
          const anyL3 = l2.children.some(l3 =>
            (l3.l3 ?? '').toLowerCase().includes(query) ||
            (l3.description ?? '').toLowerCase().includes(query)
          )
          if (!l2Match && !anyL3) continue
        }

        const l2IsCollapsed = collapsedL2.has(l2.fullPath)
        if (l2IsCollapsed || l2.children.length === 0) {
          visibleL2s.push({ l2, visibleL3s: [], isEmpty: !l2IsCollapsed && l2.children.length === 0 })
        } else {
          let l3List = l2.children
          if (query) {
            const filtered = l2.children.filter(l3 =>
              (l3.l3 ?? '').toLowerCase().includes(query) ||
              (l3.description ?? '').toLowerCase().includes(query) ||
              (l2.l2 ?? '').toLowerCase().includes(query) ||
              l1.l1.toLowerCase().includes(query)
            )
            if (filtered.length > 0) l3List = filtered
          }
          visibleL2s.push({ l2, visibleL3s: l3List, isEmpty: false })
        }
      }

      // Calculate total L1 row span (including add-row placeholders)
      let l1TotalRows = 0
      for (const { visibleL3s, isEmpty } of visibleL2s) {
        if (visibleL3s.length > 0) {
          l1TotalRows += visibleL3s.length + 1 // +1 for add-l3 row
        } else if (isEmpty && !query) {
          l1TotalRows += 2 // L2 row + add-l3 placeholder
        } else {
          l1TotalRows += 1
        }
      }
      if (!query) l1TotalRows += 1 // +1 for add-l2 row at end of L1
      if (l1TotalRows === 0) l1TotalRows = 1

      // Emit rows
      let isFirstL1Row = true
      for (const { l2, visibleL3s, isEmpty } of visibleL2s) {
        if (visibleL3s.length === 0) {
          const showAddL3 = isEmpty && !query
          // L2-only row (collapsed or no children)
          rows.push({
            node: l2, level: 2,
            isFirstInL1: isFirstL1Row, isFirstInL2: true,
            l1RowSpan: isFirstL1Row ? l1TotalRows : 0,
            l2RowSpan: showAddL3 ? 2 : 1,
            l1Node: l1, l2Node: l2,
          })
          isFirstL1Row = false
          // Add add-l3 placeholder for empty (not collapsed) L2s
          if (showAddL3) {
            rows.push({
              node: l2, level: 3,
              isFirstInL1: false, isFirstInL2: false,
              l1RowSpan: 0, l2RowSpan: 0,
              l1Node: l1, l2Node: l2,
              addRow: 'add-l3',
            })
          }
        } else {
          const l2RowCount = visibleL3s.length + 1 // +1 for add-l3 row
          let isFirstL2Row = true
          for (const l3 of visibleL3s) {
            rows.push({
              node: l3, level: 3,
              isFirstInL1: isFirstL1Row, isFirstInL2: isFirstL2Row,
              l1RowSpan: isFirstL1Row ? l1TotalRows : 0,
              l2RowSpan: isFirstL2Row ? l2RowCount : 0,
              l1Node: l1, l2Node: l2,
            })
            isFirstL1Row = false
            isFirstL2Row = false
          }
          // Add-l3 placeholder row at end of this L2's children
          rows.push({
            node: l2, level: 3,
            isFirstInL1: false, isFirstInL2: false,
            l1RowSpan: 0, l2RowSpan: 0,
            l1Node: l1, l2Node: l2,
            addRow: 'add-l3',
          })
        }
      }

      // Add-l2 placeholder row at end of this L1's children (skip during search)
      if (!query) {
        rows.push({
          node: l1, level: 2,
          isFirstInL1: false, isFirstInL2: true,
          l1RowSpan: 0, l2RowSpan: 1,
          l1Node: l1, l2Node: null,
          addRow: 'add-l2',
        })
      }
    }

    // Add-l1 placeholder row at the very end (skip during search)
    if (!query && tree.length > 0) {
      rows.push({
        node: tree[0], level: 1,
        isFirstInL1: true, isFirstInL2: false,
        l1RowSpan: 1, l2RowSpan: 0,
        l1Node: tree[0], l2Node: null,
        addRow: 'add-l1',
      })
    }

    return rows
  }, [tree, collapsedL1, collapsedL2, searchQuery])

  // ── Collapse helpers ────────────────────────────────────────────────
  const toggleL1 = useCallback((key: string) => {
    setCollapsedL1((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])
  const toggleL2 = useCallback((key: string) => {
    setCollapsedL2((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])
  const expandAll = useCallback(() => { setCollapsedL1(new Set()); setCollapsedL2(new Set()) }, [])
  const collapseAll = useCallback(() => {
    setCollapsedL1(new Set(tree.map(l1 => l1.fullPath)))
    setCollapsedL2(new Set(tree.flatMap(l1 => l1.children.map(l2 => l2.fullPath))))
  }, [tree])

  // ── Action handlers ─────────────────────────────────────────────────
  const handleRename = useCallback(async (nodeId: string, newName: string) => {
    const node = nodes.find((n) => n.id === nodeId)
    const oldName = node ? (node.l3 ?? node.l2 ?? node.l1) : ''
    if (!window.confirm(`Rename "${oldName}" to "${newName}"?`)) return
    try {
      await ipc.taxonomy.renameNode(nodeId, newName)
      await loadData(); await refreshMetadata()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to rename') }
  }, [nodes, loadData, refreshMetadata])

  const handleUpdateDescription = useCallback(async (nodeId: string, description: string) => {
    try {
      await ipc.taxonomy.updateNode(nodeId, { description })
      await loadData()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to update description') }
  }, [loadData])

  const handleDelete = useCallback(async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId)
    if (!window.confirm(`Delete "${node?.fullPath ?? nodeId}"? This cannot be undone.`)) return
    try {
      await ipc.taxonomy.deleteNode(nodeId)
      await loadData(); await refreshMetadata()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to delete') }
  }, [nodes, loadData, refreshMetadata])

  const handleMerge = useCallback(async (sourceId: string, targetId: string) => {
    const source = nodes.find((n) => n.id === sourceId)
    const target = nodes.find((n) => n.id === targetId)
    if (!window.confirm(`Merge "${source?.fullPath}" into "${target?.fullPath}"? Source will be deleted.`)) return
    setMergingNodeId(null); setMergeAnchor(null)
    try {
      await ipc.taxonomy.mergeNodes(sourceId, targetId)
      await loadData(); await refreshMetadata()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to merge') }
  }, [nodes, loadData, refreshMetadata])

  const handleAddChild = useCallback(async (parentPath: string) => {
    if (!addName.trim()) return
    const fullPath = parentPath === '__ROOT__' ? addName.trim() : `${parentPath}|${addName.trim()}`
    if (!window.confirm(`Add "${fullPath}"?`)) return
    setAddSaving(true)
    try {
      await ipc.taxonomy.addNode(fullPath, addDescription.trim() || undefined)
      setAddingUnder(null); setAddName(''); setAddDescription('')
      await loadData(); await refreshMetadata()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to add node') }
    finally { setAddSaving(false) }
  }, [addName, addDescription, loadData, refreshMetadata])

  const handleImport = useCallback(async () => {
    setImporting(true); setError(null)
    try {
      const result = await ipc.taxonomy.importFromFile('')
      await ipc.project.updateMetadata({ taxonomyName: `${result.fileName} (${result.nodeCount} nodes)` })
      await loadData(); await refreshMetadata()
    } catch (e) {
      if ((e as Error).message === 'No file selected') { setImporting(false); return }
      setError(e instanceof Error ? e.message : 'Failed to import')
    } finally { setImporting(false) }
  }, [loadData, refreshMetadata])

  const getMergeTargets = useCallback((node: TaxonomyNode): TaxonomyNode[] => {
    return nodes.filter((n) => n.depth === 3 && n.id !== node.id)
  }, [nodes])

  // ── Stats ───────────────────────────────────────────────────────────
  const l1Count = tree.length
  const l2Count = tree.reduce((a, l1) => a + l1.children.length, 0)
  const l3Count = tree.reduce((a, l1) => a + l1.children.reduce((b, l2) => b + l2.children.length, 0), 0)

  // ── Loading ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="h-6 w-6 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 pt-5 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Taxonomy</h2>
            <div className="mt-1 flex items-center gap-4 text-xs text-gray-400">
              <span>{nodes.length} total</span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" />
                {l1Count} L1
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
                {l2Count} L2
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-gray-400" />
                {l3Count} L3
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="rounded-md border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-xs text-gray-700 placeholder:text-gray-300 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 w-48"
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
            </div>
            <button onClick={handleImport} disabled={importing} className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
              <Upload size={13} />
              {importing ? 'Importing...' : 'Import'}
            </button>
            <div className="flex items-center rounded-md border border-gray-200 bg-white">
              <button onClick={expandAll} title="Expand all" className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors border-r border-gray-200">
                <Maximize2 size={13} />
              </button>
              <button onClick={collapseAll} title="Collapse all" className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors">
                <Minimize2 size={13} />
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-center justify-between rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
          </div>
        )}
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-200 py-16">
            <div className="text-sm text-gray-400">No taxonomy nodes yet</div>
            <div className="mt-1 text-xs text-gray-300">Import a taxonomy file to get started</div>
            <button onClick={handleImport} className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors">
              Import from File
            </button>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full border-collapse table-fixed">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="w-[22%] px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 border-r border-gray-100">L1</th>
                  <th className="w-[22%] px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 border-r border-gray-100">L2</th>
                  <th className="w-[20%] px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 border-r border-gray-100">L3</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 border-r border-gray-100">Description</th>
                  <th className="w-20 px-2 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {flatRows.map((row, idx) => {
                  const l1Idx = tree.findIndex(l1 => l1.id === row.l1Node.id)
                  const stripe = l1Idx % 2 === 1 ? 'bg-gray-50/50' : 'bg-white'

                  {/* ── Add-L1 placeholder row (full width at bottom) ── */}
                  if (row.addRow === 'add-l1') {
                    const isActive = addingUnder === '__ROOT__'
                    return (
                      <tr key="add-l1" className="bg-white hover:bg-blue-50/30 transition-colors">
                        <td colSpan={5} className="px-4 py-2 border-b border-gray-100">
                          {isActive ? (
                            <div className="flex items-center gap-2">
                              <Plus size={13} className="text-blue-400 flex-shrink-0" />
                              <input
                                value={addName}
                                onChange={(e) => setAddName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddChild('__ROOT__')
                                  else if (e.key === 'Escape') { setAddingUnder(null); setAddName(''); setAddDescription('') }
                                }}
                                className="rounded border border-blue-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 w-48"
                                placeholder="New L1 name"
                                autoFocus
                              />
                              <button onClick={() => handleAddChild('__ROOT__')} disabled={addSaving || !addName.trim()} className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
                                {addSaving ? '...' : 'Add'}
                              </button>
                              <button onClick={() => { setAddingUnder(null); setAddName(''); setAddDescription('') }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setAddingUnder('__ROOT__'); setAddName(''); setAddDescription(''); setMergingNodeId(null) }}
                              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-600 transition-colors"
                            >
                              <Plus size={13} /> Add L1
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  }

                  {/* ── Add-L2 placeholder row (at end of L1 group) ── */}
                  if (row.addRow === 'add-l2') {
                    const isActive = addingUnder === row.l1Node.fullPath
                    return (
                      <tr key={`add-l2-${row.l1Node.id}`} className={`${stripe} hover:bg-blue-50/30 transition-colors`}>
                        <td colSpan={4} className="px-4 py-2 border-b border-gray-200">
                          {isActive ? (
                            <div className="flex items-center gap-2">
                              <Plus size={13} className="text-blue-400 flex-shrink-0" />
                              <input
                                value={addName}
                                onChange={(e) => setAddName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddChild(row.l1Node.fullPath)
                                  else if (e.key === 'Escape') { setAddingUnder(null); setAddName(''); setAddDescription('') }
                                }}
                                className="rounded border border-blue-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 w-48"
                                placeholder="New L2 name"
                                autoFocus
                              />
                              <button onClick={() => handleAddChild(row.l1Node.fullPath)} disabled={addSaving || !addName.trim()} className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
                                {addSaving ? '...' : 'Add'}
                              </button>
                              <button onClick={() => { setAddingUnder(null); setAddName(''); setAddDescription('') }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setAddingUnder(row.l1Node.fullPath); setAddName(''); setAddDescription(''); setMergingNodeId(null) }}
                              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-600 transition-colors"
                            >
                              <Plus size={13} /> Add L2
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  }

                  {/* ── Add-L3 placeholder row (at end of L2 group) ── */}
                  if (row.addRow === 'add-l3') {
                    const isActive = addingUnder === row.l2Node?.fullPath
                    return (
                      <tr key={`add-l3-${row.l2Node?.id}`} className={`${stripe} hover:bg-blue-50/30 transition-colors`}>
                        {isActive ? (
                          <>
                            <td className="px-4 py-1.5 border-r border-gray-100 border-b border-gray-100">
                              <div className="flex items-center gap-1.5">
                                <Plus size={13} className="text-blue-400 flex-shrink-0" />
                                <input
                                  value={addName}
                                  onChange={(e) => setAddName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddChild(row.l2Node!.fullPath)
                                    else if (e.key === 'Escape') { setAddingUnder(null); setAddName(''); setAddDescription('') }
                                  }}
                                  className="w-full rounded border border-blue-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                  placeholder="New L3 name"
                                  autoFocus
                                />
                              </div>
                            </td>
                            <td className="px-4 py-1.5 border-r border-gray-100 border-b border-gray-100">
                              <input
                                value={addDescription}
                                onChange={(e) => setAddDescription(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddChild(row.l2Node!.fullPath)
                                  else if (e.key === 'Escape') { setAddingUnder(null); setAddName(''); setAddDescription('') }
                                }}
                                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                placeholder="Description (optional)"
                              />
                            </td>
                            <td className="px-2 py-1.5 border-b border-gray-100">
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={() => handleAddChild(row.l2Node!.fullPath)} disabled={addSaving || !addName.trim()} className="rounded bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
                                  {addSaving ? '...' : 'Add'}
                                </button>
                                <button onClick={() => { setAddingUnder(null); setAddName(''); setAddDescription('') }} className="text-[10px] text-gray-400 hover:text-gray-600">✕</button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-4 py-1.5 border-r border-gray-100 border-b border-gray-100">
                              <button
                                onClick={() => { setAddingUnder(row.l2Node!.fullPath); setAddName(''); setAddDescription(''); setMergingNodeId(null) }}
                                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-600 transition-colors"
                              >
                                <Plus size={13} /> Add L3
                              </button>
                            </td>
                            <td className="px-4 py-1.5 border-r border-gray-100 border-b border-gray-100" />
                            <td className="px-2 py-1.5 border-b border-gray-100" />
                          </>
                        )}
                      </tr>
                    )
                  }

                  {/* ── Normal data row ── */}
                  return (
                    <tr key={`${row.node.id}-${idx}`} className={`${stripe} group hover:bg-blue-50/40 transition-colors`}>

                      {/* ── L1 cell ── */}
                      {row.isFirstInL1 && (
                        <td
                          rowSpan={row.l1RowSpan}
                          className="px-3 align-top border-r border-gray-100 border-b border-b-gray-200"
                        >
                          <div className="flex items-center gap-1.5 py-2.5 sticky top-0">
                            <button
                              onClick={() => toggleL1(row.l1Node.fullPath)}
                              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                            >
                              {collapsedL1.has(row.l1Node.fullPath) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            </button>
                            <EditableCell
                              value={row.l1Node.l1}
                              onSave={(n) => handleRename(row.l1Node.id, n)}
                              className="text-xs font-semibold text-gray-800"
                            />
                            <span className="ml-auto flex-shrink-0 rounded-full bg-blue-100/60 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 tabular-nums">
                              {row.l1Node.children.length}
                            </span>
                          </div>
                        </td>
                      )}

                      {/* ── L2 cell ── */}
                      {row.level === 1 ? (
                        // L1-only row (collapsed or empty)
                        <>
                          <td colSpan={3} className="px-4 py-2.5 text-xs text-gray-300 italic border-r border-gray-100 border-b border-gray-100">
                            {collapsedL1.has(row.l1Node.fullPath)
                              ? `${row.l1Node.children.reduce((a, l2) => a + 1 + l2.children.length, 0)} children hidden`
                              : 'No subcategories'}
                          </td>
                          <td className="px-2 py-2 text-center border-b border-gray-100">
                            <div className="flex items-center justify-center gap-0.5 ">
                              <button onClick={() => handleDelete(row.l1Node.id)} className="rounded p-1 text-red-400 hover:bg-red-50" title="Delete"><Trash2 size={13} /></button>
                            </div>
                          </td>
                        </>
                      ) : row.isFirstInL2 && row.l2Node ? (
                        <td
                          rowSpan={row.l2RowSpan}
                          className="px-3 align-top border-r border-gray-100 border-b border-gray-100"
                        >
                          <div className="flex items-center gap-1.5 py-2">
                            {row.l2Node.children.length > 0 ? (
                              <button
                                onClick={() => toggleL2(row.l2Node!.fullPath)}
                                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                              >
                                {collapsedL2.has(row.l2Node.fullPath) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                              </button>
                            ) : (
                              <div className="h-4 w-4 flex-shrink-0" />
                            )}
                            <EditableCell
                              value={row.l2Node.l2 ?? ''}
                              onSave={(n) => handleRename(row.l2Node!.id, n)}
                              className="text-xs font-medium text-gray-600"
                            />
                            {row.l2Node.children.length > 0 && (
                              <span className="ml-auto flex-shrink-0 rounded-full bg-emerald-100/60 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 tabular-nums">
                                {row.l2Node.children.length}
                              </span>
                            )}
                          </div>
                        </td>
                      ) : null}

                      {/* ── L3 + Description + Actions cells ── */}
                      {row.level === 2 ? (
                        // L2-only row (collapsed or no children)
                        <>
                          <td className="px-4 py-2 text-xs text-gray-300 italic border-r border-gray-100 border-b border-gray-100">
                            {collapsedL2.has(row.l2Node?.fullPath ?? '')
                              ? `${row.l2Node?.children.length ?? 0} items hidden`
                              : 'No items'}
                          </td>
                          <td className="px-4 py-2 border-r border-gray-100 border-b border-gray-100">
                            <DescriptionCell
                              value={row.l2Node?.description ?? ''}
                              onSave={(d) => handleUpdateDescription(row.l2Node!.id, d)}
                            />
                          </td>
                          <td className="px-2 py-2 text-center border-b border-gray-100">
                            <div className="flex items-center justify-center gap-0.5 ">
                              <button onClick={() => handleDelete(row.l2Node!.id)} className="rounded p-1 text-red-400 hover:bg-red-50" title="Delete"><Trash2 size={13} /></button>
                            </div>
                          </td>
                        </>
                      ) : row.level === 3 ? (
                        <>
                          <td className="px-4 py-1.5 border-r border-gray-100 border-b border-gray-100">
                            <EditableCell
                              value={row.node.l3 ?? ''}
                              onSave={(n) => handleRename(row.node.id, n)}
                              className="text-xs text-gray-700"
                            />
                          </td>
                          <td className="px-4 py-1.5 border-r border-gray-100 border-b border-gray-100">
                            <DescriptionCell
                              value={row.node.description ?? ''}
                              onSave={(d) => handleUpdateDescription(row.node.id, d)}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center border-b border-gray-100">
                            <div className="flex items-center justify-center gap-0.5 ">
                              <button onClick={(e) => openMergeAt(row.node.id, e.currentTarget)} className="rounded p-1 text-amber-500 hover:bg-amber-50" title="Merge"><Merge size={13} /></button>
                              <button onClick={() => handleDelete(row.node.id)} className="rounded p-1 text-red-400 hover:bg-red-50" title="Delete"><Trash2 size={13} /></button>
                            </div>
                          </td>
                        </>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* Merge picker is now rendered as a fixed popover — see below */}
          </div>
        )}
      </div>

      {/* ── Merge popover (fixed position near click) ──────────────── */}
      {mergingNodeId && mergeAnchor && (() => {
        const source = nodes.find(n => n.id === mergingNodeId)
        if (!source) return null
        const targets = getMergeTargets(source)
        const q = mergeSearch.toLowerCase()
        const filtered = q ? targets.filter((t) => t.fullPath.toLowerCase().includes(q)) : []

        return (
          <div
            ref={mergePopoverRef}
            className="fixed z-50 w-80 rounded-lg border border-amber-200 bg-white shadow-lg"
            style={{ top: mergeAnchor.top, left: mergeAnchor.left }}
          >
            <div className="px-3 py-2.5 border-b border-amber-100 bg-amber-50/60 rounded-t-lg">
              <div className="text-[11px] font-medium text-gray-500 mb-1.5">
                Merge <span className="text-amber-600">{source.fullPath.split('|').join(' > ')}</span> into:
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={mergeInputRef}
                  value={mergeSearch}
                  onChange={(e) => setMergeSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setMergingNodeId(null); setMergeSearch(''); setMergeAnchor(null) } }}
                  className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                  placeholder="Search target..."
                />
                <button
                  onClick={() => { setMergingNodeId(null); setMergeSearch(''); setMergeAnchor(null) }}
                  className="text-gray-400 hover:text-gray-600 p-0.5"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {!q ? (
                <div className="py-3 px-3 text-xs text-gray-400 text-center">Type to search targets...</div>
              ) : filtered.length === 0 ? (
                <div className="py-3 px-3 text-xs text-gray-400 text-center">No matches</div>
              ) : filtered.slice(0, 20).map((t) => (
                <button
                  key={t.id}
                  onClick={() => { handleMerge(mergingNodeId!, t.id); setMergeSearch(''); setMergeAnchor(null) }}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-amber-50 transition-colors border-b border-gray-50 last:border-b-0"
                >
                  {t.fullPath.split('|').join(' > ')}
                </button>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
