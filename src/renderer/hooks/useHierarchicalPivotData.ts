import { useMemo } from 'react'

/** One node in the hierarchical row tree */
export interface PivotTreeNode {
  key: string
  label: string
  depth: number
  dimensionField: string
  total: number
  children: PivotTreeNode[]
  isLeaf: boolean
  transactionCount: number
}

/** Full hierarchical pivot result */
export interface HierarchicalPivotData {
  root: PivotTreeNode
  grandTotal: number
  rowDimensions: string[]
}

/** Flattened row ready for table rendering */
export interface FlattenedPivotRow {
  key: string
  label: string
  depth: number
  hasChildren: boolean
  isExpanded: boolean
  isLeaf: boolean
  total: number
  transactionCount: number
  isFirstInL1Group: boolean
  isFirstInL2Group: boolean
}

export type Aggregation = 'sum' | 'count' | 'average'

const UNCLASSIFIED = '(Unclassified)'

function normalizeValue(raw: unknown): string {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'N/A') return ''
  return s
}

export function useHierarchicalPivotData(
  transactions: Record<string, unknown>[],
  rowDimensions: string[],
  valueDimension: string = 'spend_amount',
  aggregation: Aggregation = 'sum'
): HierarchicalPivotData | null {
  return useMemo(() => {
    if (!transactions.length || !rowDimensions.length) return null

    let grandTotal = 0

    // Root node — hidden, depth -1
    const root: PivotTreeNode = {
      key: '__root__',
      label: '',
      depth: -1,
      dimensionField: '',
      total: 0,
      children: [],
      isLeaf: false,
      transactionCount: 0,
    }

    // Map for fast child lookup: parentKey -> Map<childLabel, PivotTreeNode>
    const childMaps = new Map<string, Map<string, PivotTreeNode>>()
    childMaps.set('__root__', new Map())

    for (const t of transactions) {
      const amount = Number(t[valueDimension] || t.spend_amount || 0)
      if (amount === 0 || isNaN(amount)) continue

      // Walk row dimensions to build/find path in tree
      let currentNode = root
      let currentKey = '__root__'

      for (let d = 0; d < rowDimensions.length; d++) {
        const dimField = rowDimensions[d]
        const rawVal = normalizeValue(t[dimField])
        const label = rawVal || UNCLASSIFIED
        const nodeKey = currentKey === '__root__' ? label : `${currentKey}|${label}`

        let childMap = childMaps.get(currentKey)
        if (!childMap) {
          childMap = new Map()
          childMaps.set(currentKey, childMap)
        }

        let childNode = childMap.get(label)
        if (!childNode) {
          childNode = {
            key: nodeKey,
            label,
            depth: d,
            dimensionField: dimField,
            total: 0,
            children: [],
            isLeaf: d === rowDimensions.length - 1,
            transactionCount: 0,
          }
          childMap.set(label, childNode)
          currentNode.children.push(childNode)
        }

        // Accumulate at every level
        childNode.total += amount
        childNode.transactionCount += 1

        currentNode = childNode
        currentKey = nodeKey
      }

      // Accumulate root
      root.total += amount
      root.transactionCount += 1
      grandTotal += amount
    }

    // Sort children at every level by total desc
    const sortChildren = (node: PivotTreeNode) => {
      node.children.sort((a, b) => b.total - a.total)
      for (const child of node.children) {
        sortChildren(child)
      }
    }
    sortChildren(root)

    // If aggregation is 'average', convert totals to averages
    if (aggregation === 'average') {
      const convertToAvg = (node: PivotTreeNode) => {
        if (node.transactionCount > 0) {
          node.total = node.total / node.transactionCount
        }
        for (const c of node.children) convertToAvg(c)
      }
      for (const c of root.children) convertToAvg(c)
    } else if (aggregation === 'count') {
      const convertToCount = (node: PivotTreeNode) => {
        node.total = node.transactionCount
        for (const c of node.children) convertToCount(c)
      }
      for (const c of root.children) convertToCount(c)
    }

    return {
      root,
      grandTotal,
      rowDimensions,
    }
  }, [transactions, rowDimensions, valueDimension, aggregation])
}
