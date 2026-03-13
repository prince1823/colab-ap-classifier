import React, { useMemo } from 'react'
import { X, TrendingUp, Users, FileText, DollarSign } from 'lucide-react'
import '../styles/BranchDetailView.css'

interface TransactionRow {
  [key: string]: unknown
  classification_path?: string
  taxonomy_path?: string
  supplier_name?: string
  vendor_name?: string
  amount?: number | string
  invoice_amount?: number | string
  invoice_number?: string
}

interface BranchDetailViewProps {
  path: string | null
  transactions: TransactionRow[]
  onClose: () => void
}

const BranchDetailView: React.FC<BranchDetailViewProps> = ({ path, transactions, onClose }) => {
  // Filter transactions that match this classification path
  const branchTransactions = useMemo(() => {
    if (!path || !transactions || transactions.length === 0) return []
    
    const normalizedPath = path.replace(/^root\|/, '').trim()
    if (!normalizedPath) return []
    
    return transactions.filter(row => {
      const rowPath = (row.classification_path || row.taxonomy_path || '').trim()
      return rowPath === normalizedPath || rowPath.startsWith(normalizedPath + '|')
    })
  }, [path, transactions])

  // Calculate summary stats
  const summary = useMemo(() => {
    if (branchTransactions.length === 0) {
      return {
        totalTransactions: 0,
        totalAmount: 0,
        uniqueSuppliers: 0,
        topSuppliers: []
      }
    }

    const totalAmount = branchTransactions.reduce((sum: number, row: TransactionRow) => {
      return sum + (parseFloat(String(row.amount || row.invoice_amount || 0)) || 0)
    }, 0)

    const supplierMap = new Map<string, { count: number; amount: number }>()
    branchTransactions.forEach((row: TransactionRow) => {
      const supplier = row.supplier_name || row.vendor_name || 'Unknown'
      const amount = parseFloat(String(row.amount || row.invoice_amount || 0)) || 0
      
      if (!supplierMap.has(supplier)) {
        supplierMap.set(supplier, { count: 0, amount: 0 })
      }
      
      const supplierData = supplierMap.get(supplier)!
      supplierData.count++
      supplierData.amount += amount
    })

    const uniqueSuppliers = supplierMap.size
    const topSuppliers = Array.from(supplierMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5) // Top 5 suppliers

    return {
      totalTransactions: branchTransactions.length,
      totalAmount,
      uniqueSuppliers,
      topSuppliers
    }
  }, [branchTransactions])

  // Parse path parts for display
  const pathParts = useMemo(() => {
    if (!path) return []
    const normalizedPath = path.replace(/^root\|/, '').trim()
    return normalizedPath.split('|').filter(p => p.trim())
  }, [path])

  if (!path) return null

  return (
    <div className="branch-detail-view">
      <div className="branch-detail-header">
        <div className="branch-detail-title">
          <h3>Branch Details</h3>
          <div className="branch-path-display">
            {pathParts.map((part, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 && <span className="path-arrow">→</span>}
                <span className="path-part">{part}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
        <button className="close-detail-btn" onClick={onClose} title="Close">
          <X size={18} />
        </button>
      </div>

      <div className="branch-detail-content">
        {/* Summary Stats */}
        <div className="branch-summary-stats">
          <div className="summary-stat">
            <div className="stat-icon">
              <FileText size={16} />
            </div>
            <div className="stat-content">
              <div className="stat-value">{summary.totalTransactions}</div>
              <div className="stat-label">Transactions</div>
            </div>
          </div>
          
          <div className="summary-stat">
            <div className="stat-icon">
              <DollarSign size={16} />
            </div>
            <div className="stat-content">
              <div className="stat-value">
                ${Number(summary.totalAmount).toLocaleString(undefined, { 
                  maximumFractionDigits: 0 
                })}
              </div>
              <div className="stat-label">Total Amount</div>
            </div>
          </div>
          
          <div className="summary-stat">
            <div className="stat-icon">
              <Users size={16} />
            </div>
            <div className="stat-content">
              <div className="stat-value">{summary.uniqueSuppliers}</div>
              <div className="stat-label">Suppliers</div>
            </div>
          </div>
        </div>

        {/* Top Suppliers */}
        {summary.topSuppliers.length > 0 && (
          <div className="branch-top-suppliers">
            <h4 className="section-title">Top Suppliers</h4>
            <div className="suppliers-list">
              {summary.topSuppliers.map((supplier, idx) => (
                <div key={idx} className="supplier-item">
                  <div className="supplier-info">
                    <span className="supplier-name">{supplier.name}</span>
                    <span className="supplier-count">{supplier.count} transactions</span>
                  </div>
                  <div className="supplier-amount">
                    ${Number(supplier.amount).toLocaleString(undefined, { 
                      maximumFractionDigits: 0 
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Transactions (compact view) */}
        {branchTransactions.length > 0 && (
          <div className="branch-transactions">
            <h4 className="section-title">
              Recent Transactions ({branchTransactions.length})
            </h4>
            <div className="transactions-list">
              {branchTransactions.slice(0, 10).map((row, idx) => (
                <div key={idx} className="transaction-item">
                  <div className="transaction-main">
                    <span className="transaction-supplier">
                      {row.supplier_name || row.vendor_name || 'Unknown'}
                    </span>
                    {row.invoice_number && (
                      <span className="transaction-invoice">
                        Invoice: {row.invoice_number}
                      </span>
                    )}
                  </div>
                  <div className="transaction-amount">
                    ${Number(row.amount || row.invoice_amount || 0).toLocaleString(undefined, { 
                      maximumFractionDigits: 0 
                    })}
                  </div>
                </div>
              ))}
              {branchTransactions.length > 10 && (
                <div className="more-transactions">
                  +{branchTransactions.length - 10} more transactions
                </div>
              )}
            </div>
          </div>
        )}

        {branchTransactions.length === 0 && (
          <div className="no-transactions">
            <p>No transactions found in this branch.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default BranchDetailView
