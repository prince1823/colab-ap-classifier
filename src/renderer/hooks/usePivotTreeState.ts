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

  // Expand all ancestors of a given key so the row becomes visible
  const expandToKey = useCallback((key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      // Key format: "LABEL1|LABEL2|LABEL3" — expand each prefix
      const parts = key.split('|')
      for (let i = 1; i <= parts.length; i++) {
        next.add(parts.slice(0, i).join('|'))
      }
      return next
    })
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
    expandToKey,
    depth0TotalMap,
    expandedKeys,
  }
}

/**
 * Filter flat rows by search term.
 * Shows matching rows plus their visible descendants (respecting expand/collapse).
 * Matching rows with children can be clicked to expand/drill-down within search.
 *
 * @param flatRows - rows that respect current expand/collapse state
 * @param allFlatRows - full tree (ignoring expand/collapse) to find all matches
 * @param search - search query
 */
export function filterRowsBySearch(
  flatRows: FlattenedPivotRow[],
  allFlatRows: FlattenedPivotRow[],
  search: string
): FlattenedPivotRow[] {
  if (!search.trim()) return flatRows
  const q = search.trim().toLowerCase()

  // Find all keys that match the search (from full tree)
  const matchKeys = new Set<string>()
  for (const row of allFlatRows) {
    if (row.label.toLowerCase().includes(q)) {
      matchKeys.add(row.key)
    }
  }
  if (matchKeys.size === 0) return []

  // From the expand-aware flatRows, include:
  // 1. Rows whose key matches the search
  // 2. Rows that are descendants of a matched row (key starts with matchKey|)
  const result: FlattenedPivotRow[] = []
  for (const row of flatRows) {
    if (matchKeys.has(row.key)) {
      result.push(row)
    } else {
      // Check if this row is a descendant of any match
      for (const mk of matchKeys) {
        if (row.key.startsWith(mk + '|')) {
          result.push(row)
          break
        }
      }
    }
  }
  return result
}
