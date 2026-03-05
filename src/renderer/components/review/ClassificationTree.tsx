import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useDrop } from 'react-dnd'
import { Plus, Minus, Edit2, Trash2 } from 'lucide-react'
import { TABLE_ROW_TYPE, ITEM_TYPE } from './MultiTableSystem'
import { buildTaxonomyTree, populateTreeWithTransactions } from '../../utils/taxonomyLoader'
import useKeyboardShortcuts from '../../hooks/useKeyboardShortcuts'
import { ipc } from '../../lib/ipc'
import { fmtAbbrev } from '../../utils/formatSpend'
import type { DashboardTransactionRow } from '../../utils/transactionTransform'
import '../../styles/ClassificationTree.css'

interface TaxonomyTreeNode {
  name: string;
  path: string;
  children: TaxonomyTreeNode[];
  count: number;
  amount: number;
}

interface DropItem {
  serverSide?: boolean;
  transactionRows?: Record<string, unknown>[];
  selectedValues?: string[];
  value?: string;
  column?: string;
  rows?: Record<string, unknown>[];
}

interface ColumnNodeProps {
  node: TaxonomyTreeNode;
  level: number;
  isSelected: boolean;
  isActivePath: boolean;
  onSelect: ((path: string) => void) | null;
  onDropRow: ((rows: Record<string, unknown>[], targetPath: string) => void) | null;
  onHoverExpand: ((path: string, level: number) => void) | null;
  isKeyboardSelected: boolean;
  onRename: ((node: TaxonomyTreeNode) => void) | null;
  onDelete: ((node: TaxonomyTreeNode) => void) | null;
  isLeaf: boolean;
}

interface ClassificationTreeProps {
  transactions: DashboardTransactionRow[];
  activeFilters: Record<string, unknown>;
  selectedRows: string[];
  setSelectedRows: React.Dispatch<React.SetStateAction<string[]>>;
  onReclassify: ((rows: Record<string, unknown>[], path: string) => Promise<boolean | void>) | null;
  mode: string;
  datasetId?: string;
  foldername?: string;
  keyboardFocus: 'tree' | 'tables';
  setKeyboardFocus: (focus: 'tree' | 'tables') => void;
}

const ColumnNode = React.memo(({ node, level, isSelected, isActivePath, onSelect, onDropRow, onHoverExpand, isKeyboardSelected, onRename, onDelete, isLeaf }: ColumnNodeProps) => {
  const levelLabel = level > 0 ? `L${level}` : ''
  const isDroppableLevel = isLeaf || level >= 3
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [{ isOverShallow, itemType, canDrop }, drop] = useDrop({
    accept: [TABLE_ROW_TYPE, ITEM_TYPE],
    drop: async (item: DropItem) => {
      if (onDropRow && node.path !== 'root' && isDroppableLevel) {
        // Server-side mode: fetch transaction IDs on-demand from DuckDB
        if (item.serverSide && (!item.transactionRows || item.transactionRows.length === 0)) {
          try {
            const values: string[] = item.selectedValues || [item.value].filter((v): v is string => !!v)
            // Fetch IDs for all selected values in parallel
            const idArrays = await Promise.all(
              values.map((v: string) => ipc.transactions.getIdsByValue(item.column!, v))
            )
            const allIds = idArrays.flat()
            if (allIds.length > 0) {
              // Create minimal row objects with just IDs for reclassification
              const rows = allIds.map((id: string) => ({ id }))
              onDropRow(rows, node.path)
            }
          } catch (err) {
            console.error('[Drop] Failed to fetch transaction IDs:', err)
          }
        } else {
          const rowsToReclassify = item.transactionRows || item.rows || []
          if (rowsToReclassify.length > 0) {
            onDropRow(rowsToReclassify, node.path)
          }
        }
      }
      return { targetPath: node.path }
    },
    // Allow hover events on all levels so we can auto-open deeper columns while dragging
    canDrop: () => true,
    collect: (monitor) => ({
      isOverShallow: monitor.isOver({ shallow: true }),
      itemType: monitor.getItemType(),
      canDrop: monitor.canDrop(),
    }),
  })

  // Auto-open the next column when dragging over this node (instant)
  useEffect(() => {
    if (isOverShallow && itemType && onHoverExpand) {
      onHoverExpand(node.path, level)
    }
  }, [isOverShallow, itemType, node.path, level, onHoverExpand])

  const [showActions, setShowActions] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    // Don't trigger select if clicking on action buttons
    if ((e.target as HTMLElement).closest('.node-actions')) {
      return
    }
    if (onSelect) {
      onSelect(node.path)
    }
  }

  const handleRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onRename && node.path !== 'root') {
      onRename(node)
    }
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onDelete && node.path !== 'root') {
      onDelete(node)
    }
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
          <button
            className="node-action-btn node-rename-btn"
            onClick={handleRename}
            title="Rename this node"
          >
            <Edit2 size={12} />
          </button>
          <button
            className="node-action-btn node-delete-btn"
            onClick={handleDelete}
            title="Delete this node and all its children"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  )
})

const ClassificationTree = ({
  transactions,
  activeFilters,
  selectedRows,
  setSelectedRows,
  onReclassify,
  mode,
  datasetId = 'innova34',
  foldername = 'default',
  keyboardFocus,
  setKeyboardFocus
}: ClassificationTreeProps) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [drillSelection, setDrillSelection] = useState<string[]>([])
  const [taxonomyPaths, setTaxonomyPaths] = useState<string[]>([])
  const [loadingTaxonomy, setLoadingTaxonomy] = useState(true)
  const [zoomLevel, setZoomLevel] = useState(100) // Zoom level in percentage (50% to 200%)
  const [localSuccess, setLocalSuccess] = useState<{ count: number; pathParts: string[] } | null>(null)
  const [keyboardNav, setKeyboardNav] = useState<{ columnIndex: number; nodeIndex: number }>({ columnIndex: 0, nodeIndex: 0 }) // Keyboard navigation state
  const treeRef = useRef<HTMLDivElement | null>(null) // Ref for the tree container to detect focus

  // UI state for creating new taxonomy nodes
  const [showAddNodeModal, setShowAddNodeModal] = useState(false)
  const [newL1, setNewL1] = useState('')
  const [newL2, setNewL2] = useState('')
  const [newL3, setNewL3] = useState('')
  const [isSavingNode, setIsSavingNode] = useState(false)
  const [addNodeError, setAddNodeError] = useState<string | null>(null)

  // UI state for renaming nodes
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [nodeToRename, setNodeToRename] = useState<TaxonomyTreeNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  // UI state for deleting nodes
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
        // Fallback: extract classification paths from transaction data
        const pathsFromData = new Set<string>()
        transactions.forEach((row: DashboardTransactionRow) => {
          const path = (row.classification_path as string) || (row.taxonomy_path as string) || ''
          if (path && path.trim()) {
            pathsFromData.add(path.trim())
          }
        })
        setTaxonomyPaths(Array.from(pathsFromData) as string[])
      } finally {
        setLoadingTaxonomy(false)
      }
    }

    loadTaxonomy()
  }, [datasetId, foldername, transactions.length])

  // Build taxonomy tree from YAML structure + populate with transaction data
  const taxonomyTree = useMemo(() => {
    if (loadingTaxonomy || transactions.length === 0) {
      return { name: 'Root', path: 'root', children: [], count: 0, amount: 0 }
    }
    
    // Filter transactions based on active filters
    const filtered = transactions.filter((row: DashboardTransactionRow) => {
      return Object.entries(activeFilters).every(([key, value]: [string, unknown]) => {
        if (!value) return true
        if (Array.isArray(value)) {
          return value.includes(row[key])
        }
        return row[key] === value
      })
    })

    // Build tree from all unique classification paths in the data
    const allPaths = new Set<string>()
    filtered.forEach((row: DashboardTransactionRow) => {
      const path = (row.classification_path as string) || (row.taxonomy_path as string) || ''
      if (path && path.trim()) {
        allPaths.add(path.trim())
      }
    })

    // If we have taxonomy paths from YAML, use those. Otherwise build from data
    const pathsToUse: string[] = taxonomyPaths.length > 0 ? taxonomyPaths : Array.from(allPaths)
    
    // Build tree structure
    const tree = buildTaxonomyTree(pathsToUse)
    
    // Populate with transaction counts and amounts
    const populatedTree = populateTreeWithTransactions(tree, filtered)
    
    return populatedTree
  }, [transactions, activeFilters, taxonomyPaths, loadingTaxonomy])
  
  const pathMap = useMemo(() => {
    const map = new Map<string, TaxonomyTreeNode>()
    const traverse = (node: TaxonomyTreeNode) => {
      map.set(node.path, node)
      if (node.children && node.children.length > 0) {
        node.children.forEach(traverse)
      }
    }
    traverse(taxonomyTree)
    return map
  }, [taxonomyTree])

  const sortNodesForColumn = useCallback((nodes: TaxonomyTreeNode[], level: number) => {
    const safeNumber = (val: unknown): number => {
      const n = typeof val === 'number' ? val : Number(val)
      return Number.isFinite(n) ? n : 0
    }

    const byName = (a: TaxonomyTreeNode, b: TaxonomyTreeNode) => String(a?.name || '').localeCompare(String(b?.name || ''))

    // Prefer amount sorting on levels that display amount (L1 and L4),
    // otherwise keep a stable alphabetical order.
    if (level === 1 || level === 4) {
      return [...nodes].sort((a: TaxonomyTreeNode, b: TaxonomyTreeNode) => {
        const diff = safeNumber(b?.amount) - safeNumber(a?.amount)
        if (diff !== 0) return diff
        return byName(a, b)
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

  // Initialize keyboard navigation when columns are first available
  useEffect(() => {
    if (columns && columns.length > 0 && keyboardNav.columnIndex === 0 && keyboardNav.nodeIndex === 0) {
      const firstColumn = columns[0]
      if (firstColumn && firstColumn.length > 0 && !selectedPath) {
        setSelectedPath(firstColumn[0].path)
      }
    }
  }, [columns, keyboardNav.columnIndex, keyboardNav.nodeIndex, selectedPath])

  const setPathAtLevel = (path: string, level: number) => {
    setDrillSelection((prev: string[]) => {
      const next = prev.slice(0, level - 1)
      if (next[level - 1] === path) return prev
      next[level - 1] = path
      return next
    })
    setSelectedPath((prev: string | null) => (prev === path ? prev : path))
  }

  const handleDropRow = async (rows: Record<string, unknown>[], targetPath: string) => {
    if (onReclassify && targetPath && targetPath !== 'root') {
      // Extract the classification path from targetPath (remove 'root|' prefix)
      const classificationPath = targetPath.replace(/^root\|/, '')
      
      // For now, just log - in production this would call the API
      console.log('Reclassifying rows:', rows, 'to path:', classificationPath)
      
      // Call onReclassify and wait for result - it returns true if successful, false if blocked
      if (onReclassify) {
        const success = await onReclassify(rows, classificationPath)
        
        if (success === true) {
          // Auto-navigate to the target branch
          autoNavigateToPath(targetPath)
        }
      }
    }
  }

  // Auto-navigate to a specific path by expanding all necessary levels
  const autoNavigateToPath = useCallback((targetPath: string) => {
    if (!targetPath || targetPath === 'root') return

    const pathParts = targetPath.split('|').filter((p: string) => p.trim())
    if (pathParts.length === 0) return

    // Build the drill selection path step by step
    const newDrillSelection: string[] = []
    let currentPath = 'root'
    
    // Navigate through each level
    for (let i = 0; i < pathParts.length && i < 4; i++) {
      currentPath = currentPath === 'root' 
        ? `root|${pathParts[i]}`
        : `${currentPath}|${pathParts[i]}`
      
      // Find the node at this path
      const node = pathMap.get(currentPath)
      if (node && node.children && node.children.length > 0) {
        // Expand this level if not the last one
        if (i < pathParts.length - 1) {
          newDrillSelection.push(currentPath)
        }
      }
    }
    
    // Update drill selection to show the target branch
    setDrillSelection(newDrillSelection)
    setSelectedPath(targetPath)
    
  }, [pathMap])

  const handleZoomIn = () => {
    setZoomLevel(prev => Math.min(prev + 10, 200)) // Max 200%
  }

  const handleZoomOut = () => {
    setZoomLevel(prev => Math.max(prev - 10, 50)) // Min 50%
  }

  // Persist a new taxonomy path via backend API.
  const addNewTaxonomyPath = useCallback(
    async (newPath: string) => {
      if (!newPath || !newPath.trim()) return
      const trimmedPath = newPath.trim()

      // Optimistic update in local state
      setTaxonomyPaths((prev: string[]) => (prev.includes(trimmedPath) ? prev : [...prev, trimmedPath]))

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
    },
    []
  )

  const handleOpenAddNodeModal = () => {
    setAddNodeError(null)
    setNewL1('')
    setNewL2('')
    setNewL3('')
    setShowAddNodeModal(true)
  }

  const handleSaveNewNode = async () => {
    const parts = [newL1, newL2, newL3]
      .map((p: string) => (p || '').trim())
      .filter((p: string) => p)
    if (parts.length === 0) {
      setAddNodeError('Please enter at least a Level 1 name.')
      return
    }
    const newPath = parts.join('|')
    await addNewTaxonomyPath(newPath)
    // If there is no backend error, close the modal
    if (!addNodeError) {
      setShowAddNodeModal(false)
    }
  }

  // Delete a taxonomy node and all its children paths
  const deleteTaxonomyNode = useCallback(
    async (nodeToDelete: TaxonomyTreeNode) => {
      if (!nodeToDelete || nodeToDelete.path === 'root') return

      const nodePath = nodeToDelete.path.replace(/^root\|/, '')
      const pathParts = nodePath.split('|').filter((p: string) => p.trim())
      if (pathParts.length === 0) return

      const pathsToRemove = taxonomyPaths.filter((path: string) => {
        const pathStr = path.trim()
        return pathStr === nodePath || pathStr.startsWith(nodePath + '|')
      })

      if (pathsToRemove.length === 0) return

      // Optimistic update
      setTaxonomyPaths((prev: string[]) => prev.filter((p: string) => !pathsToRemove.includes(p)))

      try {
        setIsDeleting(true)
        setDeleteError(null)

        const currentNodes = await ipc.taxonomy.getNodes()
        const nodesToDelete = currentNodes.filter((n: { fullPath: string }) => pathsToRemove.includes(n.fullPath))
        for (const node of nodesToDelete) {
          await ipc.taxonomy.deleteNode(node.id)
        }
      } catch (e) {
        console.error('Failed to delete taxonomy node from backend', e)
        setDeleteError('Failed to delete taxonomy node.')
        // Revert optimistic update on error
        setTaxonomyPaths((prev: string[]) => [...prev, ...pathsToRemove])
      } finally {
        setIsDeleting(false)
      }
    },
    [taxonomyPaths]
  )

  // Rename a taxonomy node (updates all paths containing this node name at that level)
  const renameTaxonomyNode = useCallback(
    async (nodeToRename: TaxonomyTreeNode, newName: string) => {
      if (!nodeToRename || !newName || !newName.trim() || nodeToRename.path === 'root') return

      const trimmedNewName = newName.trim()
      const nodePath = nodeToRename.path.replace(/^root\|/, '')
      const pathParts = nodePath.split('|').filter((p: string) => p.trim())
      if (pathParts.length === 0) return

      const levelIndex = pathParts.length - 1
      const oldName = pathParts[levelIndex]

      if (oldName === trimmedNewName) return

      const originalPaths = [...taxonomyPaths]

      const updatedPaths = taxonomyPaths.map((path: string) => {
        const parts = path.split('|').filter((p: string) => p.trim())
        if (parts.length <= levelIndex) return path
        const matchesUpToLevel = pathParts.slice(0, levelIndex).every((part: string, idx: number) => parts[idx] === part)
        if (!matchesUpToLevel) return path
        if (parts[levelIndex] !== oldName) return path
        const updatedParts = [...parts]
        updatedParts[levelIndex] = trimmedNewName
        return updatedParts.join('|')
      })

      // Optimistic update
      setTaxonomyPaths(updatedPaths)

      try {
        setIsRenaming(true)
        setRenameError(null)

        const currentNodes = await ipc.taxonomy.getNodes()
        const oldPathSet = new Set(originalPaths)
        const newPathSet = new Set(updatedPaths)
        const removedPaths = [...oldPathSet].filter((p: string) => !newPathSet.has(p))
        const addedPaths = [...newPathSet].filter((p: string) => !oldPathSet.has(p))
        for (const rp of removedPaths) {
          const node = currentNodes.find((n: { fullPath: string }) => n.fullPath === rp)
          if (node) await ipc.taxonomy.deleteNode(node.id)
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
    },
    [taxonomyPaths]
  )

  const handleRenameNode = (node: TaxonomyTreeNode) => {
    const nodePath = node.path.replace(/^root\|/, '')
    const pathParts = nodePath.split('|').filter((p: string) => p.trim())
    const currentName = pathParts[pathParts.length - 1] || ''
    setNodeToRename(node)
    setRenameValue(currentName)
    setRenameError(null)
    setShowRenameModal(true)
  }

  const handleSaveRename = async () => {
    if (!nodeToRename || !renameValue || !renameValue.trim()) {
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

  // Get transaction rows from selectedRows
  const getTransactionRowsFromSelection = useCallback(() => {
    if (!selectedRows || selectedRows.length === 0 || !transactions || transactions.length === 0) {
      return []
    }

    const transactionRows: DashboardTransactionRow[] = []

    selectedRows.forEach((key: string) => {
      // Format: "column:value" (e.g., "supplier_name:Acme Corp")
      const [column, ...rest] = key.split(':')
      const value = rest.join(':')
      
      if (!column || !value) return
      
      // Find matching transactions
      const matching = transactions.filter((row: DashboardTransactionRow) => {
        const raw = row[column]
        const rowVal = (raw !== null && raw !== undefined && String(raw).trim() !== '')
          ? String(raw).trim()
          : 'Unknown'
        return rowVal === value
      })
      
      transactionRows.push(...matching)
    })
    
    // Remove duplicates based on row_index or a combination of key fields
    const uniqueRows: DashboardTransactionRow[] = []
    const seen = new Set<string>()

    transactionRows.forEach((row: DashboardTransactionRow) => {
      const key = row.row_index !== undefined
        ? `index_${row.row_index}`
        : `${row.supplier_name || ''}_${row.invoice_number || ''}_${row.amount || ''}`
      
      if (!seen.has(key)) {
        seen.add(key)
        uniqueRows.push(row)
      }
    })
    
    return uniqueRows
  }, [selectedRows, transactions])

  // Keyboard navigation handlers
  const handleKeyboardNavigation = useCallback((direction: string) => {
    if (!columns || columns.length === 0) return
    
    setKeyboardNav(prev => {
      const { columnIndex, nodeIndex } = prev
      const currentColumn = columns[columnIndex]
      
      if (!currentColumn || currentColumn.length === 0) return prev
      
      let newColumnIndex = columnIndex
      let newNodeIndex = nodeIndex
      
      switch (direction) {
        case 'up':
          if (nodeIndex > 0) {
            newNodeIndex = nodeIndex - 1
          }
          break
        case 'down':
          if (nodeIndex < currentColumn.length - 1) {
            newNodeIndex = nodeIndex + 1
          }
          break
        case 'left':
          if (columnIndex > 0) {
            newColumnIndex = columnIndex - 1
            const prevColumn = columns[newColumnIndex]
            if (!prevColumn || prevColumn.length === 0) break
            
            // Find the parent node of the current node
            const currentNode = currentColumn[nodeIndex]
            if (currentNode && currentNode.path && currentNode.path !== 'root') {
              // Extract parent path by removing the last segment
              const pathParts = currentNode.path.split('|').filter(p => p.trim())
              if (pathParts.length > 1) {
                // Remove last part to get parent path
                const parentPath = pathParts.slice(0, -1).join('|')
                // Find the parent node in the previous column
                const parentIndex = prevColumn.findIndex((n: TaxonomyTreeNode) => n.path === parentPath)
                if (parentIndex >= 0) {
                  newNodeIndex = parentIndex
                  // Update drill selection to collapse the current level
                  // This will cause columns to update and show the correct parent level
                  setDrillSelection(prev => prev.slice(0, newColumnIndex))
                } else {
                  // Fallback: use first item or maintain relative position
                  newNodeIndex = Math.min(nodeIndex, prevColumn.length - 1)
                  setDrillSelection(prev => prev.slice(0, newColumnIndex))
                }
              } else {
                // At root level, go to first item
                newNodeIndex = 0
                setDrillSelection([])
              }
            } else {
              // Fallback: use first item
              newNodeIndex = 0
              setDrillSelection(prev => prev.slice(0, newColumnIndex))
            }
          }
          break
        case 'right':
          const currentNode = currentColumn[nodeIndex]
          if (currentNode && currentNode.children && currentNode.children.length > 0) {
            // Expand to next level - this will update columns asynchronously
            setPathAtLevel(currentNode.path, columnIndex + 1)
            // We'll handle moving to the new column in useEffect when columns update
            // For now, just return current state
            return prev
          } else if (columnIndex < columns.length - 1) {
            // No children, but there's a next column - move to it
            newColumnIndex = columnIndex + 1
            const nextColumn = columns[newColumnIndex] || []
            newNodeIndex = Math.min(0, nextColumn.length - 1)
          }
          break
        default:
          return prev
      }
      
      // Update selected path based on new position
      const newColumn = columns[newColumnIndex]
      if (newColumn && newColumn[newNodeIndex]) {
        const newNode = newColumn[newNodeIndex]
        setSelectedPath(newNode.path)
        
        // If navigating to L4, ensure it's selected
        if (newColumnIndex === 3 && newNode.path !== 'root') {
          // Already at L4, path is set
        }
      }
      
      return { columnIndex: newColumnIndex, nodeIndex: newNodeIndex }
    })
  }, [columns, setPathAtLevel, pathMap])

  // Handle Enter key to reclassify
  const handleReclassifyWithKeyboard = useCallback(() => {
    const { columnIndex, nodeIndex } = keyboardNav

    if (!columns || columns.length === 0) return
    const currentColumn = columns[columnIndex]
    if (!currentColumn || !currentColumn[nodeIndex]) return

    const targetNode = currentColumn[nodeIndex]
    if (!targetNode || targetNode.path === 'root') return

    // Allow reclassification on leaf nodes or nodes at L3+
    const isLeaf = !targetNode.children || targetNode.children.length === 0
    if (!isLeaf && columnIndex < 2) {
      console.log('Please navigate to a leaf node (deepest level) to reclassify')
      return
    }
    
    // Get transaction rows from selectedRows
    const transactionRows = getTransactionRowsFromSelection()
    
    if (transactionRows.length === 0) {
      console.log('No rows selected. Please select rows from the tables first.')
      return
    }
    
    // Trigger reclassification
    handleDropRow(transactionRows, targetNode.path)
  }, [keyboardNav, columns, getTransactionRowsFromSelection, handleDropRow])

  // Set up keyboard shortcuts
  useKeyboardShortcuts({
    'arrowup': (e: KeyboardEvent) => {
      // Only handle if tree is focused or visible
      if (keyboardFocus === 'tree') {
        const { columnIndex } = keyboardNav
        // If at L1 (columnIndex 0) and at first row, switch to tables
        if (columnIndex === 0 && keyboardNav.nodeIndex === 0) {
          e.preventDefault()
          setKeyboardFocus('tables')
          return
        }
        e.preventDefault()
        handleKeyboardNavigation('up')
      }
    },
    'arrowdown': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        e.preventDefault()
        handleKeyboardNavigation('down')
      }
    },
    'arrowleft': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        e.preventDefault()
        handleKeyboardNavigation('left')
      }
    },
    'arrowright': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        e.preventDefault()
        handleKeyboardNavigation('right')
      }
    },
    'enter': (e: KeyboardEvent) => {
      // Only trigger if tree is visible and we're not in an input field
      if (keyboardFocus === 'tree' && (e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        e.preventDefault()
        handleReclassifyWithKeyboard()
      }
    }
  })

  // Update keyboard navigation when columns change (e.g., after expanding with right arrow)
  useEffect(() => {
    if (columns.length === 0) return
    
    const currentColumn = columns[keyboardNav.columnIndex]
    
    // If column doesn't exist or is empty, reset to first
    if (!currentColumn || currentColumn.length === 0) {
      if (columns[0] && columns[0][0]) {
        setKeyboardNav({ columnIndex: 0, nodeIndex: 0 })
        setSelectedPath(columns[0][0].path)
      }
      return
    }
    
    // If node index is out of bounds, clamp it
    if (keyboardNav.nodeIndex >= currentColumn.length) {
      const newNodeIndex = currentColumn.length - 1
      setKeyboardNav(prev => ({ ...prev, nodeIndex: newNodeIndex }))
      setSelectedPath(currentColumn[newNodeIndex].path)
      return
    }
    
    // Check if we just expanded (drillSelection increased and we're at the boundary)
    // This happens when right arrow was pressed to expand
    const expectedNextColumn = keyboardNav.columnIndex + 1
    if (expectedNextColumn < columns.length && drillSelection.length > keyboardNav.columnIndex) {
      // We just expanded - move to the new column
      const nextColumn = columns[expectedNextColumn] || []
      if (nextColumn.length > 0) {
        setKeyboardNav({ columnIndex: expectedNextColumn, nodeIndex: 0 })
        setSelectedPath(nextColumn[0].path)
        return
      }
    }
    
    // Ensure selected path matches keyboard nav position
    const currentNode = currentColumn[keyboardNav.nodeIndex]
    if (currentNode && selectedPath !== currentNode.path) {
      setSelectedPath(currentNode.path)
    }
  }, [columns, keyboardNav, drillSelection, selectedPath])

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
        // When tree gets focus, initialize keyboard nav if needed
        if (columns.length > 0 && keyboardNav.columnIndex === 0 && keyboardNav.nodeIndex === 0) {
          const firstColumn = columns[0]
          if (firstColumn && firstColumn.length > 0) {
            setSelectedPath(firstColumn[0].path)
          }
        }
      }}
    >
      {localSuccess && (
        <div className="tree-success-toast">
          <div className="toast-content">
            <span className="toast-title">
              Successfully reclassified {localSuccess.count} row{localSuccess.count !== 1 ? 's' : ''}
            </span>
            <div className="toast-path">
              {localSuccess.pathParts.map((part: string, idx: number) => (
                <span key={idx} className="toast-path-part">
                  {idx > 0 && <span className="toast-path-separator">→</span>}
                  <span>{part}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="tree-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h3>Classification Taxonomy</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="tree-info" title="Use arrow keys to navigate, Enter to reclassify selected rows">
            Drag rows here to reclassify • Arrow keys + Enter
          </span>
          <div className="zoom-controls">
            <button
              className="zoom-btn"
              onClick={handleZoomOut}
              disabled={zoomLevel <= 50}
              title="Zoom out"
            >
              <Minus size={14} />
            </button>
            <span className="zoom-percentage">{zoomLevel}%</span>
            <button
              className="zoom-btn"
              onClick={handleZoomIn}
              disabled={zoomLevel >= 200}
              title="Zoom in"
            >
              <Plus size={14} />
            </button>
          </div>
          <button
            className="add-node-btn"
            onClick={handleOpenAddNodeModal}
            title="Create a new taxonomy node"
          >
            <Plus size={14} style={{ marginRight: 4 }} />
            Add node
          </button>
        </div>
      </div>
      <div 
        className="tree-content"
          style={{
            transform: `scale(${zoomLevel / 100})`,
            transformOrigin: 'top left',
            transition: 'transform 0.2s ease'
          }}
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
                        onDropRow={handleDropRow}
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
        <div
          className="add-node-modal-backdrop"
          onClick={() => {
            if (!isSavingNode) {
              setShowAddNodeModal(false)
            }
          }}
        >
          <div
            className="add-node-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h4>Create new taxonomy node</h4>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
              Define the path for the new node. Provide as many levels as you need (L1–L4).
            </p>
            <div className="add-node-form">
              <div className="add-node-row">
                <label>Level 1</label>
                <input
                  type="text"
                  value={newL1}
                  onChange={(e) => setNewL1(e.target.value)}
                  placeholder="e.g. clinical"
                />
              </div>
              <div className="add-node-row">
                <label>Level 2 (optional)</label>
                <input
                  type="text"
                  value={newL2}
                  onChange={(e) => setNewL2(e.target.value)}
                  placeholder="e.g. clinical services"
                />
              </div>
              <div className="add-node-row">
                <label>Level 3 (optional)</label>
                <input
                  type="text"
                  value={newL3}
                  onChange={(e) => setNewL3(e.target.value)}
                  placeholder="e.g. patient care"
                />
              </div>
              {addNodeError && (
                <div className="add-node-error">
                  {addNodeError}
                </div>
              )}
              <div className="add-node-actions">
                <button
                  type="button"
                  className="add-node-cancel"
                  onClick={() => {
                    if (!isSavingNode) {
                      setShowAddNodeModal(false)
                    }
                  }}
                  disabled={isSavingNode}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="add-node-save"
                  onClick={handleSaveNewNode}
                  disabled={isSavingNode}
                >
                  {isSavingNode ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRenameModal && nodeToRename && (
        <div
          className="add-node-modal-backdrop"
          onClick={() => {
            if (!isRenaming) {
              setShowRenameModal(false)
              setNodeToRename(null)
              setRenameValue('')
            }
          }}
        >
          <div
            className="add-node-modal"
            onClick={(e) => e.stopPropagation()}
          >
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isRenaming) {
                      handleSaveRename()
                    }
                  }}
                  autoFocus
                />
              </div>
              {renameError && (
                <div className="add-node-error">
                  {renameError}
                </div>
              )}
              <div className="add-node-actions">
                <button
                  type="button"
                  className="add-node-cancel"
                  onClick={() => {
                    if (!isRenaming) {
                      setShowRenameModal(false)
                      setNodeToRename(null)
                      setRenameValue('')
                    }
                  }}
                  disabled={isRenaming}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="add-node-save"
                  onClick={handleSaveRename}
                  disabled={isRenaming}
                >
                  {isRenaming ? 'Renaming…' : 'Rename'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && nodeToDelete && (
        <div
          className="add-node-modal-backdrop"
          onClick={() => {
            if (!isDeleting) {
              setShowDeleteConfirm(false)
              setNodeToDelete(null)
            }
          }}
        >
          <div
            className="add-node-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h4>Delete taxonomy node</h4>
            <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
              Are you sure you want to delete "{nodeToDelete.name}"?
            </p>
            {nodeToDelete.children && nodeToDelete.children.length > 0 && (
              <p style={{ fontSize: '12px', color: '#d97706', marginBottom: '8px', fontWeight: 500 }}>
                ⚠️ Warning: This will also delete {nodeToDelete.children.length} child node{nodeToDelete.children.length !== 1 ? 's' : ''} and all their paths.
              </p>
            )}
            <div className="add-node-form">
              {deleteError && (
                <div className="add-node-error">
                  {deleteError}
                </div>
              )}
              <div className="add-node-actions">
                <button
                  type="button"
                  className="add-node-cancel"
                  onClick={() => {
                    if (!isDeleting) {
                      setShowDeleteConfirm(false)
                      setNodeToDelete(null)
                    }
                  }}
                  disabled={isDeleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="add-node-delete"
                  onClick={handleConfirmDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default ClassificationTree
