import React, { useMemo } from 'react'
import '../../styles/ClassificationSidebar.css'

const ClassificationSidebar = ({
  transactions,
  activeFilters,
  filterState,
  onClose,
  onClearFilters,
  selectedRows = [],
  feedbackSuggestions = [],
  onApproveFeedback,
  onRejectFeedback,
  onEditFeedback,
  highlightFeedback = false,
  onHighlightComplete
}) => {

  const formatCurrencyCompact = (amount) => {
    const n = Number(amount || 0)
    if (!Number.isFinite(n)) return '$0'
    const abs = Math.abs(n)
    const sign = n < 0 ? '-' : ''

    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`
    return `${sign}$${abs.toFixed(0)}`
  }

  // Get all selected suppliers with order tracking - check selectedRows first (from clicking)
  const { selectedSuppliers, supplierOrder } = useMemo(() => {
    // Check selectedRows for supplier_name selections (format: "supplier_name:Supplier Name")
    // The order in selectedRows represents the click order (last clicked is last in array)
    const supplierSelections = selectedRows
      .filter(key => key.startsWith('supplier_name:'))
      .map(key => key.replace('supplier_name:', ''))

    if (supplierSelections.length > 0) {
      // Reverse to get most recent first (last clicked appears first)
      const ordered = [...supplierSelections].reverse()
      return {
        selectedSuppliers: ordered,
        supplierOrder: new Map(ordered.map((s, idx) => [s, idx]))
      }
    }

    // Check activeFilters (from drag-drop)
    let suppliers = []
    if (activeFilters.supplier_name) {
      if (Array.isArray(activeFilters.supplier_name)) {
        suppliers = activeFilters.supplier_name
      } else {
        suppliers = [activeFilters.supplier_name]
      }
    } else if (activeFilters.vendor_name) {
      if (Array.isArray(activeFilters.vendor_name)) {
        suppliers = activeFilters.vendor_name
      } else {
        suppliers = [activeFilters.vendor_name]
      }
    } else if (Array.isArray(filterState.supplier) && filterState.supplier.length > 0) {
      suppliers = filterState.supplier
    }

    return {
      selectedSuppliers: suppliers,
      supplierOrder: new Map(suppliers.map((s, idx) => [s, idx]))
    }
  }, [activeFilters, filterState, selectedRows])

  // Check if we have any selected suppliers
  const hasSelectedSuppliers = selectedSuppliers.length > 0

  // Filter transactions based on active filters - prioritize supplier selection
  const filteredTransactions = useMemo(() => {
    if (!transactions || transactions.length === 0) return []

    // If suppliers are selected, only show those suppliers' transactions
    if (hasSelectedSuppliers) {
      return transactions.filter(row => {
        const rowSupplier = row.supplier_name || row.vendor_name || ''
        return selectedSuppliers.includes(rowSupplier)
      })
    }

    // Otherwise, apply all filters
    return transactions.filter(row => {
      // Apply active filters (from drag-drop)
      const passesActiveFilters = Object.entries(activeFilters).every(([key, value]) => {
        if (!value) return true
        if (Array.isArray(value)) {
          return value.includes(row[key])
        }
        return row[key] === value || (Array.isArray(value) && value.includes(row[key]))
      })
      if (!passesActiveFilters) return false

      // Apply advanced filters (from filter panel) - OR logic within each category
      if (Array.isArray(filterState.supplier) && filterState.supplier.length > 0) {
        if (!filterState.supplier.includes(row.supplier_name)) return false
      }

      if (Array.isArray(filterState.classificationL1) && filterState.classificationL1.length > 0) {
        const path = row.classification_path || ''
        const parts = path.split('|').map(p => p.trim())
        if (!parts[0] || !filterState.classificationL1.some(l1 => parts[0].toLowerCase() === l1.toLowerCase())) return false
      }

      if (Array.isArray(filterState.classificationL2) && filterState.classificationL2.length > 0) {
        const path = row.classification_path || ''
        const parts = path.split('|').map(p => p.trim())
        if (!parts[1] || !filterState.classificationL2.some(l2 => parts[1].toLowerCase() === l2.toLowerCase())) return false
      }

      if (Array.isArray(filterState.classificationL3) && filterState.classificationL3.length > 0) {
        const path = row.classification_path || row.taxonomy_path || ''
        const parts = path.split('|').map(p => p.trim())
        if (!parts[2] || !filterState.classificationL3.some(l3 => parts[2].toLowerCase() === l3.toLowerCase())) return false
      }

      if (Array.isArray(filterState.classificationL4) && filterState.classificationL4.length > 0) {
        const path = row.classification_path || row.taxonomy_path || ''
        const parts = path.split('|').map(p => p.trim())
        if (!parts[3] || !filterState.classificationL4.some(l4 => parts[3].toLowerCase() === l4.toLowerCase())) return false
      }

      if (Array.isArray(filterState.glDescription) && filterState.glDescription.length > 0) {
        if (!filterState.glDescription.includes(row.gl_description)) return false
      }

      if (Array.isArray(filterState.company) && filterState.company.length > 0) {
        if (!filterState.company.includes(row.company)) return false
      }

      if (Array.isArray(filterState.year) && filterState.year.length > 0) {
        if (!filterState.year.includes(row['Accounting Date-Year'])) return false
      }

      if (Array.isArray(filterState.quarter) && filterState.quarter.length > 0) {
        if (!filterState.quarter.includes(row['Accounting Date-Quarter'])) return false
      }

      if (Array.isArray(filterState.month) && filterState.month.length > 0) {
        if (!filterState.month.includes(row['Accounting Date-Month'])) return false
      }

      if (Array.isArray(filterState.costCenter) && filterState.costCenter.length > 0) {
        if (!filterState.costCenter.includes(row['Cost Center Name'])) return false
      }

      if (Array.isArray(filterState.supplierCategory) && filterState.supplierCategory.length > 0) {
        if (!filterState.supplierCategory.includes(row['Supplier Category'])) return false
      }

      if (Array.isArray(filterState.country) && filterState.country.length > 0) {
        if (!filterState.country.includes(row.Country)) return false
      }

      if (Array.isArray(filterState.clientSpendCategory) && filterState.clientSpendCategory.length > 0) {
        if (!filterState.clientSpendCategory.includes(row['Client Spend Category Name'])) return false
      }

      return true
    })
  }, [transactions, activeFilters, filterState, hasSelectedSuppliers, selectedSuppliers])

  // Get classifications grouped by supplier (supplier name + L1-L4 in same row)
  const supplierClassifications = useMemo(() => {
    if (!hasSelectedSuppliers || filteredTransactions.length === 0) return []

    // Group by supplier, then by classification path
    const supplierMap = new Map()

    filteredTransactions.forEach(row => {
      const supplier = row.supplier_name || row.vendor_name || 'Unknown'
      const path = row.classification_path || row.taxonomy_path || ''

      let parts = []
      if (path && path.trim()) {
        parts = path.split('|').map(p => p.trim()).filter(p => p)
      } else {
        // Build from L1-L4 if path doesn't exist
        if (row.L1) parts.push(row.L1)
        if (row.L2) parts.push(row.L2)
        if (row.L3) parts.push(row.L3)
        if (row.L4) parts.push(row.L4)
      }

      if (parts.length === 0) return

      const fullPath = parts.join('|')
      const amount = parseFloat(row.amount || row.invoice_amount || 0) || 0

      if (!supplierMap.has(supplier)) {
        supplierMap.set(supplier, new Map())
      }

      const pathMap = supplierMap.get(supplier)
      if (pathMap.has(fullPath)) {
        pathMap.set(fullPath, pathMap.get(fullPath) + amount)
      } else {
        pathMap.set(fullPath, amount)
      }
    })

    // Convert to array format: [{ supplier, classifications: [{ L1, L2, L3, L4, amount, pathString }] }]
    const result = []
    supplierMap.forEach((pathMap, supplier) => {
      const classifications = Array.from(pathMap.entries())
        .map(([path, amount]) => {
          const parts = path.split('|').map(p => p.trim()).filter(p => p)
          return {
            path,
            L1: parts[0] || '',
            L2: parts[1] || '',
            L3: parts[2] || '',
            L4: parts[3] || '',
            pathString: parts.filter(p => p).join(' → '), // "clinical → clinical supplies → ..."
            amount
          }
        })
        .sort((a, b) => b.amount - a.amount)

      result.push({
        supplier,
        classifications
      })
    })

    // Sort suppliers by selection order (most recent first)
    // The supplierOrder map already has most recent first (index 0 = most recent)
    return result.sort((a, b) => {
      const orderA = supplierOrder.get(a.supplier) ?? Infinity
      const orderB = supplierOrder.get(b.supplier) ?? Infinity
      return orderA - orderB // Lower index (more recent) comes first
    })
  }, [hasSelectedSuppliers, filteredTransactions, supplierOrder])


  // Render supplier classifications with supplier name as header row
  const renderSupplierClassifications = () => {
    if (supplierClassifications.length === 0) return null

    return supplierClassifications.map((supplierData, supplierIdx) => (
      <React.Fragment key={supplierData.supplier}>
        {/* Supplier name header row */}
        <div className="supplier-header-row">
          <div className="supplier-name-header">{supplierData.supplier}</div>
        </div>
        {/* Classification rows for this supplier */}
        {supplierData.classifications.map((item, classIdx) => (
          <div key={`${supplierData.supplier}-${item.path}-${classIdx}`} className="classification-path-row">
            <div className="classification-path-string">
              {item.pathString}
            </div>
            <div className="classification-spend-chip" title={`Total spend: $${Number(item.amount || 0).toLocaleString()}`}>
              {formatCurrencyCompact(item.amount)}
            </div>
          </div>
        ))}
      </React.Fragment>
    ))
  }


  // If no suppliers are selected, don't render the sidebar at all
  if (!hasSelectedSuppliers) {
    return null
  }

  return (
    <div className={`classification-sidebar ${highlightFeedback ? 'highlight-feedback-sidebar' : ''}`}>
      <div className="sidebar-content">
        {supplierClassifications.length > 0 ? (
          <div className="classifications-table">
            <div className="table-body">
              {renderSupplierClassifications()}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default ClassificationSidebar
