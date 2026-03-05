import React from 'react'
import { FileText, DollarSign, Building2 } from 'lucide-react'
import { fmtAbbrev } from '../../utils/formatSpend'
import '../styles/TopMetrics.css'

interface MetricsData {
  totalTransactions?: number
  totalSpend?: number
  totalSuppliers?: number
  [key: string]: unknown
}

interface TopMetricsProps {
  metrics: MetricsData
}

const TopMetrics: React.FC<TopMetricsProps> = ({ metrics }) => {
  const formatCurrency = (amount: number) => fmtAbbrev(amount)

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num)
  }

  const metricsData = [
    {
      label: 'Total Transactions',
      value: formatNumber(metrics.totalTransactions || 0),
      icon: FileText,
      color: '#3b82f6',
      bgColor: '#dbeafe',
    },
    {
      label: 'Total Spend',
      value: formatCurrency(metrics.totalSpend || 0),
      icon: DollarSign,
      color: '#10b981',
      bgColor: '#d1fae5',
    },
    {
      label: 'Total Suppliers',
      value: formatNumber(metrics.totalSuppliers || 0),
      icon: Building2,
      color: '#f59e0b',
      bgColor: '#fef3c7',
    },
  ]

  return (
    <div className="top-metrics">
      {metricsData.map((metric, index) => {
        const Icon = metric.icon
        return (
          <div key={index} className="metric-card">
            <div className="metric-icon" style={{ backgroundColor: metric.bgColor, color: metric.color }}>
              <Icon size={24} />
            </div>
            <div className="metric-content">
              <div className="metric-label">{metric.label}</div>
              <div className="metric-value">{metric.value}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default TopMetrics
