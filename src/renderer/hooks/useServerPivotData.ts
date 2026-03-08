import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { TransactionFilter } from '../../shared/types/transactions'
import type { HierarchicalPivotData, PivotTreeNode, Aggregation } from '../types/pivot'

interface UseServerPivotDataResult {
  pivotData: HierarchicalPivotData | null
  loading: boolean
  error: string | null
  totalCount: number
  refetch: () => void
}

/**
 * Server-side pivot aggregation hook.
 * Replaces useTransactions + useHierarchicalPivotData for large datasets.
 *
 * DuckDB runs a multi-level GROUP BY (e.g. GROUP BY supplier_name, gl_description)
 * in milliseconds even on 4M rows, returning only the aggregated rows (~hundreds).
 * We then build the PivotTreeNode hierarchy client-side from the compact result.
 */
export function useServerPivotData(
  dimensions: string[],
  valueDimension: string = 'spend_amount',
  aggregation: Aggregation = 'sum',
  filters?: TransactionFilter
): UseServerPivotDataResult {
  const [rawRows, setRawRows] = useState<{ dimensions: string[]; amount: number; count: number }[]>([])
  const [dimCols, setDimCols] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)

  const fetchPivot = useCallback(async () => {
    const generation = ++generationRef.current
    setError(null)
    setLoading(true)

    try {
      const result = await ipc.transactions.pivotAggregation(
        dimensions,
        valueDimension,
        filters
      )

      if (!mountedRef.current || generation !== generationRef.current) return

      setRawRows(result.rows)
      setDimCols(result.dimensionColumns)
      setTotalCount(result.totalCount)
      setLoading(false)
    } catch (e) {
      if (!mountedRef.current || generation !== generationRef.current) return
      setError(e instanceof Error ? e.message : 'Unknown error')
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(dimensions), valueDimension, JSON.stringify(filters)])

  useEffect(() => {
    mountedRef.current = true
    fetchPivot()
    return () => {
      mountedRef.current = false
    }
  }, [fetchPivot])

  const refetch = useCallback(() => {
    fetchPivot()
  }, [fetchPivot])

  // Auto-refresh while classification is running
  const isClassifying = useWorkflowStore((s) => s.isClassifying)
  const wasClassifyingRef = useRef(false)

  useEffect(() => {
    if (isClassifying) {
      wasClassifyingRef.current = true
      const interval = setInterval(() => fetchPivot(), 5000)
      return () => clearInterval(interval)
    } else if (wasClassifyingRef.current) {
      // Classification just finished — do one final refresh
      wasClassifyingRef.current = false
      fetchPivot()
    }
  }, [isClassifying, fetchPivot])

  // Build the PivotTreeNode hierarchy from flat aggregated rows
  const pivotData = useMemo((): HierarchicalPivotData | null => {
    if (!rawRows.length || !dimCols.length) return null

    const UNCLASSIFIED = '(Unclassified)'

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

    let grandTotal = 0

    for (const row of rawRows) {
      const amount = row.amount
      const count = row.count

      let currentNode = root
      let currentKey = '__root__'

      for (let d = 0; d < dimCols.length; d++) {
        const dimField = dimCols[d]
        const rawVal = (row.dimensions[d] || '').trim()
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
            isLeaf: d === dimCols.length - 1,
            transactionCount: 0,
          }
          childMap.set(label, childNode)
          currentNode.children.push(childNode)
        }

        childNode.total += amount
        childNode.transactionCount += count

        currentNode = childNode
        currentKey = nodeKey
      }

      root.total += amount
      root.transactionCount += count
      grandTotal += amount
    }

    // Sort children at every level by total desc
    const sortChildren = (node: PivotTreeNode) => {
      node.children.sort((a, b) => b.total - a.total)
      for (const child of node.children) sortChildren(child)
    }
    sortChildren(root)

    // Convert totals based on aggregation type
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

    return { root, grandTotal, rowDimensions: dimCols }
  }, [rawRows, dimCols, aggregation])

  return { pivotData, loading, error, totalCount, refetch }
}
