import React, { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Filter, TrendingUp } from 'lucide-react'
import '../styles/SpendVisualizations.css'

const SpendVisualizations = ({ transactions, activeFilters, excludeTailSpend, setExcludeTailSpend, onQuickAction }) => {
  const filteredTransactions = useMemo(() => {
    return transactions.filter(row => {
      return Object.entries(activeFilters).every(([key, value]) => {
        if (!value) return true
        return row[key] === value || (Array.isArray(value) && value.includes(row[key]))
      })
    })
  }, [transactions, activeFilters])

  // Top 20 Suppliers by Spend
  const topSuppliersData = useMemo(() => {
    const supplierMap = new Map()
    
    filteredTransactions.forEach(row => {
      const supplier = row.supplier_name || row.vendor_name || 'Unknown'
      const amount = parseFloat(row.amount || row.invoice_amount || 0) || 0
      
      if (supplierMap.has(supplier)) {
        supplierMap.set(supplier, supplierMap.get(supplier) + amount)
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
    const levelMap = { L1: {}, L2: {}, L3: {}, L4: {}, L5: {} }
    
    filteredTransactions.forEach(row => {
      const path = row.classification_path || row.taxonomy_path || ''
      const parts = path.split('|').filter(p => p.trim())
      const amount = parseFloat(row.amount || row.invoice_amount || 0) || 0

      parts.forEach((part, index) => {
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
                formatter={(value) => [`$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, 'Spend']}
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
            {Object.entries(taxonomySpend).map(([level, data]) => {
              const entries = Object.entries(data)
                .map(([name, total]) => ({ name, total }))
                .sort((a, b) => b.total - a.total)
                .slice(0, 10)

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
                              backgroundColor: `hsl(${(idx * 40) % 360}, 70%, 50%)`
                            }}
                          />
                          <span className="taxonomy-bar-value">
                            ${entry.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
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
