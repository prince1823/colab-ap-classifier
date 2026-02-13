import { useState, useEffect, useMemo } from 'react'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { TaxonomyNode, TaxonomyInfo } from '../../shared/types/taxonomy'

export default function TaxonomyPage() {
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  const [nodes, setNodes] = useState<TaxonomyNode[]>([])
  const [taxonomies, setTaxonomies] = useState<TaxonomyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [addPath, setAddPath] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [n, t] = await Promise.all([
        ipc.taxonomy.getNodes(),
        ipc.colabip.listTaxonomies().catch(() => [] as TaxonomyInfo[]),
      ])
      setNodes(n)
      setTaxonomies(t)
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

  const handleAddNode = async () => {
    if (!addPath.trim()) return
    setAddSaving(true)
    try {
      const existingPaths = nodes.map((n) => ({ path: n.fullPath, description: n.description || undefined }))
      await ipc.taxonomy.set({
        name: 'default',
        nodes: [...existingPaths, { path: addPath.trim(), description: addDesc.trim() || undefined }],
      })
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
    const descendantPaths = nodes.filter((n) => n.fullPath.startsWith(node.fullPath)).map((n) => n.fullPath)
    const remaining = nodes
      .filter((n) => !descendantPaths.includes(n.fullPath))
      .map((n) => ({ path: n.fullPath, description: n.description || undefined }))
    try {
      await ipc.taxonomy.set({ name: 'default', nodes: remaining })
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete node')
    }
  }

  const handleImport = async (taxonomyName: string) => {
    setImporting(true)
    setError(null)
    try {
      await ipc.taxonomy.importFromColabip(taxonomyName)
      await loadData()
      await refreshMetadata()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import taxonomy')
    } finally {
      setImporting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Taxonomy</h2>
          <p className="mt-1 text-sm text-gray-500">{nodes.length} nodes</p>
        </div>
        <div className="flex items-center gap-2">
          {taxonomies.length > 0 && (
            <select
              onChange={(e) => e.target.value && handleImport(e.target.value)}
              disabled={importing}
              defaultValue=""
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="" disabled>Import from ColabIP...</option>
              {taxonomies.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.nodeCount} nodes)
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add Node
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {showAdd && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-gray-700">Add Node</h3>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Path (e.g. "IT|Software|SaaS")</label>
              <input
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="L1|L2|L3"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Description (optional)</label>
              <input
                value={addDesc}
                onChange={(e) => setAddDesc(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddNode} disabled={addSaving} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {addSaving ? 'Adding...' : 'Add'}
              </button>
              <button onClick={() => setShowAdd(false)} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white">
        {tree.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No taxonomy nodes. Add nodes or import from ColabIP.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {tree.map((l1) => (
              <div key={l1.id} className="p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-gray-900">{l1.l1}</span>
                    {l1.description && <span className="ml-2 text-xs text-gray-500">{l1.description}</span>}
                  </div>
                  <button onClick={() => handleDeleteNode(l1)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                </div>
                {l1.children.length > 0 && (
                  <div className="ml-6 mt-2 space-y-1">
                    {l1.children.map((l2) => (
                      <div key={l2.id}>
                        <div className="flex items-center justify-between py-1">
                          <div>
                            <span className="text-sm text-gray-700">{l2.l2}</span>
                            {l2.description && <span className="ml-2 text-xs text-gray-400">{l2.description}</span>}
                          </div>
                          <button onClick={() => handleDeleteNode(l2)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                        </div>
                        {l2.children.length > 0 && (
                          <div className="ml-6 space-y-0.5">
                            {l2.children.map((l3) => (
                              <div key={l3.id} className="flex items-center justify-between py-0.5">
                                <div>
                                  <span className="text-xs text-gray-600">{l3.l3}</span>
                                  {l3.description && <span className="ml-2 text-xs text-gray-400">{l3.description}</span>}
                                </div>
                                <button onClick={() => handleDeleteNode(l3)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
