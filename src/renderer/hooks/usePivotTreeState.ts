import { useState, useMemo, useCallback, useRef } from 'react'
import type { PivotTreeNode, FlattenedPivotRow } from './useHierarchicalPivotData'

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

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(allExpandableKeys)

  // When tree structure changes (e.g. dimension added/removed), expand all immediately
  const prevRootRef = useRef(root)
  if (prevRootRef.current !== root) {
    prevRootRef.current = root
    setExpandedKeys(allExpandableKeys)
  }

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

  // Flatten tree via DFS, respecting expand/collapse state
  const flatRows = useMemo((): FlattenedPivotRow[] => {
    if (!root) return []
    const rows: FlattenedPivotRow[] = []
    let prevL1Key = ''
    let prevL2Key = ''

    const walk = (node: PivotTreeNode) => {
      const isExpanded = expandedKeys.has(node.key)
      const hasChildren = node.children.length > 0

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
      })

      if (isExpanded && hasChildren) {
        for (const child of node.children) {
          walk(child)
        }
      }
    }

    for (const child of root.children) {
      walk(child)
    }

    return rows
  }, [root, expandedKeys])

  return {
    flatRows,
    toggleExpand,
    expandAll,
    collapseAll,
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
