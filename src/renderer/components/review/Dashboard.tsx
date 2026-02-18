import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDragDropManager } from 'react-dnd'
import MultiTableSystem from './MultiTableSystem'
import ClassificationTree from './ClassificationTree'
import ActiveFilters from './ActiveFilters'
import ReclassificationLoader from './ReclassificationLoader'
import SystemFeedbackModal from './SystemFeedbackModal'
import ReclassifyConfirmModal from './ReclassifyConfirmModal'
import { Table, X, ChevronDown, Sparkles, Plus, CheckCircle, BarChart3 } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import MetricsTab from './MetricsTab'
import '../../styles/Dashboard.css'
import '../../styles/Tabs.css'

const Dashboard = ({ transactions, loading, error, datasetId, setDatasetId, foldername, setFoldername, refreshTransactions, setTransactions }) => {
  const [activeTab, setActiveTab] = useState('tables') // 'tables'
  const [activeFilters, setActiveFilters] = useState({})
  const [selectedRows, setSelectedRows] = useState([])
  const [isReclassifying, setIsReclassifying] = useState(false)
  const [reclassificationProgress, setReclassificationProgress] = useState({ current: 0, total: 0 })
  const [hasTableFilters, setHasTableFilters] = useState(false)
  const clearAllTableFiltersRef = useRef(null)

  // System feedback generation
  const [systemFeedbackEnabled, setSystemFeedbackEnabled] = useState(false)
  const [feedbackSuggestions, setFeedbackSuggestions] = useState([])
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)
  const [reclassificationHistory, setReclassificationHistory] = useState(new Map()) // Track row reclassification history
  const [showFeedbackNotification, setShowFeedbackNotification] = useState(false)
  const [newFeedbackCount, setNewFeedbackCount] = useState(0)
  const [highlightFeedback, setHighlightFeedback] = useState(false)
  const [reclassToast, setReclassToast] = useState<{ show: boolean; rowCount: number; targetPath: string }>({ show: false, rowCount: 0, targetPath: '' })
  const reclassToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showDashboardModal, setShowDashboardModal] = useState(false)
  const [pendingReclassification, setPendingReclassification] = useState<{ rows: any[]; targetPath: string } | null>(null)

  // Keyboard navigation state - coordinates between tree and tables
  const [keyboardFocus, setKeyboardFocus] = useState('tree') // 'tree' or 'tables'
  const [tableNav, setTableNav] = useState({ tableIndex: 0, rowIndex: 0 }) // Current table and row position

  // Current classification path for the latest selected supplier (shown in toolbar left)
  const [focusedClassificationPath, setFocusedClassificationPath] = useState(null)

  // Enable page scrolling when dragging
  const dragDropManager = useDragDropManager()

  useEffect(() => {
    const monitor = dragDropManager.getMonitor()
    let isDragging = false

    const handleDragStart = () => {
      if (!isDragging) {
        isDragging = true
        document.body.style.overflow = 'auto'
        document.documentElement.style.overflow = 'auto'
        document.body.classList.add('dragging-active')
        document.documentElement.classList.add('dragging-active')
      }
    }

    const handleDragEnd = () => {
      if (isDragging) {
        isDragging = false
        // Small delay to ensure drag end is complete
        setTimeout(() => {
          document.body.classList.remove('dragging-active')
          document.documentElement.classList.remove('dragging-active')
        }, 100)
      }
    }

    const unsubscribe = monitor.subscribeToStateChange(() => {
      const isCurrentlyDragging = monitor.isDragging()
      if (isCurrentlyDragging && !isDragging) {
        handleDragStart()
      } else if (!isCurrentlyDragging && isDragging) {
        handleDragEnd()
      }
    })

    return () => {
      unsubscribe()
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
      document.body.classList.remove('dragging-active')
      document.documentElement.classList.remove('dragging-active')
    }
  }, [dragDropManager])

  // State for filter and add table
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [showAddTableMenu, setShowAddTableMenu] = useState(false)

  const [expandedFilters, setExpandedFilters] = useState(new Set()) // Track which filters are expanded
  const [filterState, setFilterState] = useState({
    supplier: [],
    classificationL1: [],
    classificationL2: [],
    classificationL3: [],
    classificationL4: [],
    glDescription: [],
    company: [],
    year: [],
    quarter: [],
    month: [],
    costCenter: [],
    supplierCategory: [],
    country: [],
    lineDescription: []
  })
  const [tables, setTables] = useState(() => [
    { id: 'vendor', title: 'supplier_name', column: 'supplier_name', isHierarchical: false, collapsed: false },
    { id: 'commodity', title: 'line_description', column: 'line_description', isHierarchical: false, collapsed: false },
    { id: 'gl', title: 'gl_description', column: 'gl_description', isHierarchical: false, collapsed: false },
    // 4th table: hierarchical taxonomy based on classification_path.
    // Clicking L1 / L2 / L3 here will update the global classification filters
    // so the three tables above automatically reflect the selected taxonomy slice.
    { id: 'taxonomy', title: 'classification_path', column: 'classification_path', isHierarchical: true, collapsed: false }
  ])
  // Per-table local filters - only applied to specific tables via drag-drop
  const [tableLocalFilters, setTableLocalFilters] = useState({})


  const tabs = [
    { id: 'tables', label: 'Review', icon: Table },
  ]

  // Calculate available columns for add table dropdown
  const availableColumns = useMemo(() => {
    if (transactions.length === 0) return []
    const cols = Object.keys(transactions[0])
    return cols.filter(col => {
      const exclude = ['row_index', 'id', '_id']
      return !exclude.includes(col) && !tables.find(t => t.column === col)
    })
  }, [transactions, tables])

  const addTable = (column) => {
    if (!column || !availableColumns.includes(column)) return

    const newTable = {
      id: `table-${Date.now()}`,
      title: column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      column: column,
      isHierarchical: column.includes('classification') || column.includes('path') || column.includes('Level'),
      collapsed: false
    }
    setTables([...tables, newTable])
    setShowAddTableMenu(false)
  }

  // Filter options for filter panel
  const filterOptions = useMemo(() => {
    const suppliers = new Set()
    const classificationsL1 = new Set()
    const classificationsL2 = new Set()
    const classificationsL3 = new Set()
    const classificationsL4 = new Set()
    const glDescriptions = new Set()
    const companies = new Set()
    const years = new Set()
    const quarters = new Set()
    const months = new Set()
    const costCenters = new Set()
    const supplierCategories = new Set()
    const countries = new Set()
    const lineDescriptions = new Set()

    transactions.forEach(row => {
      if (row.supplier_name) suppliers.add(row.supplier_name)
      if (row.classification_path) {
        const parts = row.classification_path.split('|').map(p => p.trim()).filter(p => p)
        if (parts[0]) classificationsL1.add(parts[0])
        if (parts[1]) classificationsL2.add(parts[1])
        if (parts[2]) classificationsL3.add(parts[2])
        if (parts[3]) classificationsL4.add(parts[3])
      }
      if (row.gl_description) glDescriptions.add(row.gl_description)
      if (row.company) companies.add(row.company)
      if (row['Accounting Date-Year']) years.add(row['Accounting Date-Year'])
      if (row['Accounting Date-Quarter']) quarters.add(row['Accounting Date-Quarter'])
      if (row['Accounting Date-Month']) months.add(row['Accounting Date-Month'])
      if (row['Cost Center Name']) costCenters.add(row['Cost Center Name'])
      if (row['Supplier Category']) supplierCategories.add(row['Supplier Category'])
      if (row.Country) countries.add(row.Country)
      if (row.line_description) lineDescriptions.add(row.line_description)
    })

    return {
      suppliers: Array.from(suppliers).sort().slice(0, 50),
      classificationsL1: Array.from(classificationsL1).sort(),
      classificationsL2: Array.from(classificationsL2).sort(),
      classificationsL3: Array.from(classificationsL3).sort(),
      classificationsL4: Array.from(classificationsL4).sort(),
      glDescriptions: Array.from(glDescriptions).sort().slice(0, 50),
      companies: Array.from(companies).sort(),
      years: Array.from(years).sort(),
      quarters: Array.from(quarters).sort(),
      months: Array.from(months).sort(),
      costCenters: Array.from(costCenters).sort().slice(0, 50),
      supplierCategories: Array.from(supplierCategories).sort(),
      countries: Array.from(countries).sort(),
      lineDescriptions: Array.from(lineDescriptions).sort().slice(0, 50)
    }
  }, [transactions])

  // Auto-apply filters when filterState changes (OR logic within each category)
  useEffect(() => {
    const newFilters = {}

    if (Array.isArray(filterState.supplier) && filterState.supplier.length > 0) {
      newFilters.supplier_name = filterState.supplier
    }

    if (Array.isArray(filterState.glDescription) && filterState.glDescription.length > 0) {
      newFilters.gl_description = filterState.glDescription
    }

    if (Array.isArray(filterState.company) && filterState.company.length > 0) {
      newFilters.company = filterState.company
    }

    if (Array.isArray(filterState.year) && filterState.year.length > 0) {
      newFilters.year = filterState.year
    }

    if (Array.isArray(filterState.quarter) && filterState.quarter.length > 0) {
      newFilters.quarter = filterState.quarter
    }

    if (Array.isArray(filterState.month) && filterState.month.length > 0) {
      newFilters.month = filterState.month
    }

    if (Array.isArray(filterState.costCenter) && filterState.costCenter.length > 0) {
      newFilters.costCenter = filterState.costCenter
    }

    if (Array.isArray(filterState.supplierCategory) && filterState.supplierCategory.length > 0) {
      newFilters.supplierCategory = filterState.supplierCategory
    }

    if (Array.isArray(filterState.country) && filterState.country.length > 0) {
      newFilters.country = filterState.country
    }

    if (Array.isArray(filterState.lineDescription) && filterState.lineDescription.length > 0) {
      newFilters.lineDescription = filterState.lineDescription
    }

    // Update filters - this will trigger re-filtering in MultiTableSystem
    setActiveFilters(newFilters)
  }, [
    filterState.supplier,
    filterState.classificationL1,
    filterState.classificationL2,
    filterState.classificationL3,
    filterState.classificationL4,
    filterState.glDescription,
    filterState.company,
    filterState.year,
    filterState.quarter,
    filterState.month,
    filterState.costCenter,
    filterState.supplierCategory,
    filterState.country,
    filterState.lineDescription
  ])

  const clearFilters = useCallback(() => {
    setFilterState({
      supplier: [],
      classificationL1: [],
      classificationL2: [],
      classificationL3: [],
      classificationL4: [],
      glDescription: [],
      company: [],
      year: [],
      quarter: [],
      month: [],
      costCenter: [],
      supplierCategory: [],
      country: [],
      lineDescription: []
    })
    setActiveFilters({})
    setTableLocalFilters({})
    setSelectedRows([])
    setFocusedClassificationPath(null)
    setShowFilterPanel(false)
  }, [setActiveFilters])

  // Remove a single filter (from UI filters or drag/drop activeFilters)
  const removeFilter = useCallback((filterKey, valueToRemove = null) => {
    const clearSelectedForColumn = (columnKey, value) => {
      if (!columnKey) return
      setSelectedRows(prev => {
        // If a specific value is removed, only clear that exact selection
        if (value !== null && value !== undefined) {
          const valueStr = (value || '').toString().trim()
          return prev.filter(k => k !== `${columnKey}:${valueStr}`)
        }
        // Otherwise clear all selections for that column
        return prev.filter(k => !k.startsWith(`${columnKey}:`))
      })
    }

    // Map filter UI keys / backend keys to table column keys used in `selectedRows` (column:value)
    const selectionColumnKeyMap = {
      // UI filterState keys
      supplier: 'supplier_name',
      glDescription: 'gl_description',
      supplierCategory: 'Supplier Category',
      lineDescription: 'line_description',
      country: 'Country',
      company: 'company',
      costCenter: 'Cost Center Name',
      year: 'Accounting Date-Year',
      quarter: 'Accounting Date-Quarter',
      month: 'Accounting Date-Month',
      // backend activeFilters keys (often same as column keys)
      supplier_name: 'supplier_name',
      gl_description: 'gl_description',
      company: 'company',
      country: 'Country',
    }

    // Keys managed by filterState (UI filter panel)
    const uiKeys = new Set([
      'supplier',
      'classificationL1',
      'classificationL2',
      'classificationL3',
      'classificationL4',
      'glDescription',
      'company',
      'year',
      'quarter',
      'month',
      'costCenter',
      'supplierCategory',
      'country',
      'lineDescription',
    ])

    if (uiKeys.has(filterKey)) {
      // Remove from filterState array
      if (valueToRemove !== null && valueToRemove !== undefined) {
        setFilterState(prev => ({
          ...prev,
          [filterKey]: Array.isArray(prev[filterKey])
            ? prev[filterKey].filter(v => v !== valueToRemove)
            : []
        }))
      } else {
        // Clear entire filter
        setFilterState(prev => ({
          ...prev,
          [filterKey]: []
        }))
      }

      // Clear selection only for the related table column (not all)
      clearSelectedForColumn(selectionColumnKeyMap[filterKey], valueToRemove)
    } else {
      // Otherwise treat as backend/activeFilters key (e.g. supplier_name, gl_description)
      setActiveFilters(prev => {
        const next = { ...prev }
        if (valueToRemove !== null && Array.isArray(next[filterKey])) {
          // Remove matching value (handle string comparison with trimming)
          const valueToRemoveStr = (valueToRemove || '').toString().trim()
          next[filterKey] = next[filterKey].filter(v => {
            const vStr = (v || '').toString().trim()
            return vStr !== valueToRemoveStr
          })
          if (next[filterKey].length === 0) {
            delete next[filterKey]
          }
        } else if (valueToRemove !== null && next[filterKey]) {
          // Single value filter - remove if it matches
          const currentValue = (next[filterKey] || '').toString().trim()
          const valueToRemoveStr = (valueToRemove || '').toString().trim()
          if (currentValue === valueToRemoveStr) {
            delete next[filterKey]
          }
        } else {
          // Clear entire filter
          delete next[filterKey]
        }
        return next
      })

      // Clear selection only for the related table column (not all)
      clearSelectedForColumn(selectionColumnKeyMap[filterKey] || filterKey, valueToRemove)
    }
  }, [setActiveFilters])

  // Helper function to handle toggle selection for multiple select
  const handleToggleFilter = useCallback((filterKey, value) => {
    setFilterState(prev => {
      const currentArray = Array.isArray(prev[filterKey]) ? prev[filterKey] : []
      if (currentArray.includes(value)) {
        return { ...prev, [filterKey]: currentArray.filter(v => v !== value) }
      } else {
        return { ...prev, [filterKey]: [...currentArray, value] }
      }
    })
  }, [])

  // Filter panel content component (only created when showFilterPanel is true)
  const filterPanelContent = showFilterPanel ? (
    <>
      <div className="dropdown-backdrop" onClick={() => setShowFilterPanel(false)} />
      <div className="filter-panel">
        <div className="filter-panel-header">
          <h4>Advanced Filters</h4>
          <button className="close-filter-btn" onClick={() => setShowFilterPanel(false)}>
            <X size={16} />
          </button>
        </div>
        <div className="filter-panel-content">
          {/* Helper function to render collapsible dropdown filter */}
          {(() => {
            const toggleFilterExpand = (filterKey) => {
              setExpandedFilters(prev => {
                const newSet = new Set(prev)
                if (newSet.has(filterKey)) {
                  newSet.delete(filterKey)
                } else {
                  newSet.add(filterKey)
                }
                return newSet
              })
            }

            const renderDropdownFilter = (filterKey, label, options) => {
              const currentSelected = Array.isArray(filterState[filterKey]) ? filterState[filterKey] : []
              const isExpanded = expandedFilters.has(filterKey)
              const displayLabel = label // e.g., "Supplier", "Classification L1"

              return (
                <div className="filter-dropdown-group">
                  <div
                    className="filter-dropdown-header"
                    onClick={() => toggleFilterExpand(filterKey)}
                  >
                    <span className="filter-dropdown-label">{displayLabel}</span>
                    <ChevronDown
                      size={16}
                      className={`filter-chevron ${isExpanded ? 'expanded' : ''}`}
                    />
                  </div>
                  {isExpanded && (
                    <div className="filter-select-multiple-wrapper">
                      {options.slice(0, 50).map(option => {
                        const isSelected = currentSelected.includes(option)
                        return (
                          <div
                            key={option}
                            className={`filter-option ${isSelected ? 'selected' : ''}`}
                            onClick={() => handleToggleFilter(filterKey, option)}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleFilter(filterKey, option)}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <span>{option}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {currentSelected.length > 0 && (
                    <div className="selected-count">{currentSelected.length} selected</div>
                  )}
                </div>
              )
            }

            return (
              <>
                {renderDropdownFilter('supplier', 'Supplier', filterOptions.suppliers)}
                {renderDropdownFilter('classificationL1', 'Classification L1', filterOptions.classificationsL1)}
                {renderDropdownFilter('classificationL2', 'Classification L2', filterOptions.classificationsL2)}
                {renderDropdownFilter('classificationL3', 'Classification L3', filterOptions.classificationsL3)}
                {renderDropdownFilter('classificationL4', 'Classification L4', filterOptions.classificationsL4)}
                {renderDropdownFilter('glDescription', 'GL Description', filterOptions.glDescriptions)}
                {renderDropdownFilter('company', 'Company', filterOptions.companies)}
                {renderDropdownFilter('year', 'Year', filterOptions.years)}
                {renderDropdownFilter('quarter', 'Quarter', filterOptions.quarters)}
                {renderDropdownFilter('month', 'Month', filterOptions.months)}
                {renderDropdownFilter('costCenter', 'Cost Center', filterOptions.costCenters)}
                {renderDropdownFilter('supplierCategory', 'Supplier Category', filterOptions.supplierCategories)}
                {renderDropdownFilter('country', 'Country', filterOptions.countries)}
                {renderDropdownFilter('lineDescription', 'Line Description', filterOptions.lineDescriptions)}
              </>
            )
          })()}
        </div>
        <div className="filter-panel-footer">
          <button className="btn-clear" onClick={clearFilters}>
            Clear All
          </button>
        </div>
      </div>
    </>
  ) : null

  // Calculate filtered transactions for metrics (same logic as MultiTableSystem)
  const filteredTransactions = useMemo(() => {
    const filtered = transactions.filter(row => {
      // Apply global active filters (from filter panel) - OR logic within each column
      const passesActiveFilters = Object.entries(activeFilters).every(([key, value]) => {
        if (!value) return true
        if (Array.isArray(value)) {
          // OR logic: row matches if it matches any value in the array
          return value.some(v => {
            const rowVal = (row[key] || '').toString().trim()
            const filterVal = (v || '').toString().trim()
            return rowVal === filterVal
          })
        }
        // Single value match
        const rowVal = (row[key] || '').toString().trim()
        const filterVal = (value || '').toString().trim()
        return rowVal === filterVal
      })

      if (!passesActiveFilters) return false

      // Apply advanced filters (from filter panel) - OR logic within each category
      if (Array.isArray(filterState.supplier) && filterState.supplier.length > 0) {
        if (!filterState.supplier.includes(row.supplier_name)) return false
      }

      if (Array.isArray(filterState.classificationL1) && filterState.classificationL1.length > 0) {
        const path = row.classification_path || row.taxonomy_path || ''
        const parts = path.split('|').map(p => p.trim())
        if (!parts[0] || !filterState.classificationL1.some(l1 => parts[0].toLowerCase() === l1.toLowerCase())) return false
      }

      if (Array.isArray(filterState.classificationL2) && filterState.classificationL2.length > 0) {
        const path = row.classification_path || row.taxonomy_path || ''
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

      if (Array.isArray(filterState.lineDescription) && filterState.lineDescription.length > 0) {
        if (!filterState.lineDescription.includes(row.line_description)) return false
      }

      return true
    })
    
    return filtered
  }, [transactions, activeFilters, filterState])

  // Check if there are low-confidence rows (for enabling system feedback toggle)
  const hasLowConfidenceRows = useMemo(() => {
    if (!transactions || transactions.length === 0) return false
    return transactions.some(row => {
      const conf = (row.confidence || row.classification_confidence || 'high').toLowerCase()
      return conf === 'low' || conf === 'l'
    })
  }, [transactions])

  // Check if rows are controlled by Category A supplier rules
  const checkCategoryASuppliers = useCallback((rows) => {
    // In a real implementation, this would check against a Category A supplier mapping
    // For now, we'll check if rows have a specific indicator or check against known Category A suppliers
    // This is a placeholder - you may need to integrate with your backend API to check Category A status
    const categoryASuppliers = new Set() // This would come from your backend/state
    return rows.filter(row => {
      const supplier = row.supplier_name || row.vendor_name || ''
      return categoryASuppliers.has(supplier)
    })
  }, [])

  // Fetch feedback suggestions from backend
  const refreshFeedbackSuggestions = useCallback(async () => {
    try {
      const feedbackList = await ipc.feedback.list()
      const pending = feedbackList.filter(f => f.status === 'pending')
      const mapped = pending.map(f => ({
        id: f.id,
        type: f.feedbackType,
        affectedRows: f.affectedTransactionIds || [],
        proposedChange: f.suggestion?.proposedDescription || f.suggestion?.proposedValue || JSON.stringify(f.suggestion),
        createdAt: f.createdAt,
      }))
      setFeedbackSuggestions(mapped)
      if (mapped.length > 0) {
        setNewFeedbackCount(mapped.length)
        setShowFeedbackNotification(true)
        setTimeout(() => setShowFeedbackNotification(false), 5000)
      }
    } catch (err) {
      console.error('Failed to fetch feedback suggestions:', err)
    }
  }, [])

  // Handle feedback approval via IPC
  const handleApproveFeedback = useCallback(async (suggestion) => {
    try {
      await ipc.feedback.approve(suggestion.id)
      setFeedbackSuggestions(prev => {
        const remaining = prev.filter(s => s.id !== suggestion.id)
        if (remaining.length === 0) {
          setShowFeedbackModal(false)
        }
        return remaining
      })
    } catch (err) {
      console.error('Failed to approve feedback:', err)
    }
  }, [])

  // Handle feedback rejection via IPC
  const handleRejectFeedback = useCallback(async (suggestion) => {
    try {
      await ipc.feedback.reject(suggestion.id)
      setFeedbackSuggestions(prev => prev.filter(s => s.id !== suggestion.id))
    } catch (err) {
      console.error('Failed to reject feedback:', err)
    }
  }, [])

  // Handle feedback edit
  const handleEditFeedback = useCallback((suggestionId, newText) => {
    setFeedbackSuggestions(prev => prev.map(s =>
      s.id === suggestionId
        ? { ...s, proposedChange: newText, proposal_text: newText }
        : s
    ))
  }, [])

  // Core reclassification logic — extracted so it can be called directly or from the feedback modal
  const executeReclassification = useCallback(async (rows: any[], targetPath: string, feedbackText?: string) => {
    // Show loader
    setIsReclassifying(true)
    setReclassificationProgress({ current: 0, total: rows.length })

    try {
      // Get row indices to update
      const rowIndices = rows.map(row => {
        return row.row_index !== undefined
          ? row.row_index
          : row.index !== undefined
            ? row.index
            : row.__index !== undefined
              ? row.__index
              : undefined
      }).filter(idx => idx !== undefined)

      // Store previous classifications for feedback generation
      const previousClassifications = new Map()
      rows.forEach(row => {
        const rowId = row.row_index !== undefined ? row.row_index : row.index
        if (rowId !== undefined) {
          previousClassifications.set(rowId, row.classification_path || row.taxonomy_path || '')
        }
      })

      // Use rows.length as fallback if no indices found
      const rowCount = rowIndices.length > 0 ? rowIndices.length : rows.length

      // Update transactions in memory (client-side only)
      setReclassificationProgress({ current: 0, total: rows.length })

      // Update the transactions state directly
      if (setTransactions) {
        setTransactions(prevTransactions => {
          const updated = prevTransactions.map((t, idx) => {
            if (rowIndices.length > 0) {
              // Use row indices if available
              if (rowIndices.includes(t.row_index) || rowIndices.includes(idx)) {
                // Parse target path and update L1-L4
                const pathParts = targetPath.split('|').filter(p => p.trim())
                const updatedRow = {
                  ...t,
                  classification_path: targetPath,
                  taxonomy_path: targetPath,
                  L1: pathParts[0] || '',
                  L2: pathParts[1] || '',
                  L3: pathParts[2] || '',
                  L4: pathParts[3] || '',
                  L5: pathParts[4] || '',
                  override_rule_applied: 'manual_reclassification'
                }
                // Update reclassification history
                const rowId = t.row_index !== undefined ? t.row_index : idx
                if (rowId !== undefined) {
                  setReclassificationHistory(prev => new Map(prev).set(rowId, targetPath))
                }
                setReclassificationProgress(prev => ({
                  current: prev.current + 1,
                  total: prev.total
                }))
                return updatedRow
              }
            } else {
              // Fallback: match by comparing row data
              const matches = rows.some(r => {
                // Try to match by key fields
                return (r.supplier_name && r.supplier_name === t.supplier_name) ||
                  (r.vendor_name && r.vendor_name === t.vendor_name) ||
                  (r.invoice_number && r.invoice_number === t.invoice_number) ||
                  (r.amount && r.amount === t.amount && r.supplier_name === t.supplier_name)
              })
              if (matches) {
                const pathParts = targetPath.split('|').filter(p => p.trim())
                const updatedRow = {
                  ...t,
                  classification_path: targetPath,
                  taxonomy_path: targetPath,
                  L1: pathParts[0] || '',
                  L2: pathParts[1] || '',
                  L3: pathParts[2] || '',
                  L4: pathParts[3] || '',
                  L5: pathParts[4] || '',
                  override_rule_applied: 'manual_reclassification'
                }
                // Update reclassification history
                const rowId = t.row_index !== undefined ? t.row_index : idx
                if (rowId !== undefined) {
                  setReclassificationHistory(prev => new Map(prev).set(rowId, targetPath))
                }
                setReclassificationProgress(prev => ({
                  current: prev.current + 1,
                  total: prev.total
                }))
                return updatedRow
              }
            }
            return t
          })
          return updated
        })
      }

      // Persist reclassification to backend via IPC
      try {
        // Resolve taxonomy node ID from the target path
        const taxonomyNodes = await ipc.taxonomy.getNodes()
        // The ClassificationTree prepends 'root|' — strip it for matching
        const cleanPath = targetPath.replace(/^root\|/, '')
        const targetNode = taxonomyNodes.find((n) => n.fullPath === cleanPath)

        if (targetNode) {
          // Extract transaction IDs from the rows being reclassified
          const transactionIds = rows
            .map((row) => row.id)
            .filter((id) => id != null)

          if (transactionIds.length > 0) {
            await ipc.transactions.reclassify(transactionIds, targetNode.id, feedbackText)
            console.log(`[Reclassify] Persisted ${transactionIds.length} rows to backend (node: ${targetNode.id}, feedback: ${feedbackText ? 'yes' : 'no'})`)
          }
        } else {
          console.warn(`[Reclassify] No taxonomy node found for path: ${cleanPath}`)
        }
      } catch (persistErr) {
        console.error('[Reclassify] Failed to persist to backend:', persistErr)
      }

      // Refresh transactions from backend to get updated classification paths
      if (refreshTransactions) {
        try {
          await refreshTransactions()
        } catch (refreshErr) {
          console.error('[Reclassify] Failed to refresh transactions:', refreshErr)
        }
      }

      // Refresh feedback suggestions from backend if enabled
      // The backend now awaits the feedback agent, so suggestions are ready immediately
      if (systemFeedbackEnabled && feedbackText) {
        refreshFeedbackSuggestions()
      }

      console.log(`✓ Successfully reclassified ${rowCount} rows`)

      // Show success toast
      const displayPath = targetPath.replace(/^root\|/, '').replace(/\|/g, ' → ')
      if (reclassToastTimer.current) clearTimeout(reclassToastTimer.current)
      setReclassToast({ show: true, rowCount, targetPath: displayPath })
      reclassToastTimer.current = setTimeout(() => setReclassToast({ show: false, rowCount: 0, targetPath: '' }), 5000)

      return true // Return true to indicate successful reclassification

    } catch (err: any) {
      console.error('Failed to reclassify rows:', err)

      // Still show toast even on partial failure (rows updated locally)
      const displayPath = targetPath.replace(/^root\|/, '').replace(/\|/g, ' → ')
      if (reclassToastTimer.current) clearTimeout(reclassToastTimer.current)
      setReclassToast({ show: true, rowCount: rows.length, targetPath: displayPath })
      reclassToastTimer.current = setTimeout(() => setReclassToast({ show: false, rowCount: 0, targetPath: '' }), 5000)

      return true
    } finally {
      setIsReclassifying(false)
      setReclassificationProgress({ current: 0, total: 0 })
    }
  }, [setTransactions, refreshTransactions, systemFeedbackEnabled, refreshFeedbackSuggestions])

  // Handle reclassification confirmation from the feedback modal
  const handleConfirmReclassify = useCallback(async (feedbackText?: string) => {
    if (!pendingReclassification) return
    const { rows, targetPath } = pendingReclassification
    setPendingReclassification(null)
    await executeReclassification(rows, targetPath, feedbackText)
  }, [pendingReclassification, executeReclassification])

  // Remove local filter from a table (must be declared before any early return)
  const handleRemoveLocalFilter = useCallback((tableId, filterKey, value) => {
    setSelectedRows(prev => {
      if (value !== null && value !== undefined) {
        const valueStr = (value || '').toString().trim()
        return prev.filter(k => k !== `${filterKey}:${valueStr}`)
      }
      return prev.filter(k => !k.startsWith(`${filterKey}:`))
    })
    setTableLocalFilters(prev => {
      const tableFilters = prev[tableId] || {}
      if (value !== null && Array.isArray(tableFilters[filterKey])) {
        const newValues = tableFilters[filterKey].filter(v => {
          const vStr = (v || '').toString().trim()
          const valueStr = (value || '').toString().trim()
          return vStr !== valueStr
        })
        if (newValues.length === 0) {
          const { [filterKey]: removed, ...rest } = tableFilters
          if (Object.keys(rest).length === 0) {
            const { [tableId]: removedTable, ...restTables } = prev
            return restTables
          }
          return { ...prev, [tableId]: rest }
        }
        return { ...prev, [tableId]: { ...tableFilters, [filterKey]: newValues } }
      } else {
        const { [filterKey]: removed, ...rest } = tableFilters
        if (Object.keys(rest).length === 0) {
          const { [tableId]: removedTable, ...restTables } = prev
          return restTables
        }
        return { ...prev, [tableId]: rest }
      }
    })
  }, [])

  // Derive current selection info for compact classification card
  const currentSelection = useMemo(() => {
    if (!selectedRows || selectedRows.length === 0 || !transactions || transactions.length === 0) {
      return null
    }

    // Use the most recently selected row
    const lastKey = selectedRows[selectedRows.length - 1]
    if (!lastKey) return null

    const [column, ...rest] = lastKey.split(':')
    const value = rest.join(':')
    if (!column || !value) return null

    // Find matching transactions for this column/value
    const normalizedValue = value.toString().trim() || 'Unknown'
    const matching = transactions.filter(row => {
      const raw = row[column]
      const rowVal = (raw !== null && raw !== undefined && String(raw).trim() !== '')
        ? String(raw).trim()
        : 'Unknown'
      return rowVal === normalizedValue
    })

    if (matching.length === 0) return null

    const first = matching[0]
    const supplier =
      first.supplier_name ||
      first.vendor_name ||
      first.Supplier ||
      normalizedValue

    const path = first.classification_path || first.taxonomy_path || ''
    let levels = []
    if (path) {
      levels = path.split('|').map(p => p.trim()).filter(Boolean)
    } else {
      levels = [first.L1, first.L2, first.L3, first.L4].filter(Boolean)
    }

    if (levels.length === 0) {
      return null
    }

    return {
      supplier,
      count: matching.length,
      levels,
    }
  }, [selectedRows, transactions])

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading classification data...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <h2>Error Loading Data</h2>
        <p>{error}</p>
        <p style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
          Please try reopening the project or restarting the application.
        </p>
      </div>
    )
  }

  // If no transactions, show message
  if (!transactions || transactions.length === 0) {
    return (
      <div className="dashboard">
        <div className="content-container">
          <div className="dashboard-error">
            <h2>No Data Available</h2>
            <p>No transactions found in dataset "{datasetId}".</p>
            <p style={{ fontSize: '14px', color: '#666', marginTop: '10px' }}>
              This dataset may not have been classified yet, or there may be no data.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <div className="content-container">
        {/* Tab Content */}
        {activeTab === 'tables' && (
          <div className="tab-content tables-tab">
            {/* Minimal inline: active filters + actions (no full-width bar) */}
            <div className="review-toolbar-inline">
              <div className="current-classification-bar">
                {currentSelection ? (
                  <>
                    <span className="current-classification-label">{currentSelection.supplier}</span>
                    <span className="current-classification-path" title={currentSelection.levels.join(' → ')}>
                      {currentSelection.levels.join(' → ')}
                    </span>
                  </>
                ) : selectedRows.length > 0 ? (
                  <span className="current-classification-placeholder" style={{ color: '#9ca3af', fontStyle: 'italic' }}>Unclassified (no classification assigned yet)</span>
                ) : (
                  <span className="current-classification-placeholder">Select a supplier to see its current classification</span>
                )}
              </div>
              <div className="review-toolbar-actions">
                {hasTableFilters && (
                  <button
                    type="button"
                    className="clear-all-table-filters-btn compact"
                    onClick={() => clearAllTableFiltersRef.current?.()}
                    title="Clear all table filters"
                  >
                    <X size={12} />
                    Clear
                  </button>
                )}
                <ActiveFilters
                  activeFilters={activeFilters}
                  filterState={filterState}
                  tableLocalFilters={tableLocalFilters}
                  tables={tables}
                  onRemoveFilter={removeFilter}
                  onClearAll={clearFilters}
                  onRemoveLocalFilter={handleRemoveLocalFilter}
                  compact={true}
                />
                <button
                  type="button"
                  className="compact-control dashboard-btn"
                  onClick={() => setShowDashboardModal(true)}
                  title="Open Dashboard"
                >
                  <BarChart3 size={14} />
                  <span>Dashboard</span>
                </button>
                <button
                  type="button"
                  className={`compact-control system-feedback-compact ${systemFeedbackEnabled ? 'active' : ''}`}
                  onClick={() => setSystemFeedbackEnabled(!systemFeedbackEnabled)}
                  title="System feedback on reclassification"
                  role="switch"
                  aria-checked={systemFeedbackEnabled}
                >
                  <Sparkles size={14} className="system-feedback-icon" />
                  <span className="system-feedback-label">System feedback</span>
                  <span className="toggle-switch compact" aria-hidden="true">
                    <span className="toggle-knob" />
                  </span>
                </button>
                <div className="add-table-wrapper" style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="add-table-icon-btn compact"
                    onClick={() => setShowAddTableMenu(!showAddTableMenu)}
                    disabled={!availableColumns || availableColumns.length === 0}
                    title="Add table"
                    aria-label="Add table"
                  >
                    <Plus size={14} />
                  </button>
                  {showAddTableMenu && availableColumns?.length > 0 && (
                    <>
                      <div className="dropdown-backdrop" onClick={() => setShowAddTableMenu(false)} />
                      <div className="add-table-dropdown">
                        <div className="dropdown-header">Select Column</div>
                        {availableColumns.map(column => (
                          <button
                            key={column}
                            type="button"
                            className="dropdown-item"
                            onClick={() => {
                              addTable(column)
                              setShowAddTableMenu(false)
                            }}
                          >
                            {column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="tables-board-layout">
              <div className="tables-layout-container">
                {/* Multi-Table System (full width, sidebar removed) */}
                <div className="tables-section">
                  <MultiTableSystem
                    transactions={filteredTransactions}
                    activeFilters={activeFilters}
                    setActiveFilters={setActiveFilters}
                    selectedRows={selectedRows}
                    setSelectedRows={setSelectedRows}
                    filterState={filterState}
                    setFilterState={setFilterState}
                    tables={tables}
                    setTables={setTables}
                    availableColumns={availableColumns}
                    addTable={addTable}
                    tableLocalFilters={tableLocalFilters}
                    setTableLocalFilters={setTableLocalFilters}
                    onTableFiltersChange={setHasTableFilters}
                    clearAllTableFiltersRef={clearAllTableFiltersRef}
                    keyboardFocus={keyboardFocus}
                    setKeyboardFocus={setKeyboardFocus}
                    tableNav={tableNav}
                    setTableNav={setTableNav}
                    onFocusedClassificationPathChange={setFocusedClassificationPath}
                  />
                </div>
              </div>

              {/* Classification Tree */}
              <div className="classification-section">
                <ClassificationTree
                  transactions={transactions}
                  activeFilters={activeFilters}
                  selectedRows={selectedRows}
                  setSelectedRows={setSelectedRows}
                  keyboardFocus={keyboardFocus}
                  setKeyboardFocus={setKeyboardFocus}
                  onReclassify={async (rows, targetPath) => {
                    // Handle reclassification - batch update CSV
                    console.log(`Reclassifying ${rows.length} rows to path: ${targetPath}`)

                    if (!rows || rows.length === 0) {
                      console.warn('No rows to reclassify')
                      return false
                    }

                    // Check for Category A supplier rows
                    const categoryARows = checkCategoryASuppliers(rows)
                    if (categoryARows.length > 0) {
                      const proceed = window.confirm(
                        `These ${categoryARows.length} row(s) are controlled by Category A rules. ` +
                        `Are you sure you want to continue with this action?`
                      )
                      if (!proceed) {
                        return false
                      }
                    }

                    // Check for conflict: rows that were already reclassified with different changes
                    const conflictingRows = []
                    rows.forEach(row => {
                      const rowId = row.row_index !== undefined ? row.row_index : row.index
                      if (rowId !== undefined && reclassificationHistory.has(rowId)) {
                        const previousPath = reclassificationHistory.get(rowId)
                        if (previousPath !== targetPath) {
                          conflictingRows.push({ row, previousPath })
                        }
                      }
                    })

                    if (conflictingRows.length > 0 && systemFeedbackEnabled) {
                      const override = window.confirm(
                        `${conflictingRows.length} row(s) were previously reclassified to a different path. ` +
                        `This will override existing feedback. Continue?`
                      )
                      if (!override) {
                        return false
                      }
                      // Remove existing feedback for these rows
                      setFeedbackSuggestions(prev => prev.filter(s => {
                        return !s.affectedRows?.some(ar =>
                          conflictingRows.some(cr =>
                            (ar.row_index !== undefined && ar.row_index === cr.row.row_index) ||
                            (ar.index !== undefined && ar.index === cr.row.index)
                          )
                        )
                      }))
                    }

                    // If system feedback is enabled, show the confirm modal to collect feedback text
                    if (systemFeedbackEnabled) {
                      setPendingReclassification({ rows, targetPath })
                      return true
                    }

                    // Feedback disabled — reclassify immediately without feedback text
                    return await executeReclassification(rows, targetPath)
                  }}
                  datasetId={datasetId}
                  foldername={foldername}
                />
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Reclassification Loader */}
      {isReclassifying && (
        <ReclassificationLoader
          rowCount={reclassificationProgress.total}
          currentRow={reclassificationProgress.current}
        />
      )}

      {/* Reclassify Confirm Modal — collects feedback text when system feedback is enabled */}
      {pendingReclassification && (
        <ReclassifyConfirmModal
          rowCount={pendingReclassification.rows.length}
          targetPath={pendingReclassification.targetPath}
          onConfirm={handleConfirmReclassify}
          onCancel={() => setPendingReclassification(null)}
        />
      )}

      {/* System Feedback Modal */}
      {showFeedbackModal && (
        <SystemFeedbackModal
          feedbackSuggestions={feedbackSuggestions}
          onClose={() => setShowFeedbackModal(false)}
          onApprove={handleApproveFeedback}
          onReject={handleRejectFeedback}
          onEdit={handleEditFeedback}
        />
      )}

      {/* Dashboard Modal */}
      {showDashboardModal && (
        <>
          <div className="dashboard-modal-backdrop" onClick={() => setShowDashboardModal(false)} />
          <div className="dashboard-modal">
            <div className="dashboard-modal-header">
              <h2>Dashboard</h2>
              <button className="dashboard-modal-close" onClick={() => setShowDashboardModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="dashboard-modal-content">
              <MetricsTab
                transactions={transactions}
                filteredTransactions={filteredTransactions}
                onDrillToFilters={(filters) => {
                  setFilterState(prev => {
                    const next = { ...prev }
                    if (filters.supplier) next.supplier = filters.supplier
                    if (filters.classificationL1) next.classificationL1 = filters.classificationL1
                    if (filters.glDescription) next.glDescription = filters.glDescription
                    if (filters.company) next.company = filters.company
                    if (filters.costCenter) next.costCenter = filters.costCenter
                    if (filters.country) next.country = filters.country
                    if (filters.supplierCategory) next.supplierCategory = filters.supplierCategory
                    return next
                  })
                  setShowDashboardModal(false)
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* System Feedback Notification */}
      {showFeedbackNotification && (
        <div className="feedback-notification">
          <Sparkles size={20} />
          <span>
            {newFeedbackCount} new feedback suggestion{newFeedbackCount !== 1 ? 's' : ''} generated
          </span>
            <button
              className="notification-link"
              onClick={() => {
                setShowFeedbackNotification(false)
                // Trigger highlight effect on System Feedback section
                setHighlightFeedback(true)
              }}
            >
              View
            </button>
          <button
            className="notification-close"
            onClick={() => setShowFeedbackNotification(false)}
            title="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Reclassification Success Toast */}
      {reclassToast.show && createPortal(
        <div className="reclass-toast">
          <CheckCircle size={16} />
          <span>
            Reclassified <strong>{reclassToast.rowCount}</strong> row{reclassToast.rowCount !== 1 ? 's' : ''} → <strong>{reclassToast.targetPath}</strong>
          </span>
          <button className="reclass-toast-close" onClick={() => setReclassToast({ show: false, rowCount: 0, targetPath: '' })}>
            <X size={14} />
          </button>
        </div>,
        document.body
      )}

    </div>
  )
}

export default Dashboard
