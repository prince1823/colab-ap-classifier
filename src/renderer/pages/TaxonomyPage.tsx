import { useState, useEffect, useMemo, useCallback } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

export default function TaxonomyPage() {
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  const [nodes, setNodes] = useState<TaxonomyNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [addPath, setAddPath] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  // Track which L1/L2 sections are collapsed
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Track which node's description tooltip is shown
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)

  const loadData = async () => {
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
  }

  useEffect(() => { loadData() }, [])

  const tree = useMemo(() => {
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

  const handleAddNode = async () => {
    if (!addPath.trim()) return
    setAddSaving(true)
    try {
      await ipc.taxonomy.addNode(addPath.trim(), addDesc.trim() || undefined)
      setShowAdd(false)
      setAddPath('')
      setAddDesc('')
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add node')
    } finally {
      setAddSaving(false)
    }
  }

  const handleDeleteNode = async (node: TaxonomyNode) => {
    try {
      await ipc.taxonomy.deleteNode(node.id)
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete node')
    }
  }

  const handleImport = async () => {
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
  }

  const l1Count = tree.length
  const l2Count = tree.reduce((a, l1) => a + l1.children.length, 0)
  const l3Count = tree.reduce((a, l1) => a + l1.children.reduce((b, l2) => b + l2.children.length, 0), 0)

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
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleImport()}
              disabled={importing}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {importing ? 'Importing...' : 'Import from File'}
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
            >
              + Add Node
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={expandAll} title="Expand all" className="rounded-md border border-gray-200 bg-white p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors">
              <Maximize2 size={14} />
            </button>
            <button onClick={collapseAll} title="Collapse all" className="rounded-md border border-gray-200 bg-white p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-colors">
              <Minimize2 size={14} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      {/* Add Node Form */}
      {showAdd && (
        <div className="rounded-lg border border-blue-100 bg-blue-50/30 p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-500">Path</label>
              <input
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddNode()}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="L1|L2|L3"
                autoFocus
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-500">Description (optional)</label>
              <input
                value={addDesc}
                onChange={(e) => setAddDesc(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddNode()}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="Brief description..."
              />
            </div>
            <button
              onClick={handleAddNode}
              disabled={addSaving || !addPath.trim()}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {addSaving ? 'Adding...' : 'Add'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setAddPath(''); setAddDesc('') }}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {tree.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-sm text-gray-400">No taxonomy nodes yet</div>
            <div className="mt-1 text-xs text-gray-300">Add nodes manually or import from a file</div>
          </div>
        ) : (
          <>
            {/* L1 nodes */}
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
                      <span className="text-sm font-medium text-gray-800">{l1.l1}</span>
                      <span className="text-[11px] text-gray-300">{childCount}</span>
                      {l1.description && (
                        <div className="relative" onMouseEnter={() => setHoveredNode(l1.id)} onMouseLeave={() => setHoveredNode(null)}>
                          <svg className="h-3.5 w-3.5 text-gray-300 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {hoveredNode === l1.id && (
                            <div className="absolute left-0 top-5 z-10 w-64 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 shadow-lg">
                              {l1.description}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="flex-1" />
                      <button
                        onClick={() => handleDeleteNode(l1)}
                        className="opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600 transition-all"
                      >
                        Delete
                      </button>
                    </div>

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
                                <span className="text-xs font-medium text-gray-600">{l2.l2}</span>
                                {l2.children.length > 0 && (
                                  <span className="text-[10px] text-gray-300">{l2.children.length}</span>
                                )}
                                {l2.description && (
                                  <div className="relative" onMouseEnter={() => setHoveredNode(l2.id)} onMouseLeave={() => setHoveredNode(null)}>
                                    <svg className="h-3 w-3 text-gray-300 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    {hoveredNode === l2.id && (
                                      <div className="absolute left-0 top-4 z-10 w-64 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 shadow-lg">
                                        {l2.description}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <div className="flex-1" />
                                <button
                                  onClick={() => handleDeleteNode(l2)}
                                  className="opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600 transition-all"
                                >
                                  Delete
                                </button>
                              </div>

                              {/* L3 children */}
                              {!l2Collapsed && l2.children.length > 0 && (
                                <div className="pb-0.5">
                                  {l2.children.map((l3) => (
                                    <div key={l3.id} className="group flex items-center gap-2 py-1 pl-16 pr-3 hover:bg-gray-50/50 transition-colors">
                                      <div className="h-1 w-1 flex-shrink-0 rounded-full bg-gray-300" />
                                      <span className="text-[11px] text-gray-500">{l3.l3}</span>
                                      {l3.description && (
                                        <div className="relative" onMouseEnter={() => setHoveredNode(l3.id)} onMouseLeave={() => setHoveredNode(null)}>
                                          <svg className="h-3 w-3 text-gray-200 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                          </svg>
                                          {hoveredNode === l3.id && (
                                            <div className="absolute left-0 top-4 z-10 w-72 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 shadow-lg">
                                              {l3.description}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      <div className="flex-1" />
                                      <button
                                        onClick={() => handleDeleteNode(l3)}
                                        className="opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600 transition-all"
                                      >
                                        Delete
                                      </button>
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
          </>
        )}
      </div>
    </div>
  )
}
