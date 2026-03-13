import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { PivotTreeNode, FlattenedPivotRow, PathSegment } from '../types/pivot'

/**
 * Manages expand/collapse state for the hierarchical pivot tree
 * and produces a flattened row list for rendering.
 */
export function usePivotTreeState(
  root: PivotTreeNode | null
) {
  // Compute all expandable keys (fully expanded state)
  const allExpandableKeys = useMemo(() => {
    if (!root) return new Set<string>()
    const keys = new Set<string>()
    const walk = (node: PivotTreeNode) => {
      if (node.children.length > 0) keys.add(node.key)
      for (const child of node.children) walk(child)
    }
    for (const child of root.children) walk(child)
    return keys
  }, [root])

  // Build a stable fingerprint from the tree's dimension fields.
  // This only changes when the actual row dimensions change (e.g. user
  // adds/removes a dimension), NOT when data is re-fetched with same dims.
  const dimensionFingerprint = useMemo(() => {
    if (!root || root.children.length === 0) return ''
    // Walk one path to the deepest leaf and collect dimension fields
    const dims: string[] = []
    let node = root.children[0]
    while (node) {
      dims.push(node.dimensionField)
      node = node.children[0]
    }
    return dims.join('|')
  }, [root])

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    if (!root) return new Set<string>()
    const keys = new Set<string>()
    const walk = (node: PivotTreeNode) => {
      if (node.children.length > 0) keys.add(node.key)
      for (const child of node.children) walk(child)
    }
    for (const child of root.children) walk(child)
    return keys
  })

  // Track previous state for smart merging
  const prevDimFingerprintRef = useRef(dimensionFingerprint)
  const prevExpandableKeysRef = useRef(allExpandableKeys)

  useEffect(() => {
    if (prevDimFingerprintRef.current !== dimensionFingerprint) {
      // Dimension change (user added/removed a pivot dimension) → full reset
      prevDimFingerprintRef.current = dimensionFingerprint
      prevExpandableKeysRef.current = allExpandableKeys
      setExpandedKeys(allExpandableKeys)
    } else if (allExpandableKeys !== prevExpandableKeysRef.current) {
      // Data change with same dimensions (e.g. after reclassification) →
      // preserve user's expand/collapse choices, auto-expand NEW nodes
      const prevKeys = prevExpandableKeysRef.current
      prevExpandableKeysRef.current = allExpandableKeys
      setExpandedKeys((currentExpanded) => {
        const merged = new Set(currentExpanded)
        // Auto-expand nodes that are new to this tree
        for (const key of allExpandableKeys) {
          if (!prevKeys.has(key)) {
            merged.add(key)
          }
        }
        // Remove keys that no longer exist in the new tree
        for (const key of merged) {
          if (!allExpandableKeys.has(key)) {
            merged.delete(key)
          }
        }
        return merged
      })
    }
  }, [dimensionFingerprint, allExpandableKeys])

  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    if (!root) return
    const keys = new Set<string>()
    const walk = (node: PivotTreeNode) => {
      if (node.children.length > 0) keys.add(node.key)
      for (const child of node.children) walk(child)
    }
    for (const child of root.children) walk(child)
    setExpandedKeys(keys)
  }, [root])

  const collapseAll = useCallback(() => {
    setExpandedKeys(new Set<string>())
  }, [])

  const expandToLevel = useCallback((targetDepth: number) => {
    if (!root) return
    const keys = new Set<string>()
    const walk = (node: PivotTreeNode) => {
      if (node.children.length > 0 && node.depth < targetDepth) {
        keys.add(node.key)
      }
      for (const child of node.children) walk(child)
    }
    for (const child of root.children) walk(child)
    setExpandedKeys(keys)
  }, [root])

  // Map depth-0 key → total spend (base for percentage calculations)
  const depth0TotalMap = useMemo(() => {
    if (!root) return new Map<string, number>()
    const map = new Map<string, number>()
    for (const child of root.children) {
      map.set(child.key, child.total)
    }
    return map
  }, [root])

  // Helper: flatten tree via DFS
  const flattenTree = useCallback((
    treeRoot: PivotTreeNode,
    respectExpanded: boolean
  ): FlattenedPivotRow[] => {
    const rows: FlattenedPivotRow[] = []
    let prevL1Key = ''
    let prevL2Key = ''

    const walk = (node: PivotTreeNode, pathStack: PathSegment[], currentDepth0Key: string) => {
      const isExpanded = expandedKeys.has(node.key)
      const hasChildren = node.children.length > 0

      const segment: PathSegment = { dimensionField: node.dimensionField, value: node.label }
      const pathSegments = [...pathStack, segment]
      const depth0Key = node.depth === 0 ? node.key : currentDepth0Key

      let isFirstInL1Group = false
      let isFirstInL2Group = false
      if (node.depth === 0) {
        isFirstInL1Group = node.key !== prevL1Key && prevL1Key !== ''
        prevL1Key = node.key
        prevL2Key = ''
      } else if (node.depth === 1) {
        const l2Key = node.key
        isFirstInL2Group = l2Key !== prevL2Key && prevL2Key !== ''
        prevL2Key = l2Key
      }

      rows.push({
        key: node.key,
        label: node.label,
        depth: node.depth,
        hasChildren,
        isExpanded,
        isLeaf: node.isLeaf,
        total: node.total,
        transactionCount: node.transactionCount,
        isFirstInL1Group,
        isFirstInL2Group,
        pathSegments,
        depth0AncestorKey: depth0Key,
        dimensionField: node.dimensionField,
      })

      if (hasChildren && (!respectExpanded || isExpanded)) {
        for (const child of node.children) {
          walk(child, pathSegments, depth0Key)
        }
      }
    }

    for (const child of treeRoot.children) {
      walk(child, [], '')
    }

    return rows
  }, [expandedKeys])

  // Flatten tree respecting expand/collapse state (normal view)
  const flatRows = useMemo(
    () => root ? flattenTree(root, true) : [],
    [root, flattenTree]
  )

  // Flatten entire tree ignoring expand/collapse (for search)
  const allFlatRows = useMemo(
    () => root ? flattenTree(root, false) : [],
    [root, flattenTree]
  )

  return {
    flatRows,
    allFlatRows,
    toggleExpand,
    expandAll,
    collapseAll,
    expandToLevel,
    depth0TotalMap,
    expandedKeys,
  }
}

/**
 * Filter flat rows by search term, preserving ancestor context.
 * Uses DFS position (walk-backward) to find true ancestors — safe even when
 * labels contain the `|` delimiter.  Ancestors are forced to isExpanded: true
 * so matching children are always visible during search.
 */
export function filterRowsBySearch(
  flatRows: FlattenedPivotRow[],
  search: string
): FlattenedPivotRow[] {
  if (!search.trim()) return flatRows
  const q = search.trim().toLowerCase()

  // Find indices of all matching rows
  const matchIndices: number[] = []
  for (let i = 0; i < flatRows.length; i++) {
    if (flatRows[i].label.toLowerCase().includes(q)) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 0) return []

  // For each match, walk backward in the DFS-ordered list to find true ancestors
  const includeKeys = new Set<string>()
  for (const idx of matchIndices) {
    includeKeys.add(flatRows[idx].key)
    // Walk back, collecting the first row at each decreasing depth
    let targetDepth = flatRows[idx].depth - 1
    for (let j = idx - 1; j >= 0 && targetDepth >= 0; j--) {
      if (flatRows[j].depth === targetDepth) {
        includeKeys.add(flatRows[j].key)
        targetDepth--
      }
    }
  }

  // Return filtered rows; force ancestors to show expanded chevron
  return flatRows
    .filter(row => includeKeys.has(row.key))
    .map(row =>
      row.hasChildren && !row.isExpanded
        ? { ...row, isExpanded: true }
        : row
    )
}
