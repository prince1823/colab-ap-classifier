import React, { useMemo, useState, useEffect, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area, LabelList
} from 'recharts'
import { Sparkles, TrendingUp, TrendingDown, AlertCircle, CheckCircle2, PieChart as PieIcon, BarChart3 } from 'lucide-react'
import '../../styles/MetricsTab.css'

const formatCurrency = (amount) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount || 0)

const formatCurrencyShort = (amount) => {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`
  return `$${Math.round(amount)}`
}

const formatNumber = (num) => new Intl.NumberFormat('en-US').format(num || 0)

function getMonthKey(row) {
  const year =
    row['Accounting Date-Year'] ??
    row.accounting_year ??
    row.year ??
    row.Year ??
    null
  const month =
    row['Accounting Date-Month'] ??
    row.accounting_month ??
    row.month ??
    row.Month ??
    null

  if (year && month) {
    const m = String(month).padStart(2, '0')
    return `${year}-${m}`
  }

  const dateStr = row['Accounting Date'] || row.accounting_date || row.date || row.Date || null
  if (dateStr) {
    const d = new Date(dateStr)
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      return `${y}-${m}`
    }
  }

  return null
}

function getAmount(row) {
  return parseFloat(row.amount || row['Amount USD'] || row.invoice_amount || row['Ledger Debit Amount'] || 0) || 0
}

function getSupplier(row) {
  return row.supplier_name || row.vendor_name || row.Supplier || 'Unknown'
}

function isLowConfidence(row) {
  const conf = (row.confidence || row.classification_confidence || 'high').toLowerCase()
  return conf === 'low' || conf === 'l'
}

const MetricsTab = ({ transactions, filteredTransactions, onDrillToFilters }) => {
  const [selectedBenchmark, setSelectedBenchmark] = useState('overall') // overall | topSupplier
  const [particularDimension, setParticularDimension] = useState('company') // company | cost_center | gl | gl_account_desc | invoice_desc | country | supplier_category
  const [animateIn, setAnimateIn] = useState(false)

  useEffect(() => {
    // Trigger entrance animations shortly after mount
    const timer = setTimeout(() => setAnimateIn(true), 40)
    return () => clearTimeout(timer)
  }, [])

  const totals = useMemo(() => {
    const totalSpend = filteredTransactions.reduce((sum, r) => sum + getAmount(r), 0)
    const totalRows = filteredTransactions.length
    const suppliers = new Set(filteredTransactions.map(getSupplier))
    const lowConfRows = filteredTransactions.filter(isLowConfidence)
    const lowConf = lowConfRows.length
    const lowConfSpend = lowConfRows.reduce((sum, r) => sum + getAmount(r), 0)

    return {
      totalSpend,
      totalRows,
      totalSuppliers: suppliers.size,
      lowConf,
      lowConfSpend,
      dataQualityScore: totalRows > 0 ? Math.round(((totalRows - lowConf) / totalRows) * 100) : 100
    }
  }, [filteredTransactions])

  const chartData = useMemo(() => {
    const l1Map = new Map()
    const particularMap = new Map()

    const getDimensionKey = (row, dim) => {
      switch (dim) {
        case 'company': return row.company || row.Entity || 'Unknown'
        case 'cost_center': return row['Cost Center Name'] || 'Unknown'
        case 'gl': return row.gl_description || row['GL Description'] || 'Unknown'
        case 'gl_account_desc': return row['GL Account Description'] || row.gl_account_description || row.gl_account_desc || row.gl_description || 'Unknown'
        case 'invoice_desc': return row.invoice_line_item_description || row.InvoiceLineItemDescription || row['Invoice Line Item Description'] || row.invoice_line_description || 'Unknown'
        case 'country': return row.Country || 'Unknown'
        case 'supplier_category': return row['Supplier Category'] || 'Unknown'
        default: return 'Unknown'
      }
    }

    filteredTransactions.forEach(row => {
      // L1 Processing
      const path = row.classification_path || row.taxonomy_path || ''
      const l1 = path.split('|')[0]?.trim() || 'Unclassified'
      const amt = getAmount(row)
      l1Map.set(l1, (l1Map.get(l1) || 0) + amt)

      // Particular Thing Processing
      const pKey = getDimensionKey(row, particularDimension)
      particularMap.set(pKey, (particularMap.get(pKey) || 0) + amt)
    })

    const l1Data = Array.from(l1Map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)

    const particularData = Array.from(particularMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)

    return { l1Data, particularData }
  }, [filteredTransactions, particularDimension])

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

  const topSuppliers = useMemo(() => {
    const map = new Map()
    for (const row of filteredTransactions) {
      const s = getSupplier(row)
      map.set(s, (map.get(s) || 0) + getAmount(row))
    }
    return Array.from(map.entries())
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
  }, [filteredTransactions])

  const topSupplierName = topSuppliers[0]?.name || 'Unknown'

  const monthlySeries = useMemo(() => {
    const byMonth = new Map()
    for (const row of filteredTransactions) {
      const key = getMonthKey(row)
      if (!key) continue
      const amount = getAmount(row)
      const supplier = getSupplier(row)

      if (!byMonth.has(key)) {
        byMonth.set(key, { month: key, spend: 0, lowConf: 0, topSupplierSpend: 0 })
      }
      const obj = byMonth.get(key)
      obj.spend += amount
      if (isLowConfidence(row)) obj.lowConf += 1
      if (supplier === topSupplierName) obj.topSupplierSpend += amount
    }

    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
  }, [filteredTransactions, topSupplierName])

  const supplierGainersDecliners = useMemo(() => {
    // Simple “gainers/decliners” heuristic: compare last 3 months vs previous 3 months
    const months = monthlySeries.map(d => d.month)
    const lastMonths = months.slice(-3)
    const prevMonths = months.slice(-6, -3)
    const lastSet = new Set(lastMonths)
    const prevSet = new Set(prevMonths)

    const spendBySupplierLast = new Map()
    const spendBySupplierPrev = new Map()

    for (const row of filteredTransactions) {
      const m = getMonthKey(row)
      if (!m) continue
      const supplier = getSupplier(row)
      const amount = getAmount(row)

      if (lastSet.has(m)) spendBySupplierLast.set(supplier, (spendBySupplierLast.get(supplier) || 0) + amount)
      if (prevSet.has(m)) spendBySupplierPrev.set(supplier, (spendBySupplierPrev.get(supplier) || 0) + amount)
    }

    const allSuppliers = new Set([...spendBySupplierLast.keys(), ...spendBySupplierPrev.keys()])
    const deltas = Array.from(allSuppliers).map((s) => {
      const last = spendBySupplierLast.get(s) || 0
      const prev = spendBySupplierPrev.get(s) || 0
      const delta = last - prev
      const pct = prev > 0 ? (delta / prev) : (last > 0 ? 1 : 0)
      return { name: s, last, prev, delta, pct }
    })

    const gainers = deltas
      .filter(d => d.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 8)

    const decliners = deltas
      .filter(d => d.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 8)

    return { gainers, decliners, windowOk: lastMonths.length === 3 && prevMonths.length === 3 }
  }, [filteredTransactions, monthlySeries])

  const insights = useMemo(() => {
    const result = []
    const series = monthlySeries

    // 1) Overall month-over-month spend trend
    if (series.length >= 2) {
      const last = series[series.length - 1]
      const prev = series[series.length - 2]
      const delta = last.spend - prev.spend
      const pct = prev.spend > 0 ? (delta / prev.spend) : 0

      result.push({
        type: delta >= 0 ? 'up' : 'down',
        text: `Overall spend ${delta >= 0 ? 'increased' : 'decreased'} ${formatCurrency(Math.abs(delta))} (${(Math.abs(pct) * 100).toFixed(1)}%) compared to ${prev.month}.`,
      })
    } else {
      result.push({
        type: 'info',
        text: 'Not enough time-series data to show month-over-month trends. Add Accounting Date (year/month) to enable richer time insights.',
      })
    }

    // 2) Low confidence overview
    const lowConfRate = totals.totalRows > 0 ? (totals.lowConf / totals.totalRows) : 0
    result.push({
      type: 'info',
      text: `Low-confidence rate is ${(lowConfRate * 100).toFixed(1)}% (${formatNumber(totals.lowConf)} of ${formatNumber(totals.totalRows)} filtered rows). Focus review on high-spend suppliers and categories with low confidence.`,
    })

    // Build spend maps for classification levels and suppliers
    const levelMaps = {
      L1: new Map(),
      L2: new Map(),
      L3: new Map(),
      L4: new Map(),
    }
    const supplierSpend = new Map()
    const lowConfBySupplier = new Map()
    const lowConfByL1 = new Map()

    filteredTransactions.forEach((row) => {
      const amt = getAmount(row)
      const supplier = getSupplier(row)
      const path = row.classification_path || row.taxonomy_path || ''
      const parts = path.split('|').map(p => p.trim()).filter(Boolean)

      parts.forEach((part, idx) => {
        const levelKey = `L${idx + 1}`
        if (levelMaps[levelKey]) {
          levelMaps[levelKey].set(part, (levelMaps[levelKey].get(part) || 0) + amt)
        }
      })

      supplierSpend.set(supplier, (supplierSpend.get(supplier) || 0) + amt)

      if (isLowConfidence(row)) {
        lowConfBySupplier.set(supplier, (lowConfBySupplier.get(supplier) || 0) + amt)
        if (parts[0]) {
          lowConfByL1.set(parts[0], (lowConfByL1.get(parts[0]) || 0) + amt)
        }
      }
    })

    const totalSpend = totals.totalSpend || 0

    const makeTopList = (map) =>
      Array.from(map.entries())
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)

    const topL1 = makeTopList(levelMaps.L1)
    const topL2 = makeTopList(levelMaps.L2)
    const topL3 = makeTopList(levelMaps.L3)
    const topL4 = makeTopList(levelMaps.L4)
    const topSuppliersBySpend = makeTopList(supplierSpend)
    const topLowConfSuppliers = makeTopList(lowConfBySupplier)
    const topLowConfL1 = makeTopList(lowConfByL1)

    const addLevelInsights = (levelLabel, list, typeKey) => {
      list.slice(0, 3).forEach((entry, idx) => {
        if (result.length >= 15) return
        const pct = totalSpend > 0 ? (entry.value / totalSpend) * 100 : 0
        result.push({
          type: typeKey,
          text: `${levelLabel} #${idx + 1} "${entry.name}" represents ${formatCurrency(entry.value)} (${pct.toFixed(1)}% of filtered spend). Confirm this category’s description and rules are aligned with current transactions.`,
        })
      })
    }

    addLevelInsights('L1 category', topL1, 'info')
    addLevelInsights('L2 category', topL2, 'info')
    addLevelInsights('L3 category', topL3, 'info')
    addLevelInsights('L4 category', topL4, 'info')

    // Supplier concentration insights
    topSuppliersBySpend.slice(0, 3).forEach((entry, idx) => {
      if (result.length >= 15) return
      const pct = totalSpend > 0 ? (entry.value / totalSpend) * 100 : 0
      result.push({
        type: 'up',
        text: `Supplier #${idx + 1} by spend "${entry.name}" accounts for ${formatCurrency(entry.value)} (${pct.toFixed(1)}% of filtered spend). Consider dedicated rules or Category A treatment if reclassification is frequent.`,
      })
    })

    // Suppliers with highest low-confidence spend
    topLowConfSuppliers.slice(0, 3).forEach((entry) => {
      if (result.length >= 15) return
      result.push({
        type: 'down',
        text: `Supplier "${entry.name}" has ${formatCurrency(entry.value)} in low-confidence transactions. Review sample rows and tighten classification for this supplier.`,
      })
    })

    // L1 categories with highest low-confidence spend
    topLowConfL1.slice(0, 3).forEach((entry) => {
      if (result.length >= 15) return
      result.push({
        type: 'down',
        text: `L1 category "${entry.name}" carries ${formatCurrency(entry.value)} in low-confidence spend. Validate L2–L4 breakdowns and reclassify misaligned rows.`,
      })
    })

    // Supplier gainer/decliner context
    const topGainer = supplierGainersDecliners.gainers[0]
    const topDecliner = supplierGainersDecliners.decliners[0]

    if (topGainer && result.length < 15) {
      result.push({
        type: 'up',
        text: `Spend with "${topGainer.name}" is rising (+${formatCurrency(topGainer.delta)} over the last 3 months vs prior 3). Ensure the classification path (L1–L4) still reflects the current buying pattern.`,
      })
    }
    if (topDecliner && result.length < 15) {
      result.push({
        type: 'down',
        text: `Spend with "${topDecliner.name}" is declining (${formatCurrency(topDecliner.delta)} over the last 3 months vs prior 3). Check if contracts moved to other suppliers or categories and reclassify any legacy rows.`,
      })
    }

    // Ensure we return at least 15 items when possible by duplicating general guidance
    while (result.length < 15 && result.length > 0) {
      result.push({
        type: 'info',
        text: 'Use high-spend, low-confidence combinations of Supplier × L1–L4 to prioritize reclassification. Correcting a few large suppliers often cleans the majority of downstream reports.',
      })
    }

    return result
  }, [monthlySeries, supplierGainersDecliners, totals, filteredTransactions])

  const benchmarkLabel = selectedBenchmark === 'topSupplier' ? `Top Supplier: ${topSupplierName}` : 'Overall Spend'

  const handleTopSupplierClick = (entry) => {
    if (!onDrillToFilters || !entry) return
    // Drill into tables board filtered by the clicked supplier
    onDrillToFilters({ supplier: [entry.name] })
  }

  const handleL1CategoryClick = (entry) => {
    if (!onDrillToFilters || !entry) return
    // Drill into tables board filtered by the clicked L1 category
    onDrillToFilters({ classificationL1: [entry.name] })
  }

  const handleParticularClick = (entry) => {
    if (!onDrillToFilters || !entry) return
    // Map the current dimension to the appropriate filter key
    let key = null
    switch (particularDimension) {
      case 'company':
        key = 'company'
        break
      case 'cost_center':
        key = 'costCenter'
        break
      case 'gl':
        key = 'glDescription'
        break
      case 'gl_account_desc':
        // Route to GL Description-style filter so user can inspect GLs
        key = 'glDescription'
        break
      case 'invoice_desc':
        // No dedicated invoice description filter yet; skip drill if unsupported
        break
      case 'country':
        key = 'country'
        break
      case 'supplier_category':
        key = 'supplierCategory'
        break
      default:
        break
    }

    if (!key) return
    onDrillToFilters({ [key]: [entry.name] })
  }

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
      </div>

      <div className="metrics-grid">
        <div className="metrics-card metrics-card-1 main-chart">
          <div className="metrics-card-header">
            <div>
              <div className="metrics-card-title">{benchmarkLabel}</div>
              <div className="metrics-card-subtitle">Monthly expenditure trend</div>
            </div>
            <div className="chart-type-badge">Trend</div>
          </div>
          <div className="metrics-card-body">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={monthlySeries}>
                <defs>
                  <linearGradient id="colorSpend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `$${Number(v).toLocaleString()}`} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                  formatter={(v) => [formatCurrency(v), 'Spend']}
                />
                <Area
                  type="monotone"
                  dataKey={selectedBenchmark === 'topSupplier' ? 'topSupplierSpend' : 'spend'}
                  stroke="#f97316"
                  strokeWidth={3}
                  fillOpacity={1}
                  fill="url(#colorSpend)"
                  isAnimationActive={true}
                  animationDuration={1000}
                >
                  <LabelList dataKey={selectedBenchmark === 'topSupplier' ? 'topSupplierSpend' : 'spend'} position="top" formatter={formatCurrencyShort} style={{ fontSize: '10px', fill: 'var(--text-secondary)', fontWeight: '600' }} />
                </Area>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="metrics-card metrics-card-2">
          <div className="metrics-card-header">
            <div>
              <div className="metrics-card-title">Top Suppliers</div>
              <div className="metrics-card-subtitle">By volume</div>
            </div>
            <BarChart3 size={18} className="text-secondary" />
          </div>
          <div className="metrics-card-body">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={topSuppliers} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
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
                  formatter={(v) => [formatCurrency(v), 'Spend']}
                />
                <Bar
                  dataKey="total"
                  fill="#3b82f6"
                  radius={[0, 4, 4, 0]}
                  barSize={18}
                  isAnimationActive={true}
                  onClick={handleTopSupplierClick}
                  style={{ cursor: onDrillToFilters ? 'pointer' : 'default' }}
                >
                  <LabelList dataKey="total" position="right" formatter={formatCurrencyShort} style={{ fontSize: '10px', fill: 'var(--text-secondary)', fontWeight: '600' }} offset={10} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

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
                  data={chartData.l1Data}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  isAnimationActive={true}
                  label={({ name, value }) => formatCurrencyShort(value)}
                  onClick={handleL1CategoryClick}
                  style={{ cursor: onDrillToFilters ? 'pointer' : 'default' }}
                >
                  {chartData.l1Data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                  formatter={(v) => formatCurrency(v)}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pie-legend">
              {chartData.l1Data.map((d, i) => (
                <div key={d.name} className="legend-item">
                  <span className="legend-dot" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="legend-name">{d.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

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
              <option value="supplier_category">By Supplier Category</option>
            </select>
          </div>
          <div className="metrics-card-body">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData.particularData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
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
                  formatter={(v) => [formatCurrency(v), 'Spend']}
                />
                <Bar
                  dataKey="value"
                  fill="#8b5cf6"
                  radius={[0, 4, 4, 0]}
                  barSize={18}
                  isAnimationActive={true}
                  onClick={handleParticularClick}
                  style={{ cursor: onDrillToFilters ? 'pointer' : 'default' }}
                >
                  <LabelList dataKey="value" position="right" formatter={formatCurrencyShort} style={{ fontSize: '10px', fill: 'var(--text-secondary)', fontWeight: '600' }} offset={10} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>

      <div className="metrics-footer-note">
        Analyzed <strong>{formatNumber(filteredTransactions.length)}</strong> records representing <strong>{formatCurrency(totals.totalSpend)}</strong> in total spend volume.
      </div>
    </div>
  )
}

export default MetricsTab

