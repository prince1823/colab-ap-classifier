import React, { useMemo, useState, useEffect } from 'react'
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area, LabelList
} from 'recharts'
import { Sparkles, TrendingUp, TrendingDown, AlertCircle, PieChart as PieIcon, BarChart3 } from 'lucide-react'
import { fmtAbbrev } from '../../utils/formatSpend'
import { useIPC } from '../../hooks/useIPC'
import { ipc } from '../../lib/ipc'
import type { TransactionStats, TransactionFilter } from '../../../shared/types/transactions'
import '../../styles/MetricsTab.css'

interface MetricsTabProps {
  stats: TransactionStats | null
  l1Data: { name: string; value: number }[]
  supplierData: { name: string; total: number }[]
  monthlyData: { month: string; spend: number }[]
  filter?: TransactionFilter
}

const formatCurrency = (amount: number | string) => fmtAbbrev(Number(amount) || 0)
const formatCurrencyShort = (amount: number | string) => fmtAbbrev(Number(amount))
const formatNumber = (num: number) => new Intl.NumberFormat('en-US').format(num || 0)

const DIMENSION_TO_COLUMN: Record<string, string> = {
  company: 'company',
  cost_center: 'cost_center',
  gl: 'gl_description',
  gl_account_desc: 'gl_description',
  invoice_desc: 'line_description',
  country: 'country',
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

const MetricsTab: React.FC<MetricsTabProps> = ({
  stats,
  l1Data,
  supplierData,
  monthlyData,
  filter,
}) => {
  const [particularDimension, setParticularDimension] = useState('company')
  const [animateIn, setAnimateIn] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setAnimateIn(true), 40)
    return () => clearTimeout(timer)
  }, [])

  // Fetch particular-dimension data via IPC (MetricsTab owns this since it owns the dimension state)
  const filterKey = useMemo(() => JSON.stringify(filter), [filter])
  const particularColumn = DIMENSION_TO_COLUMN[particularDimension] ?? 'company'
  const { data: particularResult } = useIPC(
    () => ipc.transactions.pivotAggregation([particularColumn], 'spend_amount', filter),
    [filterKey, particularColumn]
  )

  const particularData = useMemo(() => {
    if (!particularResult) return []
    return particularResult.rows
      .map(row => ({ name: row.dimensions[0] || 'Unknown', value: row.amount }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [particularResult])

  const totals = useMemo(() => {
    if (!stats) return { totalSpend: 0, totalRows: 0, totalSuppliers: 0, lowConf: 0, dataQualityScore: 100 }
    const { totalSpend, totalRows, uniqueSuppliers, unclassifiedRows } = stats
    return {
      totalSpend,
      totalRows,
      totalSuppliers: uniqueSuppliers,
      lowConf: unclassifiedRows,
      dataQualityScore: totalRows > 0 ? Math.round(((totalRows - unclassifiedRows) / totalRows) * 100) : 100,
    }
  }, [stats])

  const insights = useMemo(() => {
    const result: Array<{ type: string; text: string }> = []

    // Month-over-month trend
    if (monthlyData.length >= 2) {
      const last = monthlyData[monthlyData.length - 1]
      const prev = monthlyData[monthlyData.length - 2]
      const delta = last.spend - prev.spend
      const pct = prev.spend > 0 ? delta / prev.spend : 0
      result.push({
        type: delta >= 0 ? 'up' : 'down',
        text: `Overall spend ${delta >= 0 ? 'increased' : 'decreased'} ${formatCurrency(Math.abs(delta))} (${(Math.abs(pct) * 100).toFixed(1)}%) compared to ${prev.month}.`,
      })
    } else {
      result.push({
        type: 'info',
        text: 'Not enough time-series data for month-over-month trends. Add invoice_date to enable richer time insights.',
      })
    }

    // Low-confidence overview
    const lowConfRate = totals.totalRows > 0 ? totals.lowConf / totals.totalRows : 0
    result.push({
      type: 'info',
      text: `Low-confidence rate is ${(lowConfRate * 100).toFixed(1)}% (${formatNumber(totals.lowConf)} of ${formatNumber(totals.totalRows)} rows). Focus review on high-spend suppliers and categories.`,
    })

    // Top L1 categories
    const totalSpend = totals.totalSpend || 0
    l1Data.slice(0, 3).forEach((entry, idx) => {
      if (result.length >= 15) return
      const pct = totalSpend > 0 ? (entry.value / totalSpend) * 100 : 0
      result.push({
        type: 'info',
        text: `L1 #${idx + 1} "${entry.name}" represents ${formatCurrency(entry.value)} (${pct.toFixed(1)}% of spend). Confirm category rules are aligned with current transactions.`,
      })
    })

    // Top suppliers by spend
    supplierData.slice(0, 3).forEach((entry, idx) => {
      if (result.length >= 15) return
      const pct = totalSpend > 0 ? (entry.total / totalSpend) * 100 : 0
      result.push({
        type: 'up',
        text: `Supplier #${idx + 1} "${entry.name}" accounts for ${formatCurrency(entry.total)} (${pct.toFixed(1)}% of spend). Consider dedicated rules if reclassification is frequent.`,
      })
    })

    while (result.length < 15 && result.length > 0) {
      result.push({
        type: 'info',
        text: 'Use high-spend, low-confidence Supplier × L1–L4 combinations to prioritize reclassification. Correcting a few large suppliers often cleans the majority of downstream reports.',
      })
    }

    return result
  }, [monthlyData, totals, l1Data, supplierData])

  return (
    <div className={`metrics-tab ${animateIn ? 'metrics-tab-animate' : ''}`}>
      <div className="metrics-header-bar">
        <div className="header-metric-item">
          <span className="header-metric-label">Total Spend:</span>
          <span className="header-metric-value">{formatCurrency(totals.totalSpend)}</span>
        </div>
        <div className="header-metric-divider" />
        <div className="header-metric-item">
          <span className="header-metric-label">Total Volume:</span>
          <span className="header-metric-value">{formatNumber(totals.totalRows)} rows</span>
        </div>
        <div className="header-metric-divider" />
        <div className="header-metric-item">
          <span className="header-metric-label">Suppliers:</span>
          <span className="header-metric-value">{formatNumber(totals.totalSuppliers)}</span>
        </div>
        <div className="header-metric-divider" />
        <div className="header-metric-item">
          <span className="header-metric-label">Data Quality:</span>
          <span className="header-metric-value">{totals.dataQualityScore}%</span>
        </div>
        <div className="header-metric-divider" />
        <div className="header-metric-item">
          <span className="header-metric-label">Low Confidence:</span>
          <span className="header-metric-value" style={{ color: totals.lowConf > 0 ? '#f59e0b' : '#10b981' }}>
            {formatNumber(totals.lowConf)} rows
          </span>
        </div>
      </div>

      <div className="metrics-grid">
        {/* Monthly spend trend */}
        <div className="metrics-card metrics-card-1 main-chart">
          <div className="metrics-card-header">
            <div>
              <div className="metrics-card-title">Overall Spend</div>
              <div className="metrics-card-subtitle">Monthly expenditure trend</div>
            </div>
            <div className="chart-type-badge">Trend</div>
          </div>
          <div className="metrics-card-body" style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: Math.max(monthlyData.length * 80, 400) }}>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={monthlyData}>
                  <defs>
                    <linearGradient id="colorSpend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => fmtAbbrev(Number(v))} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                    formatter={(v: number | string) => [formatCurrency(v), 'Spend']}
                  />
                  <Area
                    type="monotone"
                    dataKey="spend"
                    stroke="#f97316"
                    strokeWidth={3}
                    fillOpacity={1}
                    fill="url(#colorSpend)"
                    isAnimationActive
                    animationDuration={1000}
                  >
                    <LabelList dataKey="spend" position="top" formatter={formatCurrencyShort} style={{ fontSize: '10px', fill: 'var(--text-secondary)', fontWeight: '600' }} />
                  </Area>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Top Suppliers */}
        <div className="metrics-card metrics-card-2">
          <div className="metrics-card-header">
            <div>
              <div className="metrics-card-title">Top Suppliers</div>
              <div className="metrics-card-subtitle">By spend</div>
            </div>
            <BarChart3 size={18} className="text-secondary" />
          </div>
          <div className="metrics-card-body">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={supplierData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border-color)" />
                <XAxis type="number" hide />
                <YAxis
                  dataKey="name"
                  type="category"
                  width={140}
                  tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(t) => String(t).length > 20 ? String(t).substring(0, 18) + '...' : t}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                  formatter={(v: number | string) => [formatCurrency(v), 'Spend']}
                />
                <Bar
                  dataKey="total"
                  fill="#3b82f6"
                  radius={[0, 4, 4, 0]}
                  barSize={18}
                  isAnimationActive
                >
                  <LabelList dataKey="total" position="right" formatter={formatCurrencyShort} style={{ fontSize: '10px', fill: 'var(--text-secondary)', fontWeight: '600' }} offset={10} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Spend by L1 Category (Pie) */}
        <div className="metrics-card metrics-card-pie">
          <div className="metrics-card-header">
            <div>
              <div className="metrics-card-title">Spend by Category</div>
              <div className="metrics-card-subtitle">Top 5 L1 distribution</div>
            </div>
            <PieIcon size={18} className="text-secondary" />
          </div>
          <div className="metrics-card-body pie-container">
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={l1Data}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  isAnimationActive
                  label={({ value }: { name: string; value: number }) => formatCurrencyShort(value)}
                >
                  {l1Data.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                  formatter={(v: number | string) => formatCurrency(v)}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pie-legend">
              {l1Data.map((d, i) => (
                <div key={d.name} className="legend-item">
                  <span className="legend-dot" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="legend-name">{d.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Particular Dimension */}
        <div className="metrics-card metrics-card-particular">
          <div className="metrics-card-header">
            <div>
              <div className="metrics-card-title">Particular Viz</div>
              <div className="metrics-card-subtitle">Spend by chosen dimension</div>
            </div>
            <select
              className="dimension-selector"
              value={particularDimension}
              onChange={(e) => setParticularDimension(e.target.value)}
            >
              <option value="company">By Entity</option>
              <option value="cost_center">By Cost Center</option>
              <option value="gl">By GL Description</option>
              <option value="gl_account_desc">By GL Account Description</option>
              <option value="invoice_desc">By Invoice Line Item Description</option>
              <option value="country">By Country</option>
            </select>
          </div>
          <div className="metrics-card-body">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={particularData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <XAxis type="number" hide />
                <YAxis
                  dataKey="name"
                  type="category"
                  width={140}
                  tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(t) => String(t).length > 20 ? String(t).substring(0, 18) + '...' : t}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                  formatter={(v: number | string) => [formatCurrency(v), 'Spend']}
                />
                <Bar
                  dataKey="value"
                  fill="#8b5cf6"
                  radius={[0, 4, 4, 0]}
                  barSize={18}
                  isAnimationActive
                >
                  <LabelList dataKey="value" position="right" formatter={formatCurrencyShort} style={{ fontSize: '10px', fill: 'var(--text-secondary)', fontWeight: '600' }} offset={10} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* AI Insights */}
      <div className="metrics-insights">
        <div className="insights-header">
          <Sparkles size={16} />
          <span>AI Insights</span>
        </div>
        <div className="insights-list">
          {insights.map((insight, idx) => (
            <div key={idx} className={`insight-item insight-${insight.type}`}>
              {insight.type === 'up' && <TrendingUp size={14} className="insight-icon" />}
              {insight.type === 'down' && <TrendingDown size={14} className="insight-icon" />}
              {insight.type === 'info' && <AlertCircle size={14} className="insight-icon" />}
              <span>{insight.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="metrics-footer-note">
        Analyzed <strong>{formatNumber(totals.totalRows)}</strong> records representing <strong>{formatCurrency(totals.totalSpend)}</strong> in total spend volume.
      </div>
    </div>
  )
}

export default MetricsTab
