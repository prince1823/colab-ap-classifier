import { ipc } from '../lib/ipc'
import { useIPC } from './useIPC'
import type { Transaction, TransactionFilter, TransactionStats } from '../../shared/types/transactions'

export function useTransactions(filters?: TransactionFilter) {
  return useIPC<Transaction[]>(
    () => ipc.transactions.query(filters),
    [JSON.stringify(filters)]
  )
}

export function useTransactionStats() {
  return useIPC<TransactionStats>(
    () => ipc.transactions.stats(),
    []
  )
}
