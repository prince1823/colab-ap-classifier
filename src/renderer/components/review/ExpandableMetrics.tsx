import React from 'react'
import { X, FileText, DollarSign, AlertCircle, CheckCircle2 } from 'lucide-react'
import { fmtAbbrev } from '../../utils/formatSpend'
import '../styles/ExpandableMetrics.css'

const ExpandableMetrics = ({ transactions, filteredTransactions, isOpen, onClose }) => {

  const formatCurrency = (amount) => fmtAbbrev(amount)

  const formatNumber = (num) => {
    return new Intl.NumberFormat('en-US').format(num)
  }

  // Helper to check if confidence is low
  const isLowConfidence = (row) => {
    const conf = (row.confidence || row.classification_confidence || 'high').toLowerCase()
    return conf === 'low' || conf === 'l'
  }

  // Helper to check if row has been reviewed (manually reclassified)
  const isReviewed = (row) => {
    return row.override_rule_applied === 'manual_reclassification' || 
           row.reviewed === true || 
           row.review_status === 'reviewed'
  }

  // Calculate metrics from filtered transactions
  const metrics = React.useMemo(() => {
    const totalRows = filteredTransactions.length
    const totalSpend = filteredTransactions.reduce((sum, row) => {
      return sum + (parseFloat(row.amount || row.invoice_amount || 0) || 0)
    }, 0)

    // Low confidence rows
    const lowConfidenceRows = filteredTransactions.filter(isLowConfidence)
    const lowConfPendingReview = lowConfidenceRows.filter(row => !isReviewed(row))
    const lowConfReviewed = lowConfidenceRows.filter(isReviewed)

    // Calculate comparison with all transactions
    const allTotalRows = transactions.length
    const allTotalSpend = transactions.reduce((sum, row) => {
      return sum + (parseFloat(row.amount || row.invoice_amount || 0) || 0)
    }, 0)

    const allLowConfidenceRows = transactions.filter(isLowConfidence)
    const allLowConfPendingReview = allLowConfidenceRows.filter(row => !isReviewed(row))
    const allLowConfReviewed = allLowConfidenceRows.filter(isReviewed)

    const rowPercentage = allTotalRows > 0 
      ? ((totalRows / allTotalRows) * 100).toFixed(1)
      : 0
    
    const spendPercentage = allTotalSpend > 0
      ? ((totalSpend / allTotalSpend) * 100).toFixed(1)
      : 0

    return {
      totalRows,
      totalSpend,
      lowConfPendingReview: lowConfPendingReview.length,
      lowConfReviewed: lowConfReviewed.length,
      rowPercentage,
      spendPercentage,
      allTotalRows,
      allTotalSpend,
      allLowConfPendingReview: allLowConfPendingReview.length,
      allLowConfReviewed: allLowConfReviewed.length
    }
  }, [filteredTransactions, transactions])

  const metricsData = [
    {
      label: 'Total Rows',
      value: formatNumber(metrics.totalRows),
      subtitle: `${metrics.rowPercentage}% of all rows`,
      icon: FileText,
      color: '#3b82f6',
      bgColor: '#dbeafe',
    },
    {
      label: 'Total Spend',
      value: formatCurrency(metrics.totalSpend),
      subtitle: `${metrics.spendPercentage}% of total spend`,
      icon: DollarSign,
      color: '#10b981',
      bgColor: '#d1fae5',
    },
    {
      label: 'Low Confidence - Pending Review',
      value: formatNumber(metrics.lowConfPendingReview),
      subtitle: `${metrics.allLowConfPendingReview} total pending`,
      icon: AlertCircle,
      color: '#f59e0b',
      bgColor: '#fef3c7',
    },
    {
      label: 'Low Confidence - Reviewed',
      value: formatNumber(metrics.lowConfReviewed),
      subtitle: `${metrics.allLowConfReviewed} total reviewed`,
      icon: CheckCircle2,
      color: '#10b981',
      bgColor: '#d1fae5',
    },
  ]

  if (!isOpen) return null

  return (
    <>
      <div 
        className="metrics-modal-backdrop"
        onClick={onClose}
      />
      <div className="metrics-modal">
        <div className="metrics-modal-header">
          <h2>Metrics</h2>
          <button 
            className="metrics-modal-close"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        
        <div className="metrics-modal-content">
          <div className="metrics-summary-bar">
            <span className="metrics-summary-text">
              {formatNumber(metrics.totalRows)} rows • {formatCurrency(metrics.totalSpend)}
              {metrics.lowConfPendingReview > 0 && (
                <span className="metrics-alert">
                  • {formatNumber(metrics.lowConfPendingReview)} pending review
                </span>
              )}
            </span>
          </div>
          
          <div className="metrics-grid">
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
                    <div className="metric-subtitle">{metric.subtitle}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}

export default ExpandableMetrics
