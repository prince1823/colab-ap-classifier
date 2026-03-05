import React, { useMemo } from 'react'
import MetricsTab from './MetricsTab'
import { useIPC } from '../../hooks/useIPC'
import { useReviewFilters } from '../../hooks/useReviewFilters'
import { useReviewFilterContext } from './ReviewFilterContext'
import { ipc } from '../../lib/ipc'
import type { TransactionFilter } from '../../../shared/types/transactions'

interface MetricsTabContainerProps {
  onClose: () => void
}

const MetricsTabContainer: React.FC<MetricsTabContainerProps> = ({ onClose }) => {
  const { setFilters } = useReviewFilterContext()
  const { toFilterConditions } = useReviewFilters()

  // Stable string key — changes only when active filter state changes
  const filterConditions = toFilterConditions()
  const filterKey = useMemo(() => JSON.stringify(filterConditions), [filterConditions])
  const filter: TransactionFilter | undefined =
    filterConditions.length > 0 ? { conditions: filterConditions } : undefined

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
      .filter(d => d.month.length >= 7) // guard against malformed rows
      .sort((a, b) => a.month.localeCompare(b.month))
  }, [monthlyResult])

  const handleDrillToFilters = (filters: Record<string, string[]>) => {
    setFilters(prev => {
      const next = { ...prev.filterState }
      if (filters.supplier) next.supplier = filters.supplier
      if (filters.classificationL1) next.classificationL1 = filters.classificationL1
      if (filters.glDescription) next.glDescription = filters.glDescription
      if (filters.company) next.company = filters.company
      if (filters.costCenter) next.costCenter = filters.costCenter
      if (filters.country) next.country = filters.country
      return { filterState: next }
    })
    onClose()
  }

  return (
    <MetricsTab
      stats={stats}
      l1Data={l1Data}
      supplierData={supplierData}
      monthlyData={monthlyData}
      onDrillToFilters={handleDrillToFilters}
    />
  )
}

export default MetricsTabContainer
