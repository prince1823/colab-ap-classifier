import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { X, Plus, AlertTriangle } from 'lucide-react'
import type { FlattenedPivotRow } from '../../types/pivot'
import type { TaxonomyNode } from '../../../shared/types/taxonomy'
import type { ConflictState } from '../../hooks/useReclassification'

interface ReclassifyModalProps {
  isOpen: boolean
  onClose: () => void
  targetRows: FlattenedPivotRow[]
  // Taxonomy state
  filteredNodes: TaxonomyNode[]
  allNodes?: TaxonomyNode[]
  search: string
  onSearchChange: (value: string) => void
  focusedIdx: number
  onFocusedIdxChange: (idx: number) => void
  searchRef: React.RefObject<HTMLInputElement>
  // Actions
  onApply: (node: TaxonomyNode) => void
  onAddNode?: (l1: string, l2: string, l3: string, description?: string) => Promise<TaxonomyNode | null>
  applying: boolean
  conflictChecking: boolean
  conflicts: ConflictState | null
  onConfirmConflicts: () => void
  error: string | null
}

export default function ReclassifyModal({
  isOpen,
  onClose,
  targetRows,
  filteredNodes,
  allNodes,
  search,
  onSearchChange,
  focusedIdx,
  onFocusedIdxChange,
  searchRef,
  onApply,
  onAddNode,
  applying,
  conflictChecking,
  conflicts,
  onConfirmConflicts,
  error,
}: ReclassifyModalProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newL1, setNewL1] = useState('')
  const [newL2, setNewL2] = useState('')
  const [newL3, setNewL3] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [adding, setAdding] = useState(false)
  const [formHeight, setFormHeight] = useState(260)
  const resizing = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    startY.current = e.clientY
    startH.current = formHeight
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return
      const diff = ev.clientY - startY.current
      setFormHeight(Math.max(120, Math.min(400, startH.current + diff)))
    }
    const onUp = () => {
      resizing.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [formHeight])

  // Autocomplete suggestions from existing nodes
  const l1Suggestions = useMemo(() => {
    const nodes = allNodes ?? filteredNodes
    return [...new Set(nodes.map(n => n.l1))].sort()
  }, [allNodes, filteredNodes])

  const l2Suggestions = useMemo(() => {
    if (!newL1) return []
    const nodes = allNodes ?? filteredNodes
    return [...new Set(nodes.filter(n => n.l1 === newL1 && n.l2).map(n => n.l2!))].sort()
  }, [allNodes, filteredNodes, newL1])

  // Reset add form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setShowAddForm(false)
      setNewL1('')
      setNewL2('')
      setNewL3('')
      setNewDesc('')
    }
  }, [isOpen])

  // Scroll focused item into view (only when not in add form and not on conflict screen)
  useEffect(() => {
    if (!listRef.current || showAddForm || conflicts) return
    const item = listRef.current.children[focusedIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [focusedIdx, showAddForm, conflicts])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // On conflict screen, only allow Escape
    if (conflicts) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      return
    }
    if (showAddForm) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowAddForm(false)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        onFocusedIdxChange(Math.min(filteredNodes.length - 1, focusedIdx + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        onFocusedIdxChange(Math.max(0, focusedIdx - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (filteredNodes[focusedIdx]) {
          onApply(filteredNodes[focusedIdx])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }

  const handleAddNode = async () => {
    if (!onAddNode || !newL1.trim()) return
    setAdding(true)
    const node = await onAddNode(newL1.trim(), newL2.trim(), newL3.trim(), newDesc.trim())
    setAdding(false)
    if (node) {
      setShowAddForm(false)
      setNewL1('')
      setNewL2('')
      setNewL3('')
      setNewDesc('')
      onApply(node)
    }
  }

  if (!isOpen) return null

  const rowSummary = targetRows.length === 1
    ? targetRows[0].label
    : `${targetRows.length} selected groups`

  const totalTxns = targetRows.reduce((sum, r) => sum + r.transactionCount, 0)

  // ── Conflict warning screen ─────────────────────────────────────────────────
  if (conflicts) {
    // Group covered rows by rule name for a clean summary
    const ruleConflictCounts = new Map<string, number>()
    for (const row of conflicts.covered) {
      ruleConflictCounts.set(row.existingRuleName, (ruleConflictCounts.get(row.existingRuleName) ?? 0) + 1)
    }

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-lg shadow-xl w-[480px] flex flex-col"
          onClick={e => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-500 flex-shrink-0" />
              <h3 className="text-sm font-semibold text-gray-900">Some transactions already have higher-priority rules</h3>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X size={16} />
            </button>
          </div>

          {/* Conflict list */}
          <div className="px-4 py-3 space-y-1.5 max-h-48 overflow-y-auto">
            {[...ruleConflictCounts.entries()].map(([ruleName, count]) => (
              <div key={ruleName} className="flex items-center justify-between text-xs">
                <span className="text-gray-700 font-medium truncate mr-2">{ruleName}</span>
                <span className="text-gray-400 flex-shrink-0">{count} transaction{count !== 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>

          {/* Summary */}
          <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
            <p className="text-xs text-gray-500">
              <span className="font-medium text-gray-700">{conflicts.eligibleIds.length} transaction{conflicts.eligibleIds.length !== 1 ? 's' : ''}</span>
              {' '}will be updated.{' '}
              <span className="text-gray-400">{conflicts.covered.length} skipped (covered by higher-priority rules).</span>
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-100">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-gray-200 text-xs text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirmConflicts}
              disabled={applying || conflicts.eligibleIds.length === 0}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? 'Applying...' : `Apply to ${conflicts.eligibleIds.length} transaction${conflicts.eligibleIds.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main screen (taxonomy picker) ───────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col"
        style={{ resize: 'both', overflow: 'hidden', minWidth: 380, minHeight: 300 }}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Classify &amp; Create Rule</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {rowSummary}
              {totalTxns > 0 && <span className="text-gray-400"> ({totalTxns.toLocaleString()} transactions)</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>

        {/* Search + Add New button */}
        <div className="px-4 py-2 border-b border-gray-100 flex gap-2">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => { onSearchChange(e.target.value); onFocusedIdxChange(0) }}
            placeholder="Search taxonomy..."
            className="flex-1 rounded border border-gray-200 px-3 py-1.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
            autoFocus
          />
          {onAddNode && (
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded border text-xs font-medium transition-colors flex-shrink-0 ${
                showAddForm
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              title="Add new taxonomy node"
            >
              <Plus size={12} />
              New
            </button>
          )}
        </div>

        {/* Add New Node inline form */}
        {showAddForm && (<>
          <div className="px-4 py-3 bg-gray-50 overflow-y-auto flex-shrink-0" style={{ height: formHeight, scrollbarWidth: 'thin' }}>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase">L1 (required)</label>
                <input
                  type="text"
                  value={newL1}
                  onChange={e => setNewL1(e.target.value)}
                  placeholder="e.g. Corporate Services"
                  className="w-full mt-0.5 rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase">L2</label>
                <input
                  type="text"
                  value={newL2}
                  onChange={e => setNewL2(e.target.value)}
                  placeholder="e.g. IT"
                  className="w-full mt-0.5 rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase">L3</label>
                <input
                  type="text"
                  value={newL3}
                  onChange={e => setNewL3(e.target.value)}
                  placeholder="e.g. Software"
                  className="w-full mt-0.5 rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase">Description</label>
                <input
                  type="text"
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="Brief description of this category"
                  className="w-full mt-0.5 rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddNode() } }}
                />
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <button
                  onClick={() => setShowAddForm(false)}
                  className="px-3 py-1 rounded border border-gray-200 text-xs text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddNode}
                  disabled={!newL1.trim() || adding}
                  className="px-3 py-1 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {adding ? 'Adding...' : 'Add & Apply'}
                </button>
              </div>
            </div>
          </div>
          {/* Resize handle */}
          <div
            onMouseDown={handleResizeStart}
            className="h-[6px] cursor-row-resize flex items-center justify-center hover:bg-blue-100 transition-colors border-t border-b border-gray-200"
            title="Drag to resize"
          >
            <div className="w-8 h-[2px] rounded-full bg-gray-300" />
          </div>
        </>)}

        {/* Taxonomy list — grouped by L1 */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-1">
          {filteredNodes.map((node, idx) => {
            const prevL1 = idx > 0 ? filteredNodes[idx - 1].l1 : null
            const showL1Header = node.l1 !== prevL1
            return (
              <React.Fragment key={node.id}>
                {showL1Header && (
                  <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 select-none">
                    {node.l1}
                  </div>
                )}
                <div
                  className={`px-3 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                    idx === focusedIdx
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                  onClick={() => onApply(node)}
                  onMouseEnter={() => onFocusedIdxChange(idx)}
                >
                  <span>{node.l1} | {node.l2} | {node.l3}</span>
                </div>
              </React.Fragment>
            )
          })}
          {filteredNodes.length === 0 && !showAddForm && (
            <div className="text-center py-4">
              <p className="text-sm text-gray-400">No matching taxonomy nodes</p>
              {onAddNode && (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  <Plus size={12} />
                  Add new node
                </button>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-xs text-red-600 border-t border-gray-100">
            {error}
          </div>
        )}

        {/* Footer */}
        {(applying || conflictChecking) && (
          <div className="px-4 py-2 text-xs text-blue-600 border-t border-gray-100">
            {conflictChecking ? 'Checking rule priority...' : 'Applying...'}
          </div>
        )}
        {!applying && !conflictChecking && !error && (
          <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
            A rule will be created and applied immediately.
          </div>
        )}
      </div>
    </div>
  )
}
