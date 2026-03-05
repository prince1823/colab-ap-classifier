import React, { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Filter } from 'lucide-react'
import { fmtAbbrev } from '../../utils/formatSpend'
import { useIPC } from '../../hooks/useIPC'
import { useReviewFilters } from '../../hooks/useReviewFilters'
import { ipc } from '../../lib/ipc'
import type { TransactionFilter } from '../../../shared/types/transactions'
import '../../styles/SpendVisualizations.css'

interface SpendVisualizationsProps {
  excludeTailSpend: boolean
  setExcludeTailSpend: (val: boolean) => void
  onQuickAction?: (action: string, data: Record<string, string>) => void
}

const SpendVisualizations: React.FC<SpendVisualizationsProps> = ({ excludeTailSpend, setExcludeTailSpend, onQuickAction }) => {
  const { toFilterConditions } = useReviewFilters()
  const filterConditions = toFilterConditions()
  const filterKey = useMemo(() => JSON.stringify(filterConditions), [filterConditions])
  const filter: TransactionFilter | undefined = filterConditions.length > 0 ? { conditions: filterConditions } : undefined

  // Top suppliers by spend (server-side)
  const { data: supplierResult } = useIPC(
    () => ipc.transactions.pivotAggregation(['supplier_name'], 'spend_amount', filter),
    [filterKey]
  )

  // L1-L4 taxonomy spend (server-side)
  const { data: l1Result } = useIPC(
    () => ipc.transactions.pivotAggregation(['classification_l1'], 'spend_amount', filter),
    [filterKey]
  )
  const { data: l2Result } = useIPC(
    () => ipc.transactions.pivotAggregation(['classification_l2'], 'spend_amount', filter),
    [filterKey]
  )
  const { data: l3Result } = useIPC(
    () => ipc.transactions.pivotAggregation(['classification_l3'], 'spend_amount', filter),
    [filterKey]
  )

  const topSuppliersData = useMemo(() => {
    if (!supplierResult) return []
    const rows = supplierResult.rows
      .map(row => ({ name: row.dimensions[0] || 'Unknown', total: row.amount }))
      .sort((a, b) => b.total - a.total)
    return excludeTailSpend && rows.length > 20 ? rows.slice(0, 20) : rows
  }, [supplierResult, excludeTailSpend])

  const taxonomySpend = useMemo(() => {
    const toEntries = (result: typeof l1Result, level: string) => {
      if (!result) return []
      return result.rows
        .map(row => ({ name: row.dimensions[0] || 'Unclassified', total: row.amount }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map(e => ({ ...e, level }))
    }
    return [
      ...toEntries(l1Result, 'L1'),
      ...toEntries(l2Result, 'L2'),
      ...toEntries(l3Result, 'L3'),
    ]
  }, [l1Result, l2Result, l3Result])

  const taxonomyByLevel = useMemo(() => {
    const grouped: Record<string, { name: string; total: number }[]> = {}
    for (const entry of taxonomySpend) {
      if (!grouped[entry.level]) grouped[entry.level] = []
      grouped[entry.level].push({ name: entry.name, total: entry.total })
    }
    return grouped
  }, [taxonomySpend])

  return (
    <div className="spend-visualizations">
      <div className="section-header">
        <h3>Spend Visualizations</h3>
        <label className="toggle-switch">
          <input type="checkbox" checked={excludeTailSpend} onChange={(e) => setExcludeTailSpend(e.target.checked)} />
          <span>Exclude Tail Spend</span>
        </label>
      </div>

      <div className="charts-grid">
        <div className="chart-container">
          <div className="chart-header">
            <h4 className="chart-subtitle">Top {excludeTailSpend ? '20' : ''} Suppliers by Spend</h4>
            {onQuickAction && topSuppliersData.length > 0 && (
              <button
                className="quick-action-btn"
                onClick={() => onQuickAction('filter', { supplier_name: topSuppliersData[0].name })}
                title={`Filter by top supplier: ${topSuppliersData[0].name}`}
              >
                <Filter size={14} />
                <span>View Top Supplier</span>
              </button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={topSuppliersData} layout="vertical" margin={{ top: 5, right: 30, left: 150, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tickFormatter={(value) => `$${value.toLocaleString()}`} />
              <YAxis dataKey="name" type="category" width={140} tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(value: number | string) => [fmtAbbrev(Number(value)), 'Spend']}
                contentStyle={{ cursor: onQuickAction ? 'pointer' : 'default' }}
              />
              <Bar
                dataKey="total"
                radius={[0, 8, 8, 0]}
                fill="#3b82f6"
                onClick={(data) => { if (onQuickAction && data) onQuickAction('filter', { supplier_name: data.name }) }}
                style={{ cursor: onQuickAction ? 'pointer' : 'default' }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container">
          <h4 className="chart-subtitle">Taxonomy Level Distribution</h4>
          <div className="taxonomy-breakdown">
            {Object.entries(taxonomyByLevel).map(([level, entries]) => {
              if (entries.length === 0) return null
              const maxTotal = Math.max(...entries.map(e => e.total))
              return (
                <div key={level} className="taxonomy-level">
                  <h5>{level}</h5>
                  <div className="taxonomy-bars">
                    {entries.map((entry, idx) => (
                      <div key={idx} className="taxonomy-bar-item">
                        <div className="taxonomy-bar-label">{entry.name}</div>
                        <div className="taxonomy-bar-container">
                          <div
                            className="taxonomy-bar"
                            style={{
                              width: `${(entry.total / maxTotal) * 100}%`,
                              backgroundColor: `hsl(${(idx * 40) % 360}, 70%, 50%)`,
                            }}
                          />
                          <span className="taxonomy-bar-value">{fmtAbbrev(entry.total)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SpendVisualizations
