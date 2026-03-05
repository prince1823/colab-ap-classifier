import React, { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Filter, TrendingUp } from 'lucide-react'
import { fmtAbbrev } from '../../utils/formatSpend'
import '../styles/SpendVisualizations.css'

interface TransactionRow {
  [key: string]: unknown
  supplier_name?: string
  vendor_name?: string
  amount?: number | string
  invoice_amount?: number | string
  classification_path?: string
  taxonomy_path?: string
}

interface SpendVisualizationsProps {
  transactions: TransactionRow[]
  activeFilters: Record<string, unknown>
  excludeTailSpend: boolean
  setExcludeTailSpend: (val: boolean) => void
  onQuickAction?: (action: string, data: Record<string, string>) => void
}

const SpendVisualizations: React.FC<SpendVisualizationsProps> = ({ transactions, activeFilters, excludeTailSpend, setExcludeTailSpend, onQuickAction }) => {
  const filteredTransactions = useMemo(() => {
    return transactions.filter((row: TransactionRow) => {
      return Object.entries(activeFilters).every(([key, value]: [string, unknown]) => {
        if (!value) return true
        return row[key] === value || (Array.isArray(value) && value.includes(row[key] as string))
      })
    })
  }, [transactions, activeFilters])

  // Top 20 Suppliers by Spend
  const topSuppliersData = useMemo(() => {
    const supplierMap = new Map<string, number>()

    filteredTransactions.forEach((row: TransactionRow) => {
      const supplier = row.supplier_name || row.vendor_name || 'Unknown'
      const amount = parseFloat(String(row.amount || row.invoice_amount || 0)) || 0

      if (supplierMap.has(supplier)) {
        supplierMap.set(supplier, supplierMap.get(supplier)! + amount)
      } else {
        supplierMap.set(supplier, amount)
      }
    })

    const sorted = Array.from(supplierMap.entries())
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)

    // Apply tail spend exclusion if enabled
    if (excludeTailSpend && sorted.length > 20) {
      return sorted.slice(0, 20)
    }

    return sorted
  }, [filteredTransactions, excludeTailSpend])

  // Taxonomy Level Spend (L1-L5)
  const taxonomySpend = useMemo(() => {
    const levelMap: Record<string, Record<string, number>> = { L1: {}, L2: {}, L3: {}, L4: {}, L5: {} }

    filteredTransactions.forEach((row: TransactionRow) => {
      const path = row.classification_path || row.taxonomy_path || ''
      const parts = path.split('|').filter((p: string) => p.trim())
      const amount = parseFloat(String(row.amount || row.invoice_amount || 0)) || 0

      parts.forEach((part: string, index: number) => {
        const level = `L${index + 1}`
        if (levelMap[level]) {
          const key = part.trim()
          levelMap[level][key] = (levelMap[level][key] || 0) + amount
        }
      })
    })

    return levelMap
  }, [filteredTransactions])

  return (
    <div className="spend-visualizations">
      <div className="section-header">
        <h3>Spend Visualizations</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={excludeTailSpend}
            onChange={(e) => setExcludeTailSpend(e.target.checked)}
          />
          <span>Exclude Tail Spend</span>
        </label>
      </div>

      <div className="charts-grid">
        <div className="chart-container">
          <div className="chart-header">
            <h4 className="chart-subtitle">Top 20 Suppliers by Spend</h4>
            {onQuickAction && topSuppliersData.length > 0 && (
              <button
                className="quick-action-btn"
                onClick={() => {
                  const supplier = topSuppliersData[0].name
                  onQuickAction('filter', { supplier_name: supplier })
                }}
                title={`Filter by top supplier: ${topSuppliersData[0].name}`}
              >
                <Filter size={14} />
                <span>View Top Supplier</span>
              </button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart
              data={topSuppliersData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 150, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tickFormatter={(value) => `$${value.toLocaleString()}`} />
              <YAxis
                dataKey="name"
                type="category"
                width={140}
                tick={{ fontSize: 12 }}
              />
              <Tooltip
                formatter={(value: number | string) => [fmtAbbrev(Number(value)), 'Spend']}
                contentStyle={{ cursor: onQuickAction ? 'pointer' : 'default' }}
              />
              <Bar 
                dataKey="total" 
                radius={[0, 8, 8, 0]} 
                fill="#3b82f6"
                onClick={(data) => {
                  if (onQuickAction && data) {
                    onQuickAction('filter', { supplier_name: data.name })
                  }
                }}
                style={{ cursor: onQuickAction ? 'pointer' : 'default' }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container">
          <h4 className="chart-subtitle">Taxonomy Level Distribution</h4>
          <div className="taxonomy-breakdown">
            {Object.entries(taxonomySpend).map(([level, data]: [string, Record<string, number>]) => {
              const entries = Object.entries(data)
                .map(([name, total]: [string, number]) => ({ name, total }))
                .sort((a, b) => b.total - a.total)
                .slice(0, 10)

              if (entries.length === 0) return null

              const maxTotal = Math.max(...entries.map((e: { name: string; total: number }) => e.total))

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
                              backgroundColor: `hsl(${(idx * 40) % 360}, 70%, 50%)`
                            }}
                          />
                          <span className="taxonomy-bar-value">
                            {fmtAbbrev(entry.total)}
                          </span>
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
