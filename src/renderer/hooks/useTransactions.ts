import { useState, useEffect, useCallback, useRef } from 'react'
import { ipc } from '../lib/ipc'
import { useIPC } from './useIPC'
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions } from '../../shared/types/transactions'

/**
 * Chunk size for progressive loading.
 * 5000 rows per chunk keeps IPC payload under ~5MB (safe for Electron).
 */
const CHUNK_SIZE = 5000

interface UseTransactionsResult {
  data: Transaction[] | null
  loading: boolean
  /** True while additional chunks are still being fetched after the first load */
  loadingMore: boolean
  error: string | null
  /** Total rows in the database (known after first chunk) */
  totalCount: number
  /** Number of rows loaded so far */
  loadedCount: number
  refetch: () => void
}

/**
 * Hook that progressively loads ALL transactions in chunks of CHUNK_SIZE.
 * First chunk resolves quickly so the UI is responsive, then remaining
 * chunks are fetched in the background and appended.
 *
 * On refetch (e.g. after reclassification) the existing data stays visible
 * while new data loads — no "No Data Available" flash.
 */
export function useTransactions(filters?: TransactionFilter): UseTransactionsResult {
  const [data, setData] = useState<Transaction[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [loadedCount, setLoadedCount] = useState(0)
  const mountedRef = useRef(true)
  const abortRef = useRef(false)
  const hasDataRef = useRef(false) // tracks whether we've ever loaded data
  // Track current fetch generation to discard stale results
  const generationRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    abortRef.current = false
    setError(null)
    setLoadingMore(false)

    // Only show full loading spinner on first load.
    // On refetch, keep existing data visible to prevent flash.
    if (!hasDataRef.current) {
      setLoading(true)
    }

    try {
      // First paginated query — gets totalCount + first chunk
      const firstResult: PaginatedTransactions = await ipc.transactions.queryPaginated({
        ...filters,
        page: 1,
        pageSize: CHUNK_SIZE,
      })

      if (!mountedRef.current || abortRef.current || generation !== generationRef.current) return

      const total = firstResult.totalCount
      setTotalCount(total)
      setData(firstResult.rows)
      setLoadedCount(firstResult.rows.length)
      setLoading(false)
      hasDataRef.current = firstResult.rows.length > 0

      // If all data fits in one chunk, we're done
      if (firstResult.rows.length >= total) {
        return
      }

      // Otherwise, load remaining chunks in background
      setLoadingMore(true)
      const totalPages = Math.ceil(total / CHUNK_SIZE)
      let accumulated = [...firstResult.rows]

      for (let page = 2; page <= totalPages; page++) {
        if (!mountedRef.current || abortRef.current || generation !== generationRef.current) return

        const chunk: PaginatedTransactions = await ipc.transactions.queryPaginated({
          ...filters,
          page,
          pageSize: CHUNK_SIZE,
        })

        if (!mountedRef.current || abortRef.current || generation !== generationRef.current) return

        accumulated = [...accumulated, ...chunk.rows]
        setData(accumulated)
        setLoadedCount(accumulated.length)
      }

      setLoadingMore(false)
    } catch (e) {
      if (!mountedRef.current || generation !== generationRef.current) return
      setError(e instanceof Error ? e.message : 'Unknown error')
      setLoading(false)
      setLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)])

  useEffect(() => {
    mountedRef.current = true
    abortRef.current = false
    fetchAll()
    return () => {
      mountedRef.current = false
      abortRef.current = true
    }
  }, [fetchAll])

  const refetch = useCallback(() => {
    abortRef.current = true // abort any in-flight chunk loading
    fetchAll()
  }, [fetchAll])

  return { data, loading, loadingMore, error, totalCount, loadedCount, refetch }
}

export function useTransactionStats() {
  return useIPC<TransactionStats>(
    () => ipc.transactions.stats(),
    []
  )
}
