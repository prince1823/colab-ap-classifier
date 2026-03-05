import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Plus, Minus, Edit2, Trash2 } from 'lucide-react'
import { buildTaxonomyTree } from '../../utils/taxonomyLoader'
import type { TaxonomyTreeNode } from '../../utils/taxonomyLoader'
import { useNodeDrop } from '../../hooks/useTreeDragDrop'
import { useTreeKeyboard } from '../../hooks/useTreeKeyboard'
import { ipc } from '../../lib/ipc'
import { fmtAbbrev } from '../../utils/formatSpend'
import type { GroupedRow } from '../../../shared/types/transactions'
import '../../styles/ClassificationTree.css'

interface ColumnNodeProps {
  node: TaxonomyTreeNode;
  level: number;
  isSelected: boolean;
  isActivePath: boolean;
  onSelect: ((path: string) => void) | null;
  onDropIds: ((transactionIds: string[], targetPath: string) => void) | null;
  onHoverExpand: ((path: string, level: number) => void) | null;
  isKeyboardSelected: boolean;
  onRename: ((node: TaxonomyTreeNode) => void) | null;
  onDelete: ((node: TaxonomyTreeNode) => void) | null;
  isLeaf: boolean;
}

interface ClassificationTreeProps {
  groupedRows: GroupedRow[]
  selectedRows: string[]
  setSelectedRows: (updater: ((prev: string[]) => string[]) | string[]) => void
  onReclassify: ((transactionIds: string[], targetPath: string) => Promise<boolean>) | null
  keyboardFocus: 'tree' | 'tables'
  setKeyboardFocus: (focus: 'tree' | 'tables') => void
}

const ColumnNode = React.memo(({
  node, level, isSelected, isActivePath, onSelect, onDropIds, onHoverExpand,
  isKeyboardSelected, onRename, onDelete, isLeaf
}: ColumnNodeProps) => {
  const levelLabel = level > 0 ? `L${level}` : ''
  const isDroppableLevel = isLeaf || level >= 3

  const { drop, isOverShallow, canDrop } = useNodeDrop({
    nodePath: node.path,
    isDroppableLevel,
    onDropIds,
    onHoverExpand,
    level,
  })

  const [showActions, setShowActions] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-actions')) return
    if (onSelect) onSelect(node.path)
  }

  const handleRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onRename && node.path !== 'root') onRename(node)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onDelete && node.path !== 'root') onDelete(node)
  }

  return (
    <div
      ref={drop}
      className={`node-wrapper column-node-wrapper ${isSelected ? 'selected' : ''} ${isActivePath ? 'active-path' : ''} ${isKeyboardSelected ? 'keyboard-selected' : ''} ${(isDroppableLevel && canDrop && isOverShallow) ? 'drag-over' : ''}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <button
        className={`node-content column-node column-level-${level} ${isSelected ? 'selected' : ''} ${isActivePath ? 'active-path' : ''} ${isKeyboardSelected ? 'keyboard-selected' : ''} ${(isDroppableLevel && canDrop && isOverShallow) ? 'drag-over' : ''}`}
        onClick={handleClick}
        type="button"
        title={level === 4 ? "Click to select, double-click to view details" : "Click to select"}
      >
        {levelLabel && (
          <span className="node-level-badge" title={`Level ${level}`}>
            {levelLabel}
          </span>
        )}
        <span className="node-label" title={node.name}>{node.name}</span>
        {(level === 1 || level === 4) && node.amount > 0 && (
          <span
            className="node-amount"
            title={`Total: ${fmtAbbrev(Number(node.amount || 0))}`}
          >
            {fmtAbbrev(Number(node.amount || 0))}
          </span>
        )}
      </button>
      {showActions && node.path !== 'root' && (
        <div className="node-actions" onClick={(e) => e.stopPropagation()}>
          <button className="node-action-btn node-rename-btn" onClick={handleRename} title="Rename this node">
            <Edit2 size={12} />
          </button>
          <button className="node-action-btn node-delete-btn" onClick={handleDelete} title="Delete this node and all its children">
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  )
})

const ClassificationTree = ({
  groupedRows,
  selectedRows,
  setSelectedRows,
  onReclassify,
  keyboardFocus,
  setKeyboardFocus,
}: ClassificationTreeProps) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [drillSelection, setDrillSelection] = useState<string[]>([])
  const [taxonomyPaths, setTaxonomyPaths] = useState<string[]>([])
  const [loadingTaxonomy, setLoadingTaxonomy] = useState(true)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [keyboardNav, setKeyboardNav] = useState<{ columnIndex: number; nodeIndex: number }>({ columnIndex: 0, nodeIndex: 0 })
  const treeRef = useRef<HTMLDivElement | null>(null)

  // CRUD modal state
  const [showAddNodeModal, setShowAddNodeModal] = useState(false)
  const [newL1, setNewL1] = useState('')
  const [newL2, setNewL2] = useState('')
  const [newL3, setNewL3] = useState('')
  const [isSavingNode, setIsSavingNode] = useState(false)
  const [addNodeError, setAddNodeError] = useState<string | null>(null)

  const [showRenameModal, setShowRenameModal] = useState(false)
  const [nodeToRename, setNodeToRename] = useState<TaxonomyTreeNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [nodeToDelete, setNodeToDelete] = useState<TaxonomyTreeNode | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Load taxonomy paths from backend on mount
  useEffect(() => {
    const loadTaxonomy = async () => {
      setLoadingTaxonomy(true)
      try {
        const nodes = await ipc.taxonomy.getNodes()
        const paths = nodes
          .map((n: { fullPath: string }) => n.fullPath)
          .filter((p: string) => p && p.trim())
        setTaxonomyPaths(paths)
      } catch (err) {
        console.error('Could not load taxonomy:', err)
        setTaxonomyPaths([])
      } finally {
        setLoadingTaxonomy(false)
      }
    }
    loadTaxonomy()
  }, [])

  // Build pathCounts map from server-aggregated groupedRows
  const pathCounts = useMemo(() => {
    const map: Record<string, { count: number; amount: number }> = {}
    groupedRows.forEach((r) => { map[r.value] = { count: r.count, amount: r.amount } })
    return map
  }, [groupedRows])

  // Build taxonomy tree from paths + populate with server counts
  const taxonomyTree = useMemo(() => {
    if (loadingTaxonomy) {
      return { name: 'Root', path: 'root', children: [], count: 0, amount: 0 }
    }
    return buildTaxonomyTree(taxonomyPaths, pathCounts)
  }, [taxonomyPaths, pathCounts, loadingTaxonomy])

  const pathMap = useMemo(() => {
    const map = new Map<string, TaxonomyTreeNode>()
    const traverse = (node: TaxonomyTreeNode) => {
      map.set(node.path, node)
      node.children.forEach(traverse)
    }
    traverse(taxonomyTree)
    return map
  }, [taxonomyTree])

  const sortNodesForColumn = useCallback((nodes: TaxonomyTreeNode[], level: number) => {
    const safeNumber = (val: unknown): number => {
      const n = typeof val === 'number' ? val : Number(val)
      return Number.isFinite(n) ? n : 0
    }
    const byName = (a: TaxonomyTreeNode, b: TaxonomyTreeNode) =>
      String(a?.name || '').localeCompare(String(b?.name || ''))
    if (level === 1 || level === 4) {
      return [...nodes].sort((a, b) => {
        const diff = safeNumber(b?.amount) - safeNumber(a?.amount)
        return diff !== 0 ? diff : byName(a, b)
      })
    }
    return [...nodes].sort(byName)
  }, [])

  const columns = useMemo(() => {
    if (!taxonomyTree?.children) return []
    const cols: TaxonomyTreeNode[][] = [sortNodesForColumn(taxonomyTree.children, 1)]
    drillSelection.forEach((path: string) => {
      const node = pathMap.get(path)
      if (node?.children?.length) {
        cols.push(sortNodesForColumn(node.children, cols.length + 1))
      }
    })
    return cols
  }, [taxonomyTree, drillSelection, pathMap, sortNodesForColumn])

  // Initialize keyboard navigation when columns first load
  useEffect(() => {
    if (columns.length > 0 && keyboardNav.columnIndex === 0 && keyboardNav.nodeIndex === 0) {
      const firstColumn = columns[0]
      if (firstColumn?.length > 0 && !selectedPath) {
        setSelectedPath(firstColumn[0].path)
      }
    }
  }, [columns, keyboardNav.columnIndex, keyboardNav.nodeIndex, selectedPath])

  const setPathAtLevel = useCallback((path: string, level: number) => {
    setDrillSelection((prev: string[]) => {
      const next = prev.slice(0, level - 1)
      if (next[level - 1] === path) return prev
      next[level - 1] = path
      return next
    })
    setSelectedPath((prev: string | null) => (prev === path ? prev : path))
  }, [])

  const autoNavigateToPath = useCallback((targetPath: string) => {
    if (!targetPath || targetPath === 'root') return
    const pathParts = targetPath.split('|').filter((p: string) => p.trim())
    if (pathParts.length === 0) return

    const newDrillSelection: string[] = []
    let currentPath = 'root'

    for (let i = 0; i < pathParts.length && i < 4; i++) {
      currentPath = currentPath === 'root'
        ? `root|${pathParts[i]}`
        : `${currentPath}|${pathParts[i]}`
      const node = pathMap.get(currentPath)
      if (node?.children?.length && i < pathParts.length - 1) {
        newDrillSelection.push(currentPath)
      }
    }

    setDrillSelection(newDrillSelection)
    setSelectedPath(targetPath)
  }, [pathMap])

  const handleDropRow = useCallback(async (transactionIds: string[], targetPath: string) => {
    if (!onReclassify || !targetPath || targetPath === 'root') return
    const classificationPath = targetPath.replace(/^root\|/, '')
    const success = await onReclassify(transactionIds, classificationPath)
    if (success === true) {
      autoNavigateToPath(targetPath)
    }
  }, [onReclassify, autoNavigateToPath])

  // Keyboard reclassification: resolve IDs server-side from selectedRows
  const onReclassifyWithKeyboard = useCallback(async () => {
    const { columnIndex, nodeIndex } = keyboardNav
    if (!columns || columns.length === 0) return
    const currentColumn = columns[columnIndex]
    if (!currentColumn || !currentColumn[nodeIndex]) return
    const targetNode = currentColumn[nodeIndex]
    if (!targetNode || targetNode.path === 'root') return

    const isLeaf = !targetNode.children || targetNode.children.length === 0
    if (!isLeaf && columnIndex < 2) return
    if (!selectedRows || selectedRows.length === 0) return

    try {
      const idArrays = await Promise.all(
        selectedRows.map(async (key: string) => {
          const idx = key.indexOf(':')
          if (idx <= 0) return [] as string[]
          const column = key.slice(0, idx)
          const value = key.slice(idx + 1)
          return ipc.transactions.getIdsByValue(column, value)
        })
      )
      const ids = idArrays.flat().filter(Boolean)
      if (ids.length > 0) {
        await handleDropRow(ids, targetNode.path)
      }
    } catch (err) {
      console.error('[Keyboard reclassify] Failed to fetch IDs:', err)
    }
  }, [keyboardNav, columns, selectedRows, handleDropRow])

  useTreeKeyboard({
    columns,
    keyboardNav,
    setKeyboardNav,
    selectedPath,
    setSelectedPath,
    setPathAtLevel,
    setDrillSelection,
    keyboardFocus,
    setKeyboardFocus,
    onReclassifyWithKeyboard,
  })

  // Sync keyboard nav position when columns change
  useEffect(() => {
    if (columns.length === 0) return
    const currentColumn = columns[keyboardNav.columnIndex]
    if (!currentColumn || currentColumn.length === 0) {
      if (columns[0]?.[0]) {
        setKeyboardNav({ columnIndex: 0, nodeIndex: 0 })
        setSelectedPath(columns[0][0].path)
      }
      return
    }
    if (keyboardNav.nodeIndex >= currentColumn.length) {
      const newNodeIndex = currentColumn.length - 1
      setKeyboardNav((prev) => ({ ...prev, nodeIndex: newNodeIndex }))
      setSelectedPath(currentColumn[newNodeIndex].path)
      return
    }
    const expectedNextColumn = keyboardNav.columnIndex + 1
    if (expectedNextColumn < columns.length && drillSelection.length > keyboardNav.columnIndex) {
      const nextColumn = columns[expectedNextColumn] || []
      if (nextColumn.length > 0) {
        setKeyboardNav({ columnIndex: expectedNextColumn, nodeIndex: 0 })
        setSelectedPath(nextColumn[0].path)
        return
      }
    }
    const currentNode = currentColumn[keyboardNav.nodeIndex]
    if (currentNode && selectedPath !== currentNode.path) {
      setSelectedPath(currentNode.path)
    }
  }, [columns, keyboardNav, drillSelection, selectedPath])

  const handleZoomIn = () => setZoomLevel((prev) => Math.min(prev + 10, 200))
  const handleZoomOut = () => setZoomLevel((prev) => Math.max(prev - 10, 50))

  // ── Taxonomy CRUD ──

  const addNewTaxonomyPath = useCallback(async (newPath: string) => {
    if (!newPath?.trim()) return
    const trimmedPath = newPath.trim()
    setTaxonomyPaths((prev) => prev.includes(trimmedPath) ? prev : [...prev, trimmedPath])
    try {
      setIsSavingNode(true)
      setAddNodeError(null)
      const currentNodes = await ipc.taxonomy.getNodes()
      const existingPaths = currentNodes.map((n: { fullPath: string }) => n.fullPath)
      if (!existingPaths.includes(trimmedPath)) {
        await ipc.taxonomy.addNode(trimmedPath)
      }
    } catch (e) {
      console.error('Failed to persist taxonomy path to backend', e)
      setAddNodeError('Failed to save taxonomy node.')
    } finally {
      setIsSavingNode(false)
    }
  }, [])

  const handleOpenAddNodeModal = () => {
    setAddNodeError(null)
    setNewL1('')
    setNewL2('')
    setNewL3('')
    setShowAddNodeModal(true)
  }

  const handleSaveNewNode = async () => {
    const parts = [newL1, newL2, newL3].map((p) => (p || '').trim()).filter((p) => p)
    if (parts.length === 0) {
      setAddNodeError('Please enter at least a Level 1 name.')
      return
    }
    await addNewTaxonomyPath(parts.join('|'))
    if (!addNodeError) setShowAddNodeModal(false)
  }

  const deleteTaxonomyNode = useCallback(async (node: TaxonomyTreeNode) => {
    if (!node || node.path === 'root') return
    const nodePath = node.path.replace(/^root\|/, '')
    const pathParts = nodePath.split('|').filter((p) => p.trim())
    if (pathParts.length === 0) return

    const pathsToRemove = taxonomyPaths.filter((path) => {
      const p = path.trim()
      return p === nodePath || p.startsWith(nodePath + '|')
    })
    if (pathsToRemove.length === 0) return

    setTaxonomyPaths((prev) => prev.filter((p) => !pathsToRemove.includes(p)))
    try {
      setIsDeleting(true)
      setDeleteError(null)
      const currentNodes = await ipc.taxonomy.getNodes()
      const nodesToDelete = currentNodes.filter((n: { fullPath: string }) => pathsToRemove.includes(n.fullPath))
      for (const n of nodesToDelete) {
        await ipc.taxonomy.deleteNode(n.id)
      }
    } catch (e) {
      console.error('Failed to delete taxonomy node from backend', e)
      setDeleteError('Failed to delete taxonomy node.')
      setTaxonomyPaths((prev) => [...prev, ...pathsToRemove])
    } finally {
      setIsDeleting(false)
    }
  }, [taxonomyPaths])

  const renameTaxonomyNode = useCallback(async (node: TaxonomyTreeNode, newName: string) => {
    if (!node || !newName?.trim() || node.path === 'root') return
    const trimmedNewName = newName.trim()
    const nodePath = node.path.replace(/^root\|/, '')
    const pathParts = nodePath.split('|').filter((p) => p.trim())
    if (pathParts.length === 0) return

    const levelIndex = pathParts.length - 1
    const oldName = pathParts[levelIndex]
    if (oldName === trimmedNewName) return

    const originalPaths = [...taxonomyPaths]
    const updatedPaths = taxonomyPaths.map((path) => {
      const parts = path.split('|').filter((p) => p.trim())
      if (parts.length <= levelIndex) return path
      if (!pathParts.slice(0, levelIndex).every((part, idx) => parts[idx] === part)) return path
      if (parts[levelIndex] !== oldName) return path
      const updated = [...parts]
      updated[levelIndex] = trimmedNewName
      return updated.join('|')
    })

    setTaxonomyPaths(updatedPaths)
    try {
      setIsRenaming(true)
      setRenameError(null)
      const currentNodes = await ipc.taxonomy.getNodes()
      const oldPathSet = new Set(originalPaths)
      const newPathSet = new Set(updatedPaths)
      const removedPaths = [...oldPathSet].filter((p) => !newPathSet.has(p))
      const addedPaths = [...newPathSet].filter((p) => !oldPathSet.has(p))
      for (const rp of removedPaths) {
        const n = currentNodes.find((n: { fullPath: string }) => n.fullPath === rp)
        if (n) await ipc.taxonomy.deleteNode(n.id)
      }
      for (const ap of addedPaths) {
        await ipc.taxonomy.addNode(ap)
      }
    } catch (e) {
      console.error('Failed to rename taxonomy node in backend', e)
      setRenameError('Failed to rename taxonomy node.')
      setTaxonomyPaths(originalPaths)
    } finally {
      setIsRenaming(false)
    }
  }, [taxonomyPaths])

  const handleRenameNode = (node: TaxonomyTreeNode) => {
    const nodePath = node.path.replace(/^root\|/, '')
    const pathParts = nodePath.split('|').filter((p) => p.trim())
    setNodeToRename(node)
    setRenameValue(pathParts[pathParts.length - 1] || '')
    setRenameError(null)
    setShowRenameModal(true)
  }

  const handleSaveRename = async () => {
    if (!nodeToRename || !renameValue?.trim()) {
      setRenameError('Please enter a new name.')
      return
    }
    await renameTaxonomyNode(nodeToRename, renameValue)
    if (!renameError) {
      setShowRenameModal(false)
      setNodeToRename(null)
      setRenameValue('')
    }
  }

  const handleDeleteNode = (node: TaxonomyTreeNode) => {
    setNodeToDelete(node)
    setDeleteError(null)
    setShowDeleteConfirm(true)
  }

  const handleConfirmDelete = async () => {
    if (!nodeToDelete) return
    await deleteTaxonomyNode(nodeToDelete)
    if (!deleteError) {
      setShowDeleteConfirm(false)
      setNodeToDelete(null)
    }
  }

  if (loadingTaxonomy) {
    return (
      <div className="classification-tree">
        <div className="tree-header">
          <h3>Classification Taxonomy</h3>
        </div>
        <div className="tree-content">
          <div className="empty-tree">
            <p>Loading taxonomy...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="classification-tree"
      ref={treeRef}
      tabIndex={0}
      onFocus={() => {
        if (columns.length > 0 && keyboardNav.columnIndex === 0 && keyboardNav.nodeIndex === 0) {
          const firstColumn = columns[0]
          if (firstColumn?.length > 0) setSelectedPath(firstColumn[0].path)
        }
      }}
    >
      <div className="tree-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h3>Classification Taxonomy</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="tree-info" title="Use arrow keys to navigate, Enter to reclassify selected rows">
            Drag rows here to reclassify • Arrow keys + Enter
          </span>
          <div className="zoom-controls">
            <button className="zoom-btn" onClick={handleZoomOut} disabled={zoomLevel <= 50} title="Zoom out">
              <Minus size={14} />
            </button>
            <span className="zoom-percentage">{zoomLevel}%</span>
            <button className="zoom-btn" onClick={handleZoomIn} disabled={zoomLevel >= 200} title="Zoom in">
              <Plus size={14} />
            </button>
          </div>
          <button className="add-node-btn" onClick={handleOpenAddNodeModal} title="Create a new taxonomy node">
            <Plus size={14} style={{ marginRight: 4 }} />
            Add node
          </button>
        </div>
      </div>

      <div
        className="tree-content"
        style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top left', transition: 'transform 0.2s ease' }}
      >
        {columns.length > 0 ? (
          <div className="tree-columns">
            {columns.map((nodes: TaxonomyTreeNode[], idx: number) => (
              <div
                key={idx}
                className={`tree-column column-level-${idx + 1} ${drillSelection[idx] ? 'active-column' : ''}`}
              >
                <div className="tree-column-header">
                  <span className="tree-column-title">Level {idx + 1}</span>
                  <span className="tree-column-count">{nodes.length} items</span>
                </div>
                <div className="tree-column-body">
                  {nodes.map((node: TaxonomyTreeNode, nodeIdx: number) => (
                    <ColumnNode
                      key={node.path}
                      node={node}
                      level={idx + 1}
                      isLeaf={!node.children || node.children.length === 0}
                      onSelect={(path) => setPathAtLevel(path, idx + 1)}
                      onHoverExpand={setPathAtLevel}
                      isSelected={selectedPath === node.path}
                      isActivePath={drillSelection[idx] === node.path}
                      isKeyboardSelected={keyboardNav.columnIndex === idx && keyboardNav.nodeIndex === nodeIdx}
                      onDropIds={handleDropRow}
                      onRename={handleRenameNode}
                      onDelete={handleDeleteNode}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-tree">
            <p>No classifications available</p>
            <p style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
              Load a classified dataset to see the taxonomy
            </p>
          </div>
        )}
      </div>

      {showAddNodeModal && (
        <div className="add-node-modal-backdrop" onClick={() => { if (!isSavingNode) setShowAddNodeModal(false) }}>
          <div className="add-node-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Create new taxonomy node</h4>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
              Define the path for the new node. Provide as many levels as you need (L1–L4).
            </p>
            <div className="add-node-form">
              <div className="add-node-row">
                <label>Level 1</label>
                <input type="text" value={newL1} onChange={(e) => setNewL1(e.target.value)} placeholder="e.g. clinical" />
              </div>
              <div className="add-node-row">
                <label>Level 2 (optional)</label>
                <input type="text" value={newL2} onChange={(e) => setNewL2(e.target.value)} placeholder="e.g. clinical services" />
              </div>
              <div className="add-node-row">
                <label>Level 3 (optional)</label>
                <input type="text" value={newL3} onChange={(e) => setNewL3(e.target.value)} placeholder="e.g. patient care" />
              </div>
              {addNodeError && <div className="add-node-error">{addNodeError}</div>}
              <div className="add-node-actions">
                <button type="button" className="add-node-cancel" onClick={() => { if (!isSavingNode) setShowAddNodeModal(false) }} disabled={isSavingNode}>Cancel</button>
                <button type="button" className="add-node-save" onClick={handleSaveNewNode} disabled={isSavingNode}>{isSavingNode ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRenameModal && nodeToRename && (
        <div className="add-node-modal-backdrop" onClick={() => { if (!isRenaming) { setShowRenameModal(false); setNodeToRename(null); setRenameValue('') } }}>
          <div className="add-node-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Rename taxonomy node</h4>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
              Renaming "{nodeToRename.name}" will update all paths containing this node name at this level.
            </p>
            <div className="add-node-form">
              <div className="add-node-row">
                <label>New name</label>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Enter new name"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !isRenaming) handleSaveRename() }}
                  autoFocus
                />
              </div>
              {renameError && <div className="add-node-error">{renameError}</div>}
              <div className="add-node-actions">
                <button type="button" className="add-node-cancel" onClick={() => { if (!isRenaming) { setShowRenameModal(false); setNodeToRename(null); setRenameValue('') } }} disabled={isRenaming}>Cancel</button>
                <button type="button" className="add-node-save" onClick={handleSaveRename} disabled={isRenaming}>{isRenaming ? 'Renaming…' : 'Rename'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && nodeToDelete && (
        <div className="add-node-modal-backdrop" onClick={() => { if (!isDeleting) { setShowDeleteConfirm(false); setNodeToDelete(null) } }}>
          <div className="add-node-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Delete taxonomy node</h4>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
              Are you sure you want to delete "{nodeToDelete.name}"?
            </p>
            {nodeToDelete.children?.length > 0 && (
              <p style={{ fontSize: '12px', color: '#d97706', marginBottom: '8px', fontWeight: 500 }}>
                ⚠️ Warning: This will also delete {nodeToDelete.children.length} child node{nodeToDelete.children.length !== 1 ? 's' : ''} and all their paths.
              </p>
            )}
            <div className="add-node-form">
              {deleteError && <div className="add-node-error">{deleteError}</div>}
              <div className="add-node-actions">
                <button type="button" className="add-node-cancel" onClick={() => { if (!isDeleting) { setShowDeleteConfirm(false); setNodeToDelete(null) } }} disabled={isDeleting}>Cancel</button>
                <button type="button" className="add-node-delete" onClick={handleConfirmDelete} disabled={isDeleting}>{isDeleting ? 'Deleting…' : 'Delete'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ClassificationTree
