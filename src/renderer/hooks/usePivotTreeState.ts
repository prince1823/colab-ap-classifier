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

  // Reset expand state ONLY when dimensions change (user adds/removes a
  // dimension from the pivot). Data re-fetches with the same dimensions
  // should NOT reset user's expand/collapse choices.
  const prevDimFingerprintRef = useRef(dimensionFingerprint)
  useEffect(() => {
    if (prevDimFingerprintRef.current !== dimensionFingerprint) {
      prevDimFingerprintRef.current = dimensionFingerprint
      setExpandedKeys(allExpandableKeys)
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

  // Flatten tree via DFS, respecting expand/collapse state
  const flatRows = useMemo((): FlattenedPivotRow[] => {
    if (!root) return []
    const rows: FlattenedPivotRow[] = []
    let prevL1Key = ''
    let prevL2Key = ''

    const walk = (node: PivotTreeNode, pathStack: PathSegment[], currentDepth0Key: string) => {
      const isExpanded = expandedKeys.has(node.key)
      const hasChildren = node.children.length > 0

      // Build path segments for this node
      const segment: PathSegment = { dimensionField: node.dimensionField, value: node.label }
      const pathSegments = [...pathStack, segment]
      const depth0Key = node.depth === 0 ? node.key : currentDepth0Key

      // Determine group separators
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

      if (isExpanded && hasChildren) {
        for (const child of node.children) {
          walk(child, pathSegments, depth0Key)
        }
      }
    }

    for (const child of root.children) {
      walk(child, [], '')
    }

    return rows
  }, [root, expandedKeys])

  return {
    flatRows,
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
 * Returns a new array with only matching rows and their ancestors.
 */
export function filterRowsBySearch(
  flatRows: FlattenedPivotRow[],
  search: string
): FlattenedPivotRow[] {
  if (!search.trim()) return flatRows
  const q = search.trim().toLowerCase()

  // Find all matching keys
  const matchingKeys = new Set<string>()
  for (const row of flatRows) {
    if (row.label.toLowerCase().includes(q)) {
      matchingKeys.add(row.key)
      // Add all ancestor keys (split by | and build prefixes)
      const parts = row.key.split('|')
      let prefix = ''
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = i === 0 ? parts[i] : `${prefix}|${parts[i]}`
        matchingKeys.add(prefix)
      }
    }
  }

  return flatRows.filter(row => matchingKeys.has(row.key))
}
