import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useDrag, useDrop } from 'react-dnd'
import { Plus, X, Filter, Search, BarChart3, ChevronRight, ChevronDown, ArrowUp, ArrowDown } from 'lucide-react'
import useKeyboardShortcuts from '../../hooks/useKeyboardShortcuts'
import '../../styles/MultiTableSystem.css'

export const ITEM_TYPE = 'FILTER_ROW'
export const TABLE_ROW_TYPE = 'TABLE_ROW'

// Helper function to format column names for display
const formatColumnTitle = (title) => {
  if (!title) return title
  
  // Map of long names to shorter, cleaner versions
  const titleMap = {
    'Client Spend Category Name': 'Spend Category',
    'supplier_name': 'Supplier',
    'gl_description': 'GL Description',
    'classification_l1': 'Classification L1',
    'classification_l2': 'Classification L2',
    'classification_l3': 'Classification L3',
    'classification_l4': 'Classification L4'
  }
  
  // Return mapped version if exists, otherwise format the title
  if (titleMap[title]) {
    return titleMap[title]
  }
  
  // Format: replace underscores with spaces and capitalize
  return title.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

const NAME_DISPLAY_LENGTH = 20
const truncateName = (str) => {
  if (str == null || str === '') return str
  const s = String(str).trim()
  if (s.length <= NAME_DISPLAY_LENGTH) return s
  return s.slice(0, NAME_DISPLAY_LENGTH) + '…'
}

// Hierarchical row component with expand/collapse
const HierarchicalRow = ({ 
  item, 
  level = 0, 
  expandedNodes, 
  toggleExpanded, 
  onSelect, 
  isSelected, 
  onDragStart, 
  data, 
  column,
  taxonomyLevelFilter = null, // When set (1–4), only show rows for that taxonomy level
  focusedPath = null // Full classification path string to visually highlight
}) => {
  const hasChildren = item.children && item.children.length > 0
  const isExpanded = expandedNodes.has(item.value)
  const amount = item.amount || 0
  const isOnFocusedPath = focusedPath && item.fullPath && (
    focusedPath === item.fullPath ||
    focusedPath.startsWith(item.fullPath + '|') ||
    item.fullPath.startsWith(focusedPath + '|')
  )
  const effectiveIsExpanded = taxonomyLevelFilter ? true : (isExpanded || isOnFocusedPath)
  
  const handleClick = (e) => {
    e.stopPropagation()
    // Always notify parent of selection with the full taxonomy path if available.
    // This lets clicks on L1 / L2 / L3 drive external filters.
    const selectionValue = item.fullPath || item.value
    if (onSelect && selectionValue) {
      onSelect(selectionValue)
    }
    // For nodes with children, also toggle expand/collapse on row click
    if (hasChildren) {
      toggleExpanded(item.value)
    }
  }

  // Calculate total amount including children if not already calculated
  const displayAmount = hasChildren && amount === 0 
    ? item.children.reduce((sum, child) => sum + (child.amount || 0), 0)
    : amount

  // Extract current classification from fullPath or transaction data
  const getCurrentClassification = () => {
    // Try to get from fullPath if available (for hierarchical classification paths)
    if (item.fullPath) {
      const parts = item.fullPath.split('|').map(p => p.trim()).filter(p => p)
      return {
        l1: parts[0] || '',
        l2: parts[1] || '',
        l3: parts[2] || '',
        l4: parts[3] || ''
      }
    }
    
    // Otherwise, try to find matching transactions and get classification
    if (data && column) {
      const matchingTransactions = data.filter(t => {
        const val = (t[column] || '').toString().trim() || 'Unknown'
        const itemVal = (item.value || '').toString().trim() || 'Unknown'
        return val === itemVal
      })
      
      if (matchingTransactions.length > 0) {
        const firstRow = matchingTransactions[0]
        const path = firstRow.classification_path || firstRow.taxonomy_path || ''
        if (path) {
          const parts = path.split('|').map(p => p.trim()).filter(p => p)
          return {
            l1: parts[0] || firstRow.L1 || firstRow.l1 || '',
            l2: parts[1] || firstRow.L2 || firstRow.l2 || '',
            l3: parts[2] || firstRow.L3 || firstRow.l3 || '',
            l4: parts[3] || firstRow.L4 || firstRow.l4 || ''
          }
        }
        return {
          l1: firstRow.L1 || firstRow.l1 || '',
          l2: firstRow.L2 || firstRow.l2 || '',
          l3: firstRow.L3 || firstRow.l3 || '',
          l4: firstRow.L4 || firstRow.l4 || ''
        }
      }
    }
    
    return null
  }

  const classification = getCurrentClassification()
  const hasClassification = classification && (classification.l1 || classification.l2 || classification.l3 || classification.l4)
  
  // Build classification string in single line format
  const classificationString = hasClassification 
    ? [classification.l1, classification.l2, classification.l3, classification.l4]
        .filter(level => level && level.trim() !== '')
        .join(' → ')
    : null

  // Determine if this row should be rendered for the current taxonomy level filter.
  // level is zero-based (0 = L1, 1 = L2, etc.), so compare with level + 1.
  const shouldShowRow = !taxonomyLevelFilter || (level + 1 === taxonomyLevelFilter)

  const isFocused = focusedPath && item.fullPath && (
    item.fullPath === focusedPath ||
    focusedPath === item.fullPath ||
    focusedPath.startsWith(item.fullPath + '|') ||
    item.fullPath.startsWith(focusedPath + '|')
  )

  return (
    <>
      {shouldShowRow && (
        <div
          className={`table-row hierarchical level-${level} ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
          onClick={handleClick}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          <div className="row-left">
            {hasChildren && !taxonomyLevelFilter && (
              <button
                className="expand-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleExpanded(item.value)
                }}
              >
                {effectiveIsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            )}
            {(!hasChildren || taxonomyLevelFilter) && <span className="expand-spacer" />}
            <span className="row-value" title={item.value || ''}>
              {truncateName(item.value || 'Unknown')}
            </span>
          </div>
          <span className="row-amount">
            ${Number(displayAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>
      )}
      {hasChildren && effectiveIsExpanded && item.children.map((child, idx) => (
        <HierarchicalRow
          key={`${child.value}-${idx}`}
          item={child}
          level={level + 1}
          expandedNodes={expandedNodes}
          toggleExpanded={toggleExpanded}
          onSelect={onSelect}
          isSelected={isSelected === child.value}
          onDragStart={onDragStart}
          data={data}
          column={column}
          taxonomyLevelFilter={taxonomyLevelFilter}
          focusedPath={focusedPath}
        />
      ))}
    </>
  )
}

// Regular draggable row component - can be dragged for filtering or reclassification
const DraggableTableRow = ({ row, column, amount, onDragEnd, isSelected, isKeyboardFocused = false, onSelect, transactionRows, onToggleSelect, isMultiSelectMode, selectedRowsInTable = [], data, rowRef }) => {
  // Collect all selected rows from the same table for multi-drag
  const selectedValues = selectedRowsInTable.length > 0 && isSelected
    ? selectedRowsInTable
    : [row]
  
  // Collect all transaction rows for selected values
  const allTransactionRows = selectedValues.length > 1
    ? selectedValues.flatMap(val => 
        (data || []).filter(t => {
          const tVal = (t[column] || '').toString().trim() || 'Unknown'
          const itemVal = (val || '').toString().trim() || 'Unknown'
          return tVal === itemVal
        })
      )
    : (transactionRows || [])

  // For filtering between tables - primary drag for filtering
  // If multiple rows are selected, include all selected rows
  const [{ isDragging }, drag] = useDrag({
    type: ITEM_TYPE,
    item: () => {
      return { 
        type: 'filter', 
        column, 
        value: row,
        // Include all selected values if multiple are selected
        selectedValues: selectedValues.length > 1 ? selectedValues : [row],
        // Also include transaction rows for reclassification when dropped on tree
        transactionRows: allTransactionRows,
        isSelected: isSelected,
        isMultiSelect: selectedValues.length > 1
      }
    },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  })

  const transactionCount = allTransactionRows?.length || transactionRows?.length || 0
  const isMultiDrag = selectedValues.length > 1
  const tooltipText = isMultiDrag
    ? `Dragging ${selectedValues.length} selected rows (${transactionCount} transactions)`
    : transactionCount > 0 
      ? `Drag to reclassify ${transactionCount} transaction${transactionCount !== 1 ? 's' : ''}`
      : 'Click to select, drag to filter or reclassify'
  
  const handleClick = (e) => {
    // If clicking on checkbox, don't trigger row select
    if (e.target.closest('.row-checkbox')) {
      return
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + click: toggle selection
      e.preventDefault()
      onToggleSelect && onToggleSelect(row)
    } else {
      // Regular click: select/deselect
      onSelect && onSelect(row)
    }
  }

  // Extract current classification (L1, L2, L3, L4) from transaction rows
  const getCurrentClassification = () => {
    if (!transactionRows || transactionRows.length === 0) return null
    
    // Get classification from first transaction (assuming all transactions in a row have same classification)
    const firstRow = transactionRows[0]
    const l1 = firstRow.L1 || firstRow.l1 || ''
    const l2 = firstRow.L2 || firstRow.l2 || ''
    const l3 = firstRow.L3 || firstRow.l3 || ''
    const l4 = firstRow.L4 || firstRow.l4 || ''
    
    // Also try to parse from classification_path
    const path = firstRow.classification_path || firstRow.taxonomy_path || ''
    if (path) {
      const parts = path.split('|').map(p => p.trim()).filter(p => p)
      return {
        l1: parts[0] || l1 || '',
        l2: parts[1] || l2 || '',
        l3: parts[2] || l3 || '',
        l4: parts[3] || l4 || ''
      }
    }
    
    return {
      l1: l1 || '',
      l2: l2 || '',
      l3: l3 || '',
      l4: l4 || ''
    }
  }

  const classification = getCurrentClassification()
  const hasClassification = classification && (classification.l1 || classification.l2 || classification.l3 || classification.l4)
  
  // Build classification string in single line format
  const classificationString = hasClassification 
    ? [classification.l1, classification.l2, classification.l3, classification.l4]
        .filter(level => level && level.trim() !== '')
        .join(' → ')
    : null

  // Combine drag ref with rowRef for keyboard navigation scrolling
  const combinedRef = useCallback((node) => {
    if (drag) {
      drag(node)
    }
    if (rowRef) {
      rowRef.current = node
    }
  }, [drag, rowRef])

  // For the taxonomy table, only show the last level label (e.g. "Facilities")
  // instead of the full path "Non Clinical|Facilities". For all other tables,
  // show the value as-is.
  const fullDisplayValue =
    column === 'classification_path' && row
      ? (() => {
          const parts = row.toString().split('|').map(p => p.trim()).filter(Boolean)
          return parts.length > 0 ? parts[parts.length - 1] : row
        })()
      : row

  return (
    <div
      ref={combinedRef}
      className={`table-row ${isDragging ? 'dragging' : ''} ${isSelected ? 'selected' : ''} ${isKeyboardFocused ? 'keyboard-focused' : ''}`}
      onClick={handleClick}
      style={{ opacity: isDragging ? 0.5 : 1 }}
      title={tooltipText}
    >
      <span className="row-value" title={row}>
        {truncateName(fullDisplayValue)}
      </span>
      <span className="row-amount">
        ${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>
    </div>
  )
}


// Table Component
const FilterTable = ({
  tableId,
  title,
  column,
  data,
  activeFilters,
  localFilters = {}, // Local filters specific to this table (from drag-drop)
  onClose,
  onDropFilter,
  onClearLocalFilters,
  selectedRows,
  onSelectRow,
  onToggleRowSelect,
  isHierarchical = false,
  collapsed = false,
  onToggleCollapse,
  onFiltersChange,
  clearFiltersRef,
  keyboardFocus = 'tree',
  tableNav = { tableIndex: 0, rowIndex: 0 },
  tableIndex = 0,
  focusedClassificationPath = null,
  // Lifted from parent so search term is never lost on re-render
  filterSearchTerm = '',
  onFilterSearchChange
}) => {
  const isTaxonomyTable = column === 'classification_path'
  const [expandedNodes, setExpandedNodes] = useState(new Set())
  const [sortColumn, setSortColumn] = useState('amount') // 'amount' or 'name'
  const [sortDirection, setSortDirection] = useState('desc') // 'asc' or 'desc'
  const tableSearchTerm = filterSearchTerm
  const setTableSearchTerm = onFilterSearchChange || (() => {})
  const [selectedFilterItems, setSelectedFilterItems] = useState(new Set()) // Selected items for filtering
  const [showFilterPanel, setShowFilterPanel] = useState(false) // Show/hide filter panel
  const tableContentRef = useRef(null) // Ref for scrollable table content
  const focusedRowRef = useRef(null) // Ref for currently focused row
  // For taxonomy table we always show a hierarchical tree view
  const effectiveHierarchical = isHierarchical || isTaxonomyTable
  // Active taxonomy level filter for classification_path tree (1–4). null = show all.
  const [activeTaxonomyLevel, setActiveTaxonomyLevel] = useState(null)

  // Close filter panel when table is collapsed
  useEffect(() => {
    if (collapsed) {
      setShowFilterPanel(false)
    }
  }, [collapsed])

  // Close filter panel when clicking outside (ignore clicks inside panel, including the search input)
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!showFilterPanel || collapsed) return
      const target = e.target
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('input') || target.closest('textarea')) return
      const filterPanel = target.closest('.table-filter-panel')
      const filterButton = target.closest('.table-filter-btn')
      const filterWrapper = target.closest('.table-filter-wrapper')
      if (!filterPanel && !filterButton && !filterWrapper) {
        setShowFilterPanel(false)
      }
    }

    if (showFilterPanel) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showFilterPanel, collapsed])

  // Auto-scroll to focused row when keyboard navigation changes
  useEffect(() => {
    if (keyboardFocus === 'tables' && tableNav?.tableIndex === tableIndex && focusedRowRef.current) {
      // Small delay to ensure DOM is updated
      setTimeout(() => {
        if (focusedRowRef.current) {
          focusedRowRef.current.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest'
          })
        }
      }, 0)
    }
  }, [keyboardFocus, tableNav, tableIndex])

  // Get all unique values from table data for filter dropdown
  const filterOptions = useMemo(() => {
    if (!data || !column) return []
    const uniqueValues = new Set()
    data.forEach(row => {
      const rawValue = row[column]
      const value = (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') 
        ? String(rawValue).trim() 
        : 'Unknown'
      uniqueValues.add(value)
    })
    return Array.from(uniqueValues).sort()
  }, [data, column])

  // Filter options based on search term
  const filteredOptions = useMemo(() => {
    if (!tableSearchTerm) return filterOptions
    return filterOptions.filter(option => 
      option.toLowerCase().includes(tableSearchTerm.toLowerCase())
    )
  }, [filterOptions, tableSearchTerm])

  // Toggle filter item selection
  const toggleFilterItem = (value) => {
    setSelectedFilterItems(prev => {
      const newSet = new Set(prev)
      if (newSet.has(value)) {
        newSet.delete(value)
      } else {
        newSet.add(value)
      }
      // Notify parent of filter changes
      if (onFiltersChange) {
        onFiltersChange(tableId, newSet.size > 0)
      }
      return newSet
    })
  }

  // Clear all filters for this table
  const clearAllFilters = () => {
    setSelectedFilterItems(new Set())
    setTableSearchTerm('')
    if (onFilterSearchChange) onFilterSearchChange('')
    if (onFiltersChange) {
      onFiltersChange(tableId, false)
    }
  }

  // Expose clear function to parent via ref
  useEffect(() => {
    if (clearFiltersRef && typeof clearFiltersRef === 'function') {
      clearFiltersRef(() => {
        setSelectedFilterItems(new Set())
        setTableSearchTerm('')
        if (onFilterSearchChange) onFilterSearchChange('')
        if (onFiltersChange) {
          onFiltersChange(tableId, false)
        }
      })
      // Cleanup: remove ref when component unmounts
      return () => {
        clearFiltersRef(null)
      }
    }
  }, [clearFiltersRef, tableId, onFiltersChange])

  const toggleExpanded = (value) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev)
      if (newSet.has(value)) {
        newSet.delete(value)
      } else {
        newSet.add(value)
      }
      return newSet
    })
  }

  // Handle sorting
  const handleSort = (columnName) => {
    if (sortColumn === columnName) {
      // Toggle direction if same column
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      // Set new column and default to desc
      setSortColumn(columnName)
      setSortDirection('desc')
    }
  }

  const [{ isOver }, drop] = useDrop({
    accept: ITEM_TYPE,
    drop: (item) => {
      if (item.type === 'filter' && item.column !== column) {
        // Check if we have multiple selected values to drop
        if (item.selectedValues && item.selectedValues.length > 1) {
          // Drop all selected rows as multiple filters (OR logic within column)
          // Pass target table ID so filter is applied locally to this table only
          onDropFilter(item.column, item.value, column, tableId, item.selectedValues)
        } else {
          // Drop single row (adds to existing array if column already has filters)
          // Pass target table ID so filter is applied locally to this table only
          onDropFilter(item.column, item.value, column, tableId)
        }
      }
      return { tableId }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  })
  
  // Get selected rows for this table
  const tableSelectedRows = useMemo(() => {
    return selectedRows
      .filter(key => key.startsWith(`${column}:`))
      .map(key => key.split(':').slice(1).join(':'))
  }, [selectedRows, column])

  // Apply local filters to data first (only affects this table)
  const locallyFilteredData = useMemo(() => {
    if (!data || Object.keys(localFilters).length === 0) return data
    
    return data.filter(row => {
      // Apply local filters (from drag-drop) - OR logic within each column
      return Object.entries(localFilters).every(([key, value]) => {
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
    })
  }, [data, localFilters])

  // Build hierarchical or flat table data
  const tableData = useMemo(() => {
    if (!locallyFilteredData || !column) return []

    const grouped = locallyFilteredData.reduce((acc, row) => {
      // Handle empty/null values consistently - normalize to string and trim
      const rawValue = isTaxonomyTable
        ? (row.classification_path || row.taxonomy_path || row[column])
        : row[column]
      const value = (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') 
        ? String(rawValue).trim() 
        : 'Unknown'
      const amount = parseFloat(row.amount || row.invoice_amount || 0) || 0
      
      if (effectiveHierarchical) {
        // In hierarchical mode, always treat values hierarchically and
        // roll up amounts to every level (L1, L2, L3, L4) so parents
        // never show $0 when their children have spend.
        const parts = value.includes('|') 
          ? value.split('|').filter(p => p.trim())
          : [value.trim() || 'Unknown']
        let current = acc
        
        parts.forEach((part, idx) => {
          const key = part.trim()
          if (!current || typeof current !== 'object' || Array.isArray(current)) {
            // Safety check: if current is not a plain object, reset to acc
            current = acc
          }
          // Check if current[key] exists and is already a number/string (from previous flat processing)
          // Convert it to hierarchical structure
          if (current[key] && typeof current[key] !== 'object') {
            // Convert flat value to hierarchical structure
            const existingAmount = typeof current[key] === 'number' ? current[key] : 0
            current[key] = { value: key, amount: existingAmount, children: {}, fullPath: parts.slice(0, idx + 1).join('|') }
          }
          if (!current[key]) {
            current[key] = { value: key, amount: 0, children: {}, fullPath: parts.slice(0, idx + 1).join('|') }
          }
          // Double-check that current[key] is an object before accessing properties
          if (typeof current[key] !== 'object' || current[key] === null || Array.isArray(current[key])) {
            current[key] = { value: key, amount: 0, children: {}, fullPath: parts.slice(0, idx + 1).join('|') }
          }
          // Always add this row's amount at every level so parents roll up children
          current[key].amount = (current[key].amount || 0) + amount
          // Ensure children is always an object before assigning
          if (!current[key].children || typeof current[key].children !== 'object' || Array.isArray(current[key].children)) {
            current[key].children = {}
          }
          current = current[key].children
        })
      } else {
        // Flat structure: just accumulate amounts
        acc[value] = (acc[value] || 0) + amount
      }
      
      return acc
    }, {})

    if (effectiveHierarchical) {
      // Convert hierarchical structure to array
      const buildHierarchy = (obj) => {
        return Object.values(obj)
          .map(item => ({
            ...item,
            amount: item.amount || 0,
            children: item.children && Object.keys(item.children).length > 0 
              ? buildHierarchy(item.children) 
              : []
          }))
          .filter(item => {
            // Filter out entries with zero amount and no children
            const hasZeroAmount = (item.amount || 0) === 0
            const hasNoChildren = !item.children || item.children.length === 0
            
            // Filter out entries with zero amount and no children
            if (hasZeroAmount && hasNoChildren) {
              return false
            }
            
            // Filter out blank/empty values with no children
            const isBlank = !item.value || 
                           item.value.trim() === '' || 
                           item.value.toLowerCase() === '[blank]' || 
                           item.value.toLowerCase() === 'unknown' ||
                           item.value.toLowerCase() === 'blank'
            if (isBlank && hasNoChildren) {
              return false
            }
            
            return true
          })
          .sort((a, b) => {
            if (sortColumn === 'amount') {
              return sortDirection === 'asc' 
                ? (a.amount || 0) - (b.amount || 0)
                : (b.amount || 0) - (a.amount || 0)
            } else {
              return sortDirection === 'asc'
                ? (a.value || '').localeCompare(b.value || '', undefined, { sensitivity: 'base' })
                : (b.value || '').localeCompare(a.value || '', undefined, { sensitivity: 'base' })
            }
          })
      }
      return buildHierarchy(grouped)
    }

    // Flat structure
    const flatData = Object.entries(grouped)
      .map(([value, amount]) => ({ 
        value: value || 'Unknown', 
        amount: amount || 0 
      }))
      .filter(item => {
        // Filter out entries with zero amount
        const hasZeroAmount = (item.amount || 0) === 0
        if (hasZeroAmount) {
          return false
        }
        
        // Filter out blank/empty values
        const isBlank = !item.value || 
                       item.value.trim() === '' || 
                       item.value.toLowerCase() === '[blank]' || 
                       item.value.toLowerCase() === 'unknown' ||
                       item.value.toLowerCase() === 'blank'
        if (isBlank) {
          return false
        }
        
        // Apply search term filter: when user types in the filter box, only show matching rows
        const term = (tableSearchTerm || '').toString().trim()
        if (term) {
          if (!item.value || !String(item.value).toLowerCase().includes(term.toLowerCase())) {
            return false
          }
        }
        
        // Apply per-table filter (selected items) if present
        if (selectedFilterItems.size > 0) {
          return selectedFilterItems.has(item.value)
        }
        
        return true
      })
      .sort((a, b) => {
        if (sortColumn === 'amount') {
          return sortDirection === 'asc' 
            ? (a.amount || 0) - (b.amount || 0)
            : (b.amount || 0) - (a.amount || 0)
        } else {
          return sortDirection === 'asc'
            ? (a.value || '').localeCompare(b.value || '', undefined, { sensitivity: 'base' })
            : (b.value || '').localeCompare(a.value || '', undefined, { sensitivity: 'base' })
        }
      })
    
    return flatData
  }, [
    locallyFilteredData,
    column,
    isTaxonomyTable,
    effectiveHierarchical,
    selectedFilterItems,
    sortColumn,
    sortDirection,
    tableSearchTerm
  ])

  // When a taxonomy level (L1–L4) pill is active for the Classification Path
  // table, flatten the hierarchy to that exact level and sort globally so the
  // list appears in clear descending or ascending order by Amount.
  const displayedHierarchicalData = useMemo(() => {
    if (!effectiveHierarchical) return tableData
    if (!isTaxonomyTable || !activeTaxonomyLevel) return tableData

    const flattened = []

    const walk = (items, level) => {
      if (!Array.isArray(items) || items.length === 0) return
      items.forEach((item) => {
        if (level === activeTaxonomyLevel) {
          flattened.push({ ...item, children: [] })
          return
        }
        if (item?.children?.length) {
          walk(item.children, level + 1)
        }
      })
    }

    walk(tableData, 1)

    flattened.sort((a, b) => {
      if (sortColumn === 'amount') {
        return sortDirection === 'asc'
          ? (a.amount || 0) - (b.amount || 0)
          : (b.amount || 0) - (a.amount || 0)
      }
      return sortDirection === 'asc'
        ? (a.value || '').localeCompare(b.value || '', undefined, { sensitivity: 'base' })
        : (b.value || '').localeCompare(a.value || '', undefined, { sensitivity: 'base' })
    })

    return flattened
  }, [effectiveHierarchical, isTaxonomyTable, activeTaxonomyLevel, tableData, sortColumn, sortDirection])

  const totalAmount = useMemo(() => {
    const calculateTotal = (items) => {
      return items.reduce((sum, item) => {
        const itemAmount = item.amount || 0
        const childrenTotal = item.children && item.children.length > 0 
          ? calculateTotal(item.children) 
          : 0
        return sum + itemAmount + childrenTotal
      }, 0)
    }
    return effectiveHierarchical 
      ? calculateTotal(tableData) 
      : tableData.reduce((sum, item) => sum + (item.amount || 0), 0)
  }, [tableData, effectiveHierarchical])

  return (
    <div 
      ref={drop}
      className={`filter-table ${isTaxonomyTable ? 'taxonomy-table' : ''} ${isOver ? 'drag-over' : ''}`}
    >
      {/* Table Header with Title and Close - no click action so content stays visible */}
      <div 
        className="table-header-bar" 
        style={{ position: 'relative' }}
      >
        {/* Do not render a close button for the permanent Classification Path table */}
        {!isTaxonomyTable && (
          <div className="table-header-actions" onClick={(e) => e.stopPropagation()}>
            <button className="close-btn" onClick={() => onClose(tableId)} title="Close">
              <X size={12} />
            </button>
          </div>
        )}
        <div className="table-title-section">
          <span 
            className="table-title-text" 
            title={title}
            onMouseEnter={(e) => e.stopPropagation()}
          >
            {formatColumnTitle(title)}
          </span>
          {!collapsed && (
            <>
              <span className="table-total-badge" title={`Total: $${totalAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}>
                ${(totalAmount / 1000).toFixed(0)}k
              </span>
              {/* Classification Path table: sort button to the right of amount */}
              {isTaxonomyTable && (
                <button
                  type="button"
                  className="table-sort-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSort('amount')
                  }}
                  title={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
                >
                  {sortColumn === 'amount' ? (
                    sortDirection === 'asc' ? (
                      <ArrowUp size={14} className="sort-icon active" />
                    ) : (
                      <ArrowDown size={14} className="sort-icon active" />
                    )
                  ) : (
                    <ArrowDown size={14} className="sort-icon" />
                  )}
                </button>
              )}
              {/* For the Classification Path table we keep the UI ultra-simple:
                  no per-table filter dropdown, just the hierarchy view. */}
              {!isTaxonomyTable && (
                <div 
                  className="table-filter-wrapper" 
                  onClick={(e) => e.stopPropagation()} 
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button 
                    className={`table-filter-btn ${selectedFilterItems.size > 0 ? 'active' : ''}`}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      setShowFilterPanel(!showFilterPanel)
                    }}
                    title={selectedFilterItems.size > 0 ? `${selectedFilterItems.size} filter(s) active - Click to modify` : "Filter this table"}
                  >
                    <Filter size={14} />
                    {selectedFilterItems.size > 0 && (
                      <span className="filter-badge-count">{selectedFilterItems.size}</span>
                    )}
                  </button>
              
              {/* Filter Panel - Dropdown with Items */}
              {showFilterPanel && !collapsed && (
                <div 
                  className="table-filter-panel"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {/* Header */}
                  <div className="table-filter-header">
                    <h4 className="table-filter-title">Filter</h4>
                  </div>
                  
                  {/* Search Bar */}
                  <div className="table-filter-search">
                    <Search size={14} className="filter-search-icon" />
                    <input
                      type="text"
                      placeholder="Search items..."
                      value={tableSearchTerm ?? ''}
                      onChange={(e) => setTableSearchTerm(e.target.value)}
                      className="table-filter-input"
                      autoFocus
                      autoComplete="off"
                    />
                    {tableSearchTerm && (
                      <button 
                        className="table-filter-clear-btn"
                        onClick={() => setTableSearchTerm('')}
                        title="Clear search"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  
                  {/* Filter Items List - multi-select checkboxes; filter by search when typing */}
                  <div className="table-filter-items">
                    {tableSearchTerm && filteredOptions.length === 0 ? (
                      <div className="table-filter-empty">
                        <p>No items found</p>
                      </div>
                    ) : (
                      (tableSearchTerm ? filteredOptions : filterOptions).map((option) => {
                        const isSelected = selectedFilterItems.has(option)
                        return (
                          <label
                            key={option}
                            className={`table-filter-item ${isSelected ? 'selected' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleFilterItem(option)}
                            />
                            <span className="filter-item-label">{option}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
                  {/* Sort: ascending/descending to the right of filter */}
                  <button
                    type="button"
                    className="table-sort-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSort('amount')
                    }}
                    title={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
                  >
                    {sortColumn === 'amount' ? (
                      sortDirection === 'asc' ? (
                        <ArrowUp size={14} className="sort-icon active" />
                      ) : (
                        <ArrowDown size={14} className="sort-icon active" />
                      )
                    ) : (
                      <ArrowDown size={14} className="sort-icon" />
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="table-header-actions" onClick={(e) => e.stopPropagation()}>
          {/* Empty for now - filter moved to title section */}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Legend for hierarchy levels in the Classification Path tree */}
          {isTaxonomyTable && (
            <div className="taxonomy-level-toggle taxonomy-level-legend">
              <button
                type="button"
                className={`taxonomy-level-pill taxonomy-level-pill-l1 ${activeTaxonomyLevel === 1 ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveTaxonomyLevel(prev => (prev === 1 ? null : 1))
                }}
              >
                L1
              </button>
              <button
                type="button"
                className={`taxonomy-level-pill taxonomy-level-pill-l2 ${activeTaxonomyLevel === 2 ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveTaxonomyLevel(prev => (prev === 2 ? null : 2))
                }}
              >
                L2
              </button>
              <button
                type="button"
                className={`taxonomy-level-pill taxonomy-level-pill-l3 ${activeTaxonomyLevel === 3 ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveTaxonomyLevel(prev => (prev === 3 ? null : 3))
                }}
              >
                L3
              </button>
              <button
                type="button"
                className={`taxonomy-level-pill taxonomy-level-pill-l4 ${activeTaxonomyLevel === 4 ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveTaxonomyLevel(prev => (prev === 4 ? null : 4))
                }}
              >
                L4
              </button>
            </div>
          )}

          {/* Column Headers - sort moved to header bar right of filter */}
          <div className="table-column-headers">
            <div className="col-header name-col">
              {/* Empty - name column is implicit */}
            </div>
            <div className="col-header amount-col">
              {/* Amount column - sort control is in header bar */}
            </div>
          </div>
        </>
      )}
      
      {/* Table Content */}
      <div 
        ref={tableContentRef}
        className={`table-content ${collapsed ? 'collapsed' : ''}`}
      >
        {tableData.length === 0 ? (
          <div className="empty-table">
            <p>No data available</p>
          </div>
        ) : (
          <div className="table-rows">
            {effectiveHierarchical ? (
              <>
                {(() => {
                  // Choose base data: when a taxonomy level pill is active for the
                  // Classification Path table, use the flattened, globally sorted
                  // list; otherwise use the full hierarchical tree.
                  const usingFlattenedTaxonomy =
                    isTaxonomyTable && !!activeTaxonomyLevel
                  const baseData = usingFlattenedTaxonomy
                    ? displayedHierarchicalData
                    : tableData

                  // Apply filter based on selected items
                  const filteredData = baseData.filter(item => {
                    if (selectedFilterItems.size > 0) {
                      return selectedFilterItems.has(item.value) || 
                             (item.fullPath && selectedFilterItems.has(item.fullPath))
                    }
                    return true
                  })
                  // When using the flattened list for a specific taxonomy level,
                  // we don't want HierarchicalRow to apply an extra level filter,
                  // otherwise nothing will render (all rows are rendered at level 0).
                  const taxonomyLevelFilterProp =
                    usingFlattenedTaxonomy
                      ? null
                      : (isTaxonomyTable ? activeTaxonomyLevel : null)
                  return (
                    <>
                      {filteredData.map((item, idx) => (
                        <HierarchicalRow
                          key={`${item.fullPath || item.value}-${idx}`}
                          item={item}
                          level={0}
                          expandedNodes={expandedNodes}
                          toggleExpanded={toggleExpanded}
                          onSelect={onSelectRow}
                          isSelected={selectedRows?.includes(item.value)}
                          data={locallyFilteredData}
                          column={column}
                          taxonomyLevelFilter={taxonomyLevelFilterProp}
                          focusedPath={isTaxonomyTable ? focusedClassificationPath : null}
                        />
                      ))}
                    </>
                  )
                })()}
              </>
            ) : (
              <>
                {(() => {
                  return (
                    <>
                      {tableData.map((item, idx) => {
                        // Find transaction rows that match this value for reclassification
                        // Use locallyFilteredData to only find transactions that pass local filters
                        const matchingTransactions = locallyFilteredData.filter(t => {
                          const val = (t[column] || '').toString().trim() || 'Unknown'
                          const itemVal = (item.value || '').toString().trim() || 'Unknown'
                          return val === itemVal
                        })

                        const rowKey = `${column}:${item.value}`
                        const isSelected = selectedRows?.includes(rowKey)
                        const isKeyboardFocused = keyboardFocus === 'tables' && tableNav?.tableIndex === tableIndex && tableNav?.rowIndex === idx
                        return (
                          <DraggableTableRow
                            key={idx}
                            row={item.value}
                            column={column}
                            amount={item.amount}
                            isSelected={isSelected}
                            isKeyboardFocused={isKeyboardFocused}
                            onSelect={onSelectRow}
                            onToggleSelect={(val) => onToggleRowSelect && onToggleRowSelect(val, column)}
                            transactionRows={matchingTransactions}
                            isMultiSelectMode={tableSelectedRows.length > 0}
                            selectedRowsInTable={tableSelectedRows}
                            data={data}
                            rowRef={isKeyboardFocused ? focusedRowRef : null}
                          />
                        )
                      })}
                    </>
                  )
                })()}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const MultiTableSystem = ({ 
  transactions, 
  activeFilters, 
  setActiveFilters, 
  selectedRows, 
  setSelectedRows,
  mode,
  onSwitchToVisualizations,
  // Props from Dashboard
  filterState = {
    supplier: '',
    classificationL1: '',
    classificationL2: '',
    classificationL3: '',
    classificationL4: '',
    glDescription: '',
    company: '',
    year: '',
    quarter: '',
    month: '',
    costCenter: '',
    supplierCategory: '',
    country: '',
    clientSpendCategory: ''
  },
  setFilterState,
  tables = [],
  setTables,
  availableColumns = [],
  addTable,
  tableLocalFilters = {},
  setTableLocalFilters,
  onTableFiltersChange,
  clearAllTableFiltersRef,
  keyboardFocus,
  setKeyboardFocus,
  tableNav,
  setTableNav,
  onFocusedClassificationPathChange
}) => {
  const [showChartPanel, setShowChartPanel] = useState(false)
  const clearFiltersCallbacks = useRef(new Map())
  const tableFilterStates = useRef(new Map())
  const [focusedClassificationPath, setFocusedClassificationPath] = useState(null)

  const setFocusedPath = useCallback((path) => {
    setFocusedClassificationPath(path)
    if (onFocusedClassificationPathChange) onFocusedClassificationPathChange(path)
  }, [onFocusedClassificationPathChange])

  // Keep parent toolbar in sync with current classification path (for "Current classification" bar)
  useEffect(() => {
    if (onFocusedClassificationPathChange) {
      onFocusedClassificationPathChange(focusedClassificationPath)
    }
  }, [focusedClassificationPath, onFocusedClassificationPathChange])

  // Filter search term per table (lifted so it never resets on re-render)
  const [filterSearchByTableId, setFilterSearchByTableId] = useState({})

  // Expose clear all filters function
  const clearAllTableFilters = useCallback(() => {
    clearFiltersCallbacks.current.forEach(clearFn => {
      if (clearFn) clearFn()
    })
    tableFilterStates.current.clear()
    if (onTableFiltersChange) {
      onTableFiltersChange(false)
    }
  }, [onTableFiltersChange])
  
  // Expose clear function to parent via ref
  useEffect(() => {
    if (clearAllTableFiltersRef) {
      clearAllTableFiltersRef.current = clearAllTableFilters
    }
  }, [clearAllTableFilters, clearAllTableFiltersRef])

  const removeTable = (tableId) => {
    setTables(tables.filter(t => t.id !== tableId))
  }

  const setTableFilterSearch = useCallback((tableId, term) => {
    setFilterSearchByTableId(prev => ({ ...prev, [tableId]: term }))
  }, [])

  const toggleTableCollapse = (tableId) => {
    setTables(tables.map(t => 
      t.id === tableId ? { ...t, collapsed: !t.collapsed } : t
    ))
  }

  const handleDropFilter = (sourceColumn, sourceValue, targetColumn, targetTableId, allSelectedRows = null) => {
    // Apply filter locally to target table only, not globally
    // This ensures only the target table is affected by the drag-drop filter
    const filterValues = allSelectedRows && allSelectedRows.length > 1 ? allSelectedRows : [sourceValue]
    
    if (setTableLocalFilters) {
      setTableLocalFilters(prev => {
        const targetFilters = prev[targetTableId] || {}
        const existingValues = Array.isArray(targetFilters[sourceColumn]) 
          ? targetFilters[sourceColumn] 
          : targetFilters[sourceColumn] 
            ? [targetFilters[sourceColumn]] 
            : []
        
        const newValues = [...new Set([...existingValues, ...filterValues])]
        
        return {
          ...prev,
          [targetTableId]: {
            ...targetFilters,
            [sourceColumn]: newValues
          }
        }
      })
    }
    
    console.log(`Local filter applied to table ${targetTableId}: ${sourceColumn} = ${filterValues.length} value(s), viewing ${targetColumn}`)
  }
  
  // Clear local filters for a specific table
  const clearTableLocalFilters = useCallback((tableId) => {
    if (setTableLocalFilters) {
      setTableLocalFilters(prev => {
        const next = { ...prev }
        delete next[tableId]
        return next
      })
    }
  }, [setTableLocalFilters])
  
  // Clear all local filters
  const clearAllLocalFilters = useCallback(() => {
    if (setTableLocalFilters) {
      setTableLocalFilters({})
    }
  }, [setTableLocalFilters])

  // Clear all selected rows
  const clearSelection = useCallback(() => {
    setSelectedRows([])
  }, [])

  // Handle toggle row selection (for multi-select with Ctrl/Cmd+Click)
  const handleToggleRowSelect = useCallback((rowValue, column) => {
    const key = column ? `${column}:${rowValue}` : rowValue
    setSelectedRows(prev => {
      if (!column) {
        // No column specified - simple toggle
        if (prev.includes(key)) {
          return prev.filter(v => v !== key)
        } else {
          return [...prev, key]
        }
      }
      
      // Check if there are selections from a different table
      const currentTableSelections = prev.filter(v => {
        const [prevColumn] = v.split(':')
        return prevColumn === column
      })
      
      // If toggling from a different table, clear all previous selections first
      if (prev.length > 0 && currentTableSelections.length === 0) {
        // This is a toggle from a different table, clear all and start fresh
        return [key]
      }
      
      // Same table - allow multiple selections
      if (prev.includes(key)) {
        return prev.filter(v => v !== key)
      } else {
        return [...prev, key]
      }
    })
  }, [])


  // Get unique values for filter dropdowns
  const filterOptions = useMemo(() => {
    const confidences = new Set()
    const suppliers = new Set()
    const classifications = new Set()
    
    transactions.forEach(row => {
      const conf = (row.confidence || row.classification_confidence || 'high').toLowerCase()
      confidences.add(conf === 'h' ? 'high' : conf === 'm' ? 'medium' : conf === 'l' ? 'low' : conf)
      if (row.supplier_name) suppliers.add(row.supplier_name)
      if (row.classification_path) {
        const l1 = row.classification_path.split('|')[0]
        if (l1) classifications.add(l1.trim())
      }
    })
    
    return {
      confidences: Array.from(confidences).sort(),
      suppliers: Array.from(suppliers).sort().slice(0, 50), // Top 50
      classifications: Array.from(classifications).sort()
    }
  }, [transactions])

  // Base filtered transactions - apply global filters (from filter panel) EXCEPT
  // the per-level taxonomy filters (classificationL1–L4). We will apply those
  // separately so that the Classification Path table can always show the full
  // taxonomy while other tables respect the level filters.
  const baseFilteredTransactions = useMemo(() => {
    return transactions.filter(row => {
      // Apply global active filters (from filter panel) - OR logic within each column
      const passesActiveFilters = Object.entries(activeFilters).every(([key, value]) => {
        // Ignore legacy per-level classification filters here; we handle
        // all taxonomy filtering via filterState.classificationL1–L4 using
        // the full classification_path / taxonomy_path below.
        if (key === 'classification_l1' || key === 'classification_l2' || key === 'classification_l3' || key === 'classification_l4') {
          return true
        }
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
      
      // Apply advanced filters (from filter panel) - OR logic within each category,
      // but skip classificationL1–L4 in this base pass so the taxonomy table
      // always sees the full tree.
      if (Array.isArray(filterState.supplier) && filterState.supplier.length > 0) {
        if (!filterState.supplier.includes(row.supplier_name)) return false
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
  }, [transactions, activeFilters, filterState])

  // Transactions used for the Classification Path table: use the RAW transactions
  // so the full taxonomy always stays visible, regardless of any filters.
  const taxonomyTransactions = transactions

  // Transactions used for all other tables: apply the per-level taxonomy filters
  // so they respect clicks in the taxonomy tree.
  const filteredTransactions = useMemo(() => {
    return baseFilteredTransactions.filter(row => {
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

      return true
    })
  }, [baseFilteredTransactions, filterState])
  

  // Helper to toggle a value within an array (add if missing, remove if present)
  const toggleValueInArray = useCallback((arr, value) => {
    const safeArr = Array.isArray(arr) ? arr : []
    if (!value) return safeArr
    const set = new Set(safeArr)
    if (set.has(value)) {
      set.delete(value)
    } else {
      set.add(value)
    }
    return Array.from(set)
  }, [])

  const handleRowSelect = useCallback((rowValue, column = null) => {
    // Special behavior: when clicking in the taxonomy table (classification_path),
    // drive the global classification filters so other tables (supplier, spend category,
    // GL description, etc.) automatically update.
    //
    // IMPORTANT: We now filter **only by the level that was clicked** instead of
    // requiring the full path. For example:
    //   Non-Sourceable | Taxes and Regulatory Fees | Taxes and Regulatory Fees Other
    // Clicking that row adds just:
    //   classificationL3 = ['Taxes and Regulatory Fees Other']
    // and leaves L1/L2 empty, so you see all rows that have that L3 value,
    // regardless of their L1/L2 parents.
    if (column === 'classification_path' && typeof setFilterState === 'function' && rowValue) {
      const rowValueStr = rowValue.toString().trim()

      // Depth is how many levels are visible in the taxonomy table for this row
      const keyParts = rowValueStr
        .split('|')
        .map(p => p.trim())
        .filter(Boolean)
      const depth = keyParts.length

      // Find a transaction whose full path starts with this key
      const example = transactions.find(t => {
        const path = (t.classification_path || t.taxonomy_path || '').toString().trim()
        if (!path) return false
        return path === rowValueStr || path.startsWith(rowValueStr + '|')
      })

      const fullPath = example
        ? (example.classification_path || example.taxonomy_path || rowValueStr)
        : rowValueStr

      const parts = fullPath
        .toString()
        .split('|')
        .map(p => p.trim())
        .filter(Boolean)

      const [l1, l2, l3, l4] = parts

      // Decide which level we clicked (1–4) and the corresponding value.
      const clickedLevel = Math.min(Math.max(depth, 1), 4)
      let targetValue = ''
      if (clickedLevel === 1) targetValue = l1 || keyParts[0] || ''
      if (clickedLevel === 2) targetValue = l2 || keyParts[1] || ''
      if (clickedLevel === 3) targetValue = l3 || keyParts[2] || ''
      if (clickedLevel === 4) targetValue = l4 || keyParts[3] || ''

      setFilterState(prev => {
        return {
          ...prev,
          // For the clicked level, toggle the specific value on/off so you can
          // select multiple values at the same level without clearing first.
          classificationL1: clickedLevel === 1
            ? toggleValueInArray(prev.classificationL1, targetValue)
            : (prev.classificationL1 || []),
          classificationL2: clickedLevel === 2
            ? toggleValueInArray(prev.classificationL2, targetValue)
            : (prev.classificationL2 || []),
          classificationL3: clickedLevel === 3
            ? toggleValueInArray(prev.classificationL3, targetValue)
            : (prev.classificationL3 || []),
          classificationL4: clickedLevel === 4
            ? toggleValueInArray(prev.classificationL4, targetValue)
            : (prev.classificationL4 || []),
        }
      })
    }

    // Helper: get classification path for a supplier name from transactions
    const getPathForSupplier = (supplierName) => {
      if (!Array.isArray(transactions) || transactions.length === 0) return null
      const rowValueStr = (supplierName || '').toString().trim() || 'Unknown'
      const matchWithPath = transactions.find(t => {
        const raw = t.supplier_name
        const val = (raw !== null && raw !== undefined && String(raw).trim() !== '')
          ? String(raw).trim()
          : 'Unknown'
        if (val !== rowValueStr) return false
        const p = (t.classification_path || t.taxonomy_path || '').toString().trim()
        return p.length > 0
      })
      const match = matchWithPath || transactions.find(t => {
        const raw = t.supplier_name
        const val = (raw !== null && raw !== undefined && String(raw).trim() !== '')
          ? String(raw).trim()
          : 'Unknown'
        return val === rowValueStr
      })
      if (!match) return null
      const fromPath = (match.classification_path || match.taxonomy_path || '').toString().trim()
      const fromLevels = [match.L1, match.L2, match.L3, match.L4]
        .map(p => (p != null && p !== undefined ? String(p).trim() : ''))
        .filter(Boolean)
        .join('|')
      return fromPath || fromLevels || null
    }

    // Only when selecting a row from the Supplier table: infer its full classification path
    // and notify parent so the toolbar can show "Current classification" (no branching in tree).
    // When deselecting, show the path for the next-most-recently selected supplier (2nd in list).
    if (column === 'supplier_name' && rowValue) {
      const key = column ? `${column}:${rowValue}` : rowValue
      const isDeselecting = selectedRows && selectedRows.includes(key)
      if (isDeselecting) {
        const remaining = (selectedRows || []).filter(v => v !== key)
        const supplierKeys = remaining.filter(v => String(v).startsWith('supplier_name:'))
        const latestSupplierKey = supplierKeys.length > 0 ? supplierKeys[supplierKeys.length - 1] : null
        if (latestSupplierKey) {
          const supplierName = latestSupplierKey.replace(/^supplier_name:/, '')
          const path = getPathForSupplier(supplierName)
          if (path) setFocusedPath(path)
          else setFocusedPath(null)
        } else {
          setFocusedPath(null)
        }
      } else if (Array.isArray(transactions) && transactions.length > 0) {
        const rowValueStr = rowValue.toString().trim() || 'Unknown'
        const matchWithPath = transactions.find(t => {
          const raw = t[column]
          const val = (raw !== null && raw !== undefined && String(raw).trim() !== '')
            ? String(raw).trim()
            : 'Unknown'
          if (val !== rowValueStr) return false
          const p = (t.classification_path || t.taxonomy_path || '').toString().trim()
          return p.length > 0
        })
        const match = matchWithPath || transactions.find(t => {
          const raw = t[column]
          const val = (raw !== null && raw !== undefined && String(raw).trim() !== '')
            ? String(raw).trim()
            : 'Unknown'
          return val === rowValueStr
        })

        if (match) {
          const fromPath = (match.classification_path || match.taxonomy_path || '').toString().trim()
          const fromLevels = [match.L1, match.L2, match.L3, match.L4]
            .map(p => (p != null && p !== undefined ? String(p).trim() : ''))
            .filter(Boolean)
            .join('|')
          const fullPath = fromPath || fromLevels
          if (fullPath) setFocusedPath(fullPath)
        }
      }
    } else if (column && column !== 'classification_path') {
      setFocusedPath(null)
    }
    // If column is provided, create a unique key with column prefix
    const key = column ? `${column}:${rowValue}` : rowValue
    
    setSelectedRows(prev => {
      if (!column) {
        // No column specified - simple toggle
        if (prev.includes(key)) {
          return prev.filter(v => v !== key)
        } else {
          return [...prev, key]
        }
      }
      
      // Check if there are selections from a different table
      const currentTableSelections = prev.filter(v => {
        const [prevColumn] = v.split(':')
        return prevColumn === column
      })
      
      // If selecting from a different table, clear all previous selections first
      if (prev.length > 0 && currentTableSelections.length === 0) {
        // This is a selection from a different table
        // Clear all previous selections and start fresh with this selection
        return [key]
      }
      
      // Same table - allow multiple selections
      // Toggle selection - if already selected, deselect
      if (prev.includes(key)) {
        return prev.filter(v => v !== key)
      } else {
        return [...prev, key]
      }
    })
  }, [selectedRows])

  // Get current table's data for keyboard navigation
  const getCurrentTableData = useCallback(() => {
    if (!tables || tables.length === 0 || tableNav.tableIndex >= tables.length) return []
    const currentTable = tables[tableNav.tableIndex]
    if (!currentTable) return []
    
    // Choose the right transaction set: taxonomy table ignores per-level filters
    const sourceTransactions = currentTable.column === 'classification_path'
      ? taxonomyTransactions
      : filteredTransactions

    // Get filtered data for this table
    const tableData = sourceTransactions.filter(row => {
      // Apply local filters for this table
      const localFiltersForTable = tableLocalFilters[currentTable.id] || {}
      return Object.entries(localFiltersForTable).every(([key, value]) => {
        if (!value) return true
        if (Array.isArray(value)) {
          const rowVal = (row[key] || '').toString().trim()
          return value.some(v => {
            const filterVal = (v || '').toString().trim()
            return rowVal === filterVal
          })
        }
        const rowVal = (row[key] || '').toString().trim()
        const filterVal = (value || '').toString().trim()
        return rowVal === filterVal
      })
    })
    
    // Group by column value (similar to FilterTable logic)
    const grouped = tableData.reduce((acc, row) => {
      const rawValue = row[currentTable.column]
      const value = (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') 
        ? String(rawValue).trim() 
        : 'Unknown'
      const amount = parseFloat(row.amount || row.invoice_amount || 0) || 0
      acc[value] = (acc[value] || 0) + amount
      return acc
    }, {})
    
    return Object.entries(grouped)
      .map(([value, amount]) => ({ value, amount }))
      .filter(item => item.amount > 0)
      .sort((a, b) => b.amount - a.amount)
  }, [tables, tableNav.tableIndex, filteredTransactions, taxonomyTransactions, tableLocalFilters])

  // Handle keyboard navigation in tables
  const handleTableKeyboardNav = useCallback((direction) => {
    if (keyboardFocus !== 'tables') return
    
    const currentTableData = getCurrentTableData()
    if (currentTableData.length === 0) return
    
    setTableNav(prev => {
      let newTableIndex = prev.tableIndex
      let newRowIndex = prev.rowIndex
      
      switch (direction) {
        case 'up':
          if (newRowIndex > 0) {
            newRowIndex = newRowIndex - 1
          }
          break
        case 'down':
          if (newRowIndex < currentTableData.length - 1) {
            newRowIndex = newRowIndex + 1
          } else {
            // At last row, go back to tree
            setKeyboardFocus('tree')
            return prev
          }
          break
        case 'right':
          if (newTableIndex < tables.length - 1) {
            newTableIndex = newTableIndex + 1
            newRowIndex = 0 // Reset to first row in new table
          }
          break
        case 'left':
          if (newTableIndex > 0) {
            newTableIndex = newTableIndex - 1
            newRowIndex = 0 // Reset to first row in new table
          }
          break
        default:
          return prev
      }
      
      return { tableIndex: newTableIndex, rowIndex: newRowIndex }
    })
  }, [keyboardFocus, getCurrentTableData, tables.length, setKeyboardFocus])

  // Handle Enter to select row
  const handleTableEnter = useCallback(() => {
    if (keyboardFocus !== 'tables') return
    
    const currentTableData = getCurrentTableData()
    if (currentTableData.length === 0) return
    
    const currentRow = currentTableData[tableNav.rowIndex]
    if (!currentRow) return
    
    const currentTable = tables[tableNav.tableIndex]
    if (!currentTable) return
    
    // Select the row
    handleRowSelect(currentRow.value, currentTable.column)
    
    // Move to next row for multi-select
    if (tableNav.rowIndex < currentTableData.length - 1) {
      setTableNav(prev => ({ ...prev, rowIndex: prev.rowIndex + 1 }))
    }
  }, [keyboardFocus, getCurrentTableData, tableNav, tables, handleRowSelect])

  // Handle Ctrl+F to apply selected rows as filters
  const handleApplyFilters = useCallback(() => {
    if (keyboardFocus !== 'tables') return
    
    const currentTable = tables[tableNav.tableIndex]
    if (!currentTable) return
    
    // Get selected rows from previous table (if any)
    const selectedRowKeys = selectedRows.filter(key => {
      const [column] = key.split(':')
      return column !== currentTable.column // Different column = from different table
    })
    
    if (selectedRowKeys.length === 0) {
      console.log('No rows selected from other tables')
      return
    }
    
    // Extract values from selected row keys
    const selectedValues = selectedRowKeys.map(key => {
      const [, ...rest] = key.split(':')
      return rest.join(':')
    })
    
    // Get the source column from the first selected row
    const [sourceColumn] = selectedRowKeys[0].split(':')
    
    // Apply as local filters to current table
    if (setTableLocalFilters) {
      setTableLocalFilters(prev => {
        const targetFilters = prev[currentTable.id] || {}
        const existingValues = Array.isArray(targetFilters[sourceColumn]) 
          ? targetFilters[sourceColumn] 
          : targetFilters[sourceColumn] 
            ? [targetFilters[sourceColumn]] 
            : []
        
        const newValues = [...new Set([...existingValues, ...selectedValues])]
        
        return {
          ...prev,
          [currentTable.id]: {
            ...targetFilters,
            [sourceColumn]: newValues
          }
        }
      })
    }
    
    console.log(`Applied ${selectedValues.length} selected rows as filters to table ${currentTable.id}`)
  }, [keyboardFocus, tableNav.tableIndex, tables, selectedRows, setTableLocalFilters])

  useKeyboardShortcuts({
    'ctrl+d': (e) => {
      if (e.shiftKey) {
        setActiveFilters({})
        setSelectedRows([])
      }
    },
    'ctrl+shift+c': () => {
      setSelectedRows([])
    },
    'escape': () => {
      setSelectedRows([])
    },
    // Table navigation
    'arrowup': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('up')
      }
    },
    'cmd+arrowup': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        // Cmd + Up: Jump to previous table
        setTableNav(prev => {
          if (prev.tableIndex > 0) {
            return { tableIndex: prev.tableIndex - 1, rowIndex: 0 }
          }
          return prev
        })
      }
    },
    'ctrl+arrowup': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        // Ctrl + Up: Jump to previous table
        setTableNav(prev => {
          if (prev.tableIndex > 0) {
            return { tableIndex: prev.tableIndex - 1, rowIndex: 0 }
          }
          return prev
        })
      }
    },
    'arrowdown': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('down')
      }
    },
    'cmd+arrowdown': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        // Cmd + Down: Jump to next table
        setTableNav(prev => {
          if (prev.tableIndex < tables.length - 1) {
            return { tableIndex: prev.tableIndex + 1, rowIndex: 0 }
          }
          return prev
        })
      }
    },
    'ctrl+arrowdown': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        // Ctrl + Down: Jump to next table
        setTableNav(prev => {
          if (prev.tableIndex < tables.length - 1) {
            return { tableIndex: prev.tableIndex + 1, rowIndex: 0 }
          }
          return prev
        })
      }
    },
    'arrowright': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('right')
      }
    },
    'arrowleft': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('left')
      }
    },
    'enter': (e) => {
      if (keyboardFocus === 'tables' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault()
        handleTableEnter()
      }
    },
    'ctrl+k': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleApplyFilters()
      }
    },
    'cmd+k': (e) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleApplyFilters()
      }
    }
  })

  return (
    <>
      {/* Kanban Board - Horizontally Scrollable */}
      <div className="kanban-board">
        <div className="kanban-container">
          {tables.map((table, index) => (
              <FilterTable
              key={table.id}
              tableId={table.id}
              title={table.title}
              column={table.column}
              data={table.column === 'classification_path' ? taxonomyTransactions : filteredTransactions}
              activeFilters={activeFilters}
              localFilters={tableLocalFilters[table.id] || {}}
              onClose={table.column === 'classification_path' ? undefined : removeTable}
              onDropFilter={handleDropFilter}
              onClearLocalFilters={() => clearTableLocalFilters(table.id)}
              selectedRows={selectedRows}
              onSelectRow={(val) => handleRowSelect(val, table.column)}
              onToggleRowSelect={handleToggleRowSelect}
              isHierarchical={table.isHierarchical}
              collapsed={table.collapsed}
              onToggleCollapse={() => toggleTableCollapse(table.id)}
              keyboardFocus={keyboardFocus}
              tableNav={tableNav}
              tableIndex={index}
              focusedClassificationPath={null}
              filterSearchTerm={filterSearchByTableId[table.id] ?? ''}
              onFilterSearchChange={(term) => setTableFilterSearch(table.id, term)}
              onFiltersChange={(tableId, hasFilters) => {
                // Update filter state tracking
                if (hasFilters) {
                  tableFilterStates.current.set(tableId, true)
                } else {
                  tableFilterStates.current.delete(tableId)
                }
                
                // Check if any table has filters
                const anyHasFilters = tableFilterStates.current.size > 0
                if (onTableFiltersChange) {
                  onTableFiltersChange(anyHasFilters)
                }
              }}
              clearFiltersRef={(clearFn) => {
                if (clearFn) {
                  clearFiltersCallbacks.current.set(table.id, clearFn)
                } else {
                  clearFiltersCallbacks.current.delete(table.id)
                }
              }}
            />
          ))}
        </div>
      </div>
    </>
  )
}

export default MultiTableSystem

