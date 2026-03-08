import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

// ── Inline editable text ──────────────────────────────────────────────
function EditableText({
  value,
  onSave,
  className,
  placeholder,
}: {
  value: string
  onSave: (val: string) => void
  className?: string
  placeholder?: string
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

  const cancel = useCallback(() => {
    setDraft(value)
    setEditing(false)
  }, [value])

  return (
    <span
      className={`cursor-pointer rounded px-0.5 hover:bg-blue-50 hover:ring-1 hover:ring-blue-200 ${className ?? ''}`}
      onClick={(e) => { if (!editing) { e.stopPropagation(); setDraft(value); setEditing(true) } }}
      title={editing ? undefined : 'Click to rename'}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="bg-transparent border-none outline-none p-0 m-0 font-inherit text-inherit"
          style={{ width: `${Math.min(Math.max(draft.length, 1), 60)}ch`, maxWidth: '100%' }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            else if (e.key === 'Escape') { e.preventDefault(); cancel() }
          }}
        />
      ) : (
        value || <span className="italic text-gray-300">{placeholder ?? 'click to edit'}</span>
      )}
    </span>
  )
}

// ── Tree node types ───────────────────────────────────────────────────
type L3Tree = TaxonomyNode
type L2Tree = TaxonomyNode & { children: L3Tree[] }
type L1Tree = TaxonomyNode & { children: L2Tree[] }

export default function TaxonomyPage() {
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  const [nodes, setNodes] = useState<TaxonomyNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  // Collapse/expand
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Contextual add
  const [addingUnder, setAddingUnder] = useState<string | null>(null)
  const [addName, setAddName] = useState('')
  const [addDescription, setAddDescription] = useState('')
  const [addSaving, setAddSaving] = useState(false)

  // Merge
  const [mergingNodeId, setMergingNodeId] = useState<string | null>(null)
  const [mergeSearch, setMergeSearch] = useState('')

  // ── Data loading ──────────────────────────────────────────────────
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

  // ── Tree structure ────────────────────────────────────────────────
  const tree: L1Tree[] = useMemo(() => {
    const l1s = nodes.filter((n) => n.depth === 1)
    return l1s.map((l1) => ({
      ...l1,
      children: nodes
        .filter((n) => n.depth === 2 && n.l1 === l1.l1)
        .map((l2) => ({
          ...l2,
          children: nodes.filter((n) => n.depth === 3 && n.l1 === l2.l1 && n.l2 === l2.l2),
        })),
    }))
  }, [nodes])

  // ── Collapse helpers ──────────────────────────────────────────────
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const expandAll = useCallback(() => setCollapsed(new Set()), [])
  const collapseAll = useCallback(() => {
    const keys = new Set<string>()
    tree.forEach((l1) => {
      keys.add(l1.fullPath)
      l1.children.forEach((l2) => keys.add(l2.fullPath))
    })
    setCollapsed(keys)
  }, [tree])

  // ── Handlers (thin layer — confirm, call IPC, display errors) ──────
  const handleRename = useCallback(async (nodeId: string, newName: string) => {
    const node = nodes.find((n) => n.id === nodeId)
    const oldName = node ? (node.l3 ?? node.l2 ?? node.l1) : ''
    if (!window.confirm(`Rename "${oldName}" to "${newName}"?`)) return
    try {
      await ipc.taxonomy.renameNode(nodeId, newName)
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename node')
    }
  }, [nodes, loadData, refreshMetadata])

  const handleUpdateDescription = useCallback(async (nodeId: string, description: string) => {
    try {
      await ipc.taxonomy.updateNode(nodeId, { description })
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update description')
    }
  }, [loadData])

  const handleDelete = useCallback(async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId)
    if (!window.confirm(`Delete "${node?.fullPath ?? nodeId}"? This cannot be undone.`)) return
    try {
      await ipc.taxonomy.deleteNode(nodeId)
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete node')
    }
  }, [nodes, loadData, refreshMetadata])

  const handleMerge = useCallback(async (sourceId: string, targetId: string) => {
    const source = nodes.find((n) => n.id === sourceId)
    const target = nodes.find((n) => n.id === targetId)
    if (!window.confirm(`Merge "${source?.fullPath}" into "${target?.fullPath}"? The source node will be deleted.`)) return
    setMergingNodeId(null)
    try {
      await ipc.taxonomy.mergeNodes(sourceId, targetId)
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to merge nodes')
    }
  }, [nodes, loadData, refreshMetadata])

  const handleAddChild = useCallback(async (parentPath: string) => {
    if (!addName.trim()) return
    const fullPath = `${parentPath}|${addName.trim()}`
    if (!window.confirm(`Add node "${fullPath}"?`)) return
    setAddSaving(true)
    try {
      await ipc.taxonomy.addNode(fullPath, addDescription.trim() || undefined)
      setAddingUnder(null)
      setAddName('')
      setAddDescription('')
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add node')
    } finally {
      setAddSaving(false)
    }
  }, [addName, addDescription, loadData, refreshMetadata])

  const handleImport = useCallback(async () => {
    setImporting(true)
    setError(null)
    try {
      const result = await ipc.taxonomy.importFromFile('')
      await ipc.project.updateMetadata({ taxonomyName: `${result.fileName} (${result.nodeCount} nodes)` })
      await loadData()
      await refreshMetadata()
    } catch (e) {
      if ((e as Error).message === 'No file selected') {
        setImporting(false)
        return
      }
      setError(e instanceof Error ? e.message : 'Failed to import taxonomy')
    } finally {
      setImporting(false)
    }
  }, [loadData, refreshMetadata])

  // ── Merge target finder (L3 nodes only, any parent, excluding self) ─
  const getMergeTargets = useCallback((node: TaxonomyNode): TaxonomyNode[] => {
    return nodes.filter((n) => n.depth === 3 && n.id !== node.id)
  }, [nodes])

  // ── Stats ─────────────────────────────────────────────────────────
  const l1Count = tree.length
  const l2Count = tree.reduce((a, l1) => a + l1.children.length, 0)
  const l3Count = tree.reduce((a, l1) => a + l1.children.reduce((b, l2) => b + l2.children.length, 0), 0)

  // ── Inline add form ───────────────────────────────────────────────
  const renderAddForm = (parentPath: string, parentDepth: number) => {
    if (addingUnder !== parentPath) return null
    const childLevel = parentDepth === 1 ? 'L2' : 'L3'
    const parentLabel = parentPath.split('|').pop()
    return (
      <div className="mx-3 my-1 flex items-center gap-2 rounded border border-blue-200 bg-blue-50/40 px-3 py-1.5">
        <span className="text-[11px] text-gray-400 whitespace-nowrap">Add {childLevel} under {parentLabel}:</span>
        <input
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddChild(parentPath)
            else if (e.key === 'Escape') { setAddingUnder(null); setAddName(''); setAddDescription('') }
          }}
          className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
          placeholder={`${childLevel} name`}
          autoFocus
        />
        {parentDepth === 2 && (
          <input
            value={addDescription}
            onChange={(e) => setAddDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddChild(parentPath)
              else if (e.key === 'Escape') { setAddingUnder(null); setAddName(''); setAddDescription('') }
            }}
            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
            placeholder="Description (optional)"
          />
        )}
        <button
          onClick={() => handleAddChild(parentPath)}
          disabled={addSaving || !addName.trim()}
          className="rounded bg-blue-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {addSaving ? '...' : 'Add'}
        </button>
        <button
          onClick={() => { setAddingUnder(null); setAddName(''); setAddDescription('') }}
          className="text-[11px] text-gray-400 hover:text-gray-600"
        >
          Cancel
        </button>
      </div>
    )
  }

  // ── Merge picker ──────────────────────────────────────────────────
  const renderMergePicker = (node: TaxonomyNode) => {
    if (mergingNodeId !== node.id) return null
    const targets = getMergeTargets(node)
    const query = mergeSearch.toLowerCase()
    const filtered = query ? targets.filter((t) => t.fullPath.toLowerCase().includes(query)) : []
    return (
      <div className="ml-16 my-1 rounded border border-blue-200 bg-blue-50/40 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500 whitespace-nowrap">Merge into:</span>
          <input
            value={mergeSearch}
            onChange={(e) => setMergeSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setMergingNodeId(null); setMergeSearch('') } }}
            className="flex-1 rounded border border-gray-200 bg-white px-2 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
            placeholder="Search target node..."
            autoFocus
          />
          <button onClick={() => { setMergingNodeId(null); setMergeSearch('') }} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
        </div>
        {query && (
          <div className="mt-1 max-h-32 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-1 text-[11px] text-gray-400">No matches</div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filtered.slice(0, 20).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { handleMerge(node.id, s.id); setMergeSearch('') }}
                    className="rounded px-2 py-0.5 text-left text-[11px] text-gray-600 hover:bg-blue-50 transition-colors"
                  >
                    {s.fullPath}
                  </button>
                ))}
                {filtered.length > 20 && (
                  <div className="py-0.5 text-[11px] text-gray-300">...and {filtered.length - 20} more</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Hover action buttons ──────────────────────────────────────────
  const renderActions = (node: TaxonomyNode, showAdd: boolean) => (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
      {showAdd && (
        <button
          onClick={(e) => { e.stopPropagation(); setAddingUnder(node.fullPath); setAddName(''); setAddDescription(''); setMergingNodeId(null) }}
          className="rounded px-1.5 py-0.5 text-[11px] text-blue-500 hover:bg-blue-50 hover:text-blue-700 transition-colors"
          title={`Add child under ${node.fullPath.split('|').pop()}`}
        >
          +
        </button>
      )}
      {node.depth === 3 && (
        <button
          onClick={(e) => { e.stopPropagation(); setMergingNodeId(node.id); setMergeSearch(''); setAddingUnder(null) }}
          className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          merge
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); handleDelete(node.id) }}
        className="rounded px-1.5 py-0.5 text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
      >
        &times;
      </button>
    </div>
  )

  // ── Loading state ─────────────────────────────────────────────────
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
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Taxonomy</h2>
          <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
            <span>{nodes.length} nodes</span>
            <span className="text-gray-200">|</span>
            <span>{l1Count} L1</span>
            <span className="text-gray-200">&middot;</span>
            <span>{l2Count} L2</span>
            <span className="text-gray-200">&middot;</span>
            <span>{l3Count} L3</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleImport}
            disabled={importing}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {importing ? 'Importing...' : 'Import from File'}
          </button>
          <button onClick={expandAll} title="Expand all" className="rounded-md border border-gray-200 bg-white p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors">
            <Maximize2 size={14} />
          </button>
          <button onClick={collapseAll} title="Collapse all" className="rounded-md border border-gray-200 bg-white p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors">
            <Minimize2 size={14} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      {/* Tree */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {tree.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-sm text-gray-400">No taxonomy nodes yet</div>
            <div className="mt-1 text-xs text-gray-300">Import a taxonomy file to get started</div>
          </div>
        ) : (
          <div>
            {tree.map((l1, i) => {
              const l1Collapsed = collapsed.has(l1.fullPath)
              const childCount = l1.children.reduce((a, l2) => a + 1 + l2.children.length, 0)
              return (
                <div key={l1.id} className={i < tree.length - 1 ? 'border-b border-gray-100' : ''}>
                  {/* L1 row */}
                  <div className="group flex items-center gap-2 px-3 py-2 hover:bg-gray-50/50 transition-colors">
                    <button
                      onClick={() => toggle(l1.fullPath)}
                      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-300 hover:text-gray-500 transition-colors"
                    >
                      <svg className={`h-3.5 w-3.5 transition-transform ${l1Collapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                    <EditableText
                      value={l1.l1}
                      onSave={(newName) => handleRename(l1.id, newName)}
                      className="text-sm font-medium text-gray-800"
                    />
                    <span className="text-[11px] text-gray-300">{childCount}</span>
                    <div className="flex-1" />
                    {renderActions(l1, true)}
                  </div>
                  {renderAddForm(l1.fullPath, 1)}

                  {/* L2 children */}
                  {!l1Collapsed && l1.children.length > 0 && (
                    <div className="pb-1">
                      {l1.children.map((l2) => {
                        const l2Collapsed = collapsed.has(l2.fullPath)
                        return (
                          <div key={l2.id}>
                            {/* L2 row */}
                            <div className="group flex items-center gap-2 py-1.5 pl-9 pr-3 hover:bg-gray-50/50 transition-colors">
                              {l2.children.length > 0 ? (
                                <button
                                  onClick={() => toggle(l2.fullPath)}
                                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-gray-300 hover:text-gray-500 transition-colors"
                                >
                                  <svg className={`h-3 w-3 transition-transform ${l2Collapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                  </svg>
                                </button>
                              ) : (
                                <div className="h-4 w-4 flex-shrink-0" />
                              )}
                              <EditableText
                                value={l2.l2 ?? ''}
                                onSave={(newName) => handleRename(l2.id, newName)}
                                className="text-xs font-medium text-gray-600"
                              />
                              {l2.children.length > 0 && (
                                <span className="text-[10px] text-gray-300">{l2.children.length}</span>
                              )}
                              <div className="flex-1" />
                              {renderActions(l2, true)}
                            </div>
                            {renderAddForm(l2.fullPath, 2)}

                            {/* L3 children */}
                            {!l2Collapsed && l2.children.length > 0 && (
                              <div className="pb-0.5">
                                {l2.children.map((l3) => (
                                  <div key={l3.id}>
                                    <div className="group flex items-center gap-2 py-1 pl-16 pr-3 hover:bg-gray-50/50 transition-colors min-w-0">
                                      <div className="h-1 w-1 flex-shrink-0 rounded-full bg-gray-300" />
                                      <EditableText
                                        value={l3.l3 ?? ''}
                                        onSave={(newName) => handleRename(l3.id, newName)}
                                        className="text-[11px] text-gray-500 flex-shrink-0"
                                      />
                                      <div className="min-w-0 flex-1 truncate">
                                        {l3.description ? (
                                          <EditableText
                                            value={l3.description}
                                            onSave={(desc) => handleUpdateDescription(l3.id, desc)}
                                            className="text-[11px] italic text-gray-300"
                                            placeholder="add description"
                                          />
                                        ) : (
                                          <span
                                            className="cursor-pointer text-[11px] italic text-gray-200 opacity-0 group-hover:opacity-100 hover:text-blue-400 transition-all"
                                            onClick={() => handleUpdateDescription(l3.id, 'description')}
                                            title="Add description"
                                          >
                                            + desc
                                          </span>
                                        )}
                                      </div>
                                      {renderActions(l3, false)}
                                    </div>
                                    {renderMergePicker(l3)}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
