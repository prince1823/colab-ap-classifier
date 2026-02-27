import { useState, useEffect, useCallback, useRef } from 'react'
import { ipc } from '../lib/ipc'
import type { TransactionFilter, GroupedTransactionsResult } from '../../shared/types/transactions'

interface UseGroupedTransactionsResult {
  /** Map of column name → grouped aggregation result */
  data: Map<string, GroupedTransactionsResult>
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Fetches server-side GROUP BY aggregates for multiple columns in parallel.
 * Replaces useTransactions for the Review tab — returns grouped rows
 * (value, amount, count) instead of 4M raw Transaction objects.
 */
export function useGroupedTransactions(
  columns: string[],
  filters?: TransactionFilter
): UseGroupedTransactionsResult {
  const [data, setData] = useState<Map<string, GroupedTransactionsResult>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)

  const fetchGrouped = useCallback(async () => {
    const generation = ++generationRef.current
    setError(null)
    setLoading(true)

    try {
      const results = await Promise.all(
        columns.map((col) => ipc.transactions.queryGrouped(col, filters))
      )

      if (!mountedRef.current || generation !== generationRef.current) return

      const map = new Map<string, GroupedTransactionsResult>()
      for (const result of results) {
        map.set(result.column, result)
      }

      setData(map)
      setLoading(false)
    } catch (e) {
      if (!mountedRef.current || generation !== generationRef.current) return
      setError(e instanceof Error ? e.message : 'Unknown error')
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(columns), JSON.stringify(filters)])

  useEffect(() => {
    mountedRef.current = true
    fetchGrouped()
    return () => {
      mountedRef.current = false
    }
  }, [fetchGrouped])

  const refetch = useCallback(() => {
    fetchGrouped()
  }, [fetchGrouped])

  return { data, loading, error, refetch }
}
