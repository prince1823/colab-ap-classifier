import React, { useMemo } from 'react'
import MetricsTab from './MetricsTab'
import { useIPC } from '../../hooks/useIPC'
import { ipc } from '../../lib/ipc'
import type { TransactionFilter } from '../../../shared/types/transactions'

interface MetricsTabContainerProps {
  filter?: TransactionFilter
}

const MetricsTabContainer: React.FC<MetricsTabContainerProps> = ({ filter }) => {
  const filterKey = useMemo(() => JSON.stringify(filter), [filter])

  // Global stats — unfiltered total rows/spend/suppliers
  const { data: stats } = useIPC(() => ipc.transactions.stats(), [])

  // L1 spend breakdown (filtered)
  const { data: l1Result } = useIPC(
    () => ipc.transactions.pivotAggregation(['classification_l1'], 'spend_amount', filter),
    [filterKey]
  )

  // Top suppliers by spend (filtered)
  const { data: supplierResult } = useIPC(
    () => ipc.transactions.pivotAggregation(['supplier_name'], 'spend_amount', filter),
    [filterKey]
  )

  // Monthly spend series (filtered)
  const { data: monthlyResult } = useIPC(
    () => ipc.transactions.pivotAggregation(['year', 'month'], 'spend_amount', filter),
    [filterKey]
  )

  const l1Data = useMemo(() => {
    if (!l1Result) return []
    return l1Result.rows
      .map(row => ({ name: row.dimensions[0] || 'Unclassified', value: row.amount }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
  }, [l1Result])

  const supplierData = useMemo(() => {
    if (!supplierResult) return []
    return supplierResult.rows
      .map(row => ({ name: row.dimensions[0] || 'Unknown', total: row.amount }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
  }, [supplierResult])

  const monthlyData = useMemo(() => {
    if (!monthlyResult) return []
    return monthlyResult.rows
      .map(row => {
        const year = row.dimensions[0]
        const month = String(row.dimensions[1] ?? '').padStart(2, '0')
        return { month: `${year}-${month}`, spend: row.amount }
      })
      .filter(d => d.month.length >= 7)
      .sort((a, b) => a.month.localeCompare(b.month))
  }, [monthlyResult])

  return (
    <MetricsTab
      stats={stats}
      l1Data={l1Data}
      supplierData={supplierData}
      monthlyData={monthlyData}
      filter={filter}
    />
  )
}

export default MetricsTabContainer
