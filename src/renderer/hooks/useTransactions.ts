import { useState, useEffect, useCallback, useRef } from 'react'
import { ipc } from '../lib/ipc'
import { useIPC } from './useIPC'
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions } from '../../shared/types/transactions'

const DEFAULT_PAGE_SIZE = 100

interface UseTransactionsResult {
  data: Transaction[] | null
  loading: boolean
  error: string | null
  totalCount: number
  page: number
  pageSize: number
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void
  refetch: () => void
}

/**
 * Paginated transaction hook — fetches only the current page from the backend.
 * Filtering is done server-side via TransactionFilter.conditions.
 */
export function useTransactions(filters?: TransactionFilter): UseTransactionsResult {
  const [data, setData] = useState<Transaction[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(filters?.pageSize || DEFAULT_PAGE_SIZE)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)

  const fetchPage = useCallback(async () => {
    const generation = ++generationRef.current
    setError(null)
    setLoading(true)

    try {
      const result: PaginatedTransactions = await ipc.transactions.query({
        ...filters,
        page,
        pageSize,
      })

      if (!mountedRef.current || generation !== generationRef.current) return

      setTotalCount(result.totalCount)
      setData(result.rows)
      setLoading(false)
    } catch (e) {
      if (!mountedRef.current || generation !== generationRef.current) return
      setError(e instanceof Error ? e.message : 'Unknown error')
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters), page, pageSize])

  useEffect(() => {
    mountedRef.current = true
    fetchPage()
    return () => {
      mountedRef.current = false
    }
  }, [fetchPage])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)])

  const refetch = useCallback(() => {
    fetchPage()
  }, [fetchPage])

  return { data, loading, error, totalCount, page, pageSize, setPage, setPageSize, refetch }
}

export function useTransactionStats() {
  return useIPC<TransactionStats>(
    () => ipc.transactions.stats(),
    []
  )
}
