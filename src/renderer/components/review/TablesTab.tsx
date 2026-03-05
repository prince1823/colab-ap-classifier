import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useDragDropManager } from 'react-dnd'
import MultiTableSystem from './MultiTableSystem'
import ClassificationTree from './ClassificationTree'
import { X, ChevronDown, Plus, BarChart3 } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import { useReviewFilterContext } from './ReviewFilterContext'
import { useGroupedTransactions } from '../../hooks/useGroupedTransactions'
import type { TransactionFilter, FilterCondition } from '../../../shared/types/transactions'
import type { DashboardTransactionRow } from '../../utils/transactionTransform'
import '../../styles/Dashboard.css'
import '../../styles/Tabs.css'

interface TablesTabProps {
  transactions: DashboardTransactionRow[]
  datasetId?: string
  foldername?: string
  onReclassify: (rows: Record<string, unknown>[], targetPath: string) => Promise<boolean>
  onOpenMetrics: () => void
  onRegisterRefetchGrouped: (fn: () => void) => void
}

const TablesTab: React.FC<TablesTabProps> = ({
  transactions,
  datasetId,
  foldername,
  onReclassify,
  onOpenMetrics,
  onRegisterRefetchGrouped,
}) => {
  // ── Filter state from context ──
  const { filters: reviewFilters, setFilters: setReviewFilters } = useReviewFilterContext()

  const activeFilters = reviewFilters.activeFilters
  const filterCombinator = reviewFilters.filterCombinator
  const filterConnectors = reviewFilters.filterConnectors
  const filterGroupOperators = reviewFilters.filterGroupOperators
  const showFilterPanel = reviewFilters.showFilterPanel
  const filterState = reviewFilters.filterState
  const tables = reviewFilters.tables
  const selectedRows = reviewFilters.selectedRows || []

  const setActiveFilters = useCallback((updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => {
    setReviewFilters(prev => ({ activeFilters: typeof updater === 'function' ? updater(prev.activeFilters) : updater }))
  }, [setReviewFilters])

  const setFilterCombinator = useCallback((val: 'AND' | 'OR') => {
    setReviewFilters({ filterCombinator: val })
  }, [setReviewFilters])

  const setFilterConnectors = useCallback((updater: ((prev: Record<string, 'AND' | 'OR'>) => Record<string, 'AND' | 'OR'>) | Record<string, 'AND' | 'OR'>) => {
    setReviewFilters(prev => ({ filterConnectors: typeof updater === 'function' ? updater(prev.filterConnectors) : updater }))
  }, [setReviewFilters])

  const setFilterGroupOperators = useCallback((updater: ((prev: Record<string, string>) => Record<string, string>) | Record<string, string>) => {
    setReviewFilters(prev => ({ filterGroupOperators: typeof updater === 'function' ? updater(prev.filterGroupOperators) : updater }))
  }, [setReviewFilters])

  const setSelectedRows = useCallback((updater: ((prev: string[]) => string[]) | string[]) => {
    setReviewFilters(prev => ({ selectedRows: typeof updater === 'function' ? updater(prev.selectedRows || []) : updater }))
  }, [setReviewFilters])

  const setShowFilterPanel = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    setReviewFilters(prev => ({ showFilterPanel: typeof val === 'function' ? val(prev.showFilterPanel) : val }))
  }, [setReviewFilters])

  const setFilterState = useCallback((updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => {
    setReviewFilters(prev => ({ filterState: typeof updater === 'function' ? updater(prev.filterState) : updater }))
  }, [setReviewFilters])

  const setTables = useCallback((updater: ((prev: typeof reviewFilters.tables) => typeof reviewFilters.tables) | typeof reviewFilters.tables) => {
    setReviewFilters(prev => ({ tables: typeof updater === 'function' ? updater(prev.tables) : updater }))
  }, [setReviewFilters])

  // ── Local UI state ──
  const [showAddTableMenu, setShowAddTableMenu] = useState(false)
  const [expandedFilters, setExpandedFilters] = useState<Set<string>>(new Set())
  const [keyboardFocus, setKeyboardFocus] = useState<'tree' | 'tables'>('tree')
  const [tableNav, setTableNav] = useState({ tableIndex: 0, rowIndex: 0 })
  const [focusedClassificationPath, setFocusedClassificationPath] = useState<string | null>(null)

  // ── Server-side grouped data ──
  const fsKeyToCol = useMemo<Record<string, string>>(() => ({
    supplier: 'supplier_name',
    classificationL1: 'classification_l1',
    classificationL2: 'classification_l2',
    classificationL3: 'classification_l3',
    classificationL4: 'classification_l4',
    glDescription: 'gl_description',
    lineDescription: 'line_description',
    company: 'company',
    year: 'year',
    quarter: 'quarter',
    month: 'month',
    costCenter: 'cost_center',
    country: 'country',
  }), [])

  const serverSideFilter = useMemo<TransactionFilter | undefined>(() => {
    const conditions: FilterCondition[] = []
    const seenColumns = new Set<string>()

    Object.entries(filterState).forEach(([fsKey, fsValues]) => {
      if (!Array.isArray(fsValues) || fsValues.length === 0) return
      const col = fsKeyToCol[fsKey] || fsKey
      const connector = filterConnectors[col] || 'AND'
      conditions.push({ field: col, operator: 'in_list', value: fsValues.map(String), connector })
      seenColumns.add(col)
    })

    Object.entries(activeFilters).forEach(([key, value]) => {
      if (!value || (Array.isArray(value) && value.length === 0)) return
      if (seenColumns.has(key)) return
      const values = Array.isArray(value) ? value : [value]
      conditions.push({ field: key, operator: 'in_list', value: values.map(String) })
    })

    return conditions.length > 0 ? { conditions } : undefined
  }, [activeFilters, filterState, filterConnectors, fsKeyToCol])

  const groupedColumns = useMemo(() => tables.map(t => t.column), [tables])

  const { data: groupedData, refetch: refetchGrouped } = useGroupedTransactions(groupedColumns, serverSideFilter)

  // Expose refetch to Dashboard so executeReclassification can call it
  useEffect(() => {
    onRegisterRefetchGrouped(refetchGrouped)
  }, [refetchGrouped, onRegisterRefetchGrouped])

  // ── Available columns for Add Table ──
  const availableColumns = useMemo(() => {
    if (transactions.length === 0) return []
    const cols = Object.keys(transactions[0])
    return cols.filter(col => {
      const exclude = ['row_index', 'id', '_id']
      return !exclude.includes(col) && !tables.find(t => t.column === col)
    })
  }, [transactions, tables])

  const addTable = (column: string) => {
    if (!column || !availableColumns.includes(column)) return
    const newTable = {
      id: `table-${Date.now()}`,
      title: column.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      column,
      isHierarchical: column.includes('classification') || column.includes('path') || column.includes('Level'),
      collapsed: false,
    }
    setTables([...tables, newTable])
    setShowAddTableMenu(false)
  }

  // ── Filter options (distinct values for the filter panel) ──
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({
    suppliers: [], classificationsL1: [], classificationsL2: [],
    classificationsL3: [], classificationsL4: [], glDescriptions: [],
    companies: [], years: [], quarters: [], months: [],
    costCenters: [], countries: [], lineDescriptions: [],
  })

  const txnLength = transactions.length
  useEffect(() => {
    if (txnLength === 0) return
    const fetchDistinct = async () => {
      try {
        const [suppliers, l1, l2, l3, glDescriptions, companies, years, quarters, months, costCenters, countries, lineDescriptions] = await Promise.all([
          ipc.transactions.distinctValues('supplier_name', 50),
          ipc.transactions.distinctValues('L1'),
          ipc.transactions.distinctValues('L2'),
          ipc.transactions.distinctValues('L3'),
          ipc.transactions.distinctValues('gl_description', 50),
          ipc.transactions.distinctValues('company'),
          ipc.transactions.distinctValues('year'),
          ipc.transactions.distinctValues('quarter'),
          ipc.transactions.distinctValues('month'),
          ipc.transactions.distinctValues('cost_center', 50),
          ipc.transactions.distinctValues('country'),
          ipc.transactions.distinctValues('line_description', 50),
        ])
        setFilterOptions({
          suppliers, classificationsL1: l1, classificationsL2: l2,
          classificationsL3: l3, classificationsL4: [],
          glDescriptions, companies, years, quarters, months,
          costCenters, countries, lineDescriptions,
        })
      } catch (err) {
        console.error('Failed to fetch filter options:', err)
      }
    }
    fetchDistinct()
  }, [txnLength])

  // ── filterState → activeFilters sync ──
  const prevFilterStateRef = useRef(filterState)
  useEffect(() => {
    const prev = prevFilterStateRef.current
    const changed = Object.keys(filterState).some(key => filterState[key] !== prev[key])
    prevFilterStateRef.current = filterState
    if (!changed) return

    const newFilters: Record<string, string[]> = {}
    if (Array.isArray(filterState.supplier) && filterState.supplier.length > 0) newFilters.supplier_name = filterState.supplier
    if (Array.isArray(filterState.glDescription) && filterState.glDescription.length > 0) newFilters.gl_description = filterState.glDescription
    if (Array.isArray(filterState.company) && filterState.company.length > 0) newFilters.company = filterState.company
    if (Array.isArray(filterState.year) && filterState.year.length > 0) newFilters.year = filterState.year
    if (Array.isArray(filterState.quarter) && filterState.quarter.length > 0) newFilters.quarter = filterState.quarter
    if (Array.isArray(filterState.month) && filterState.month.length > 0) newFilters.month = filterState.month
    if (Array.isArray(filterState.costCenter) && filterState.costCenter.length > 0) newFilters.costCenter = filterState.costCenter
    if (Array.isArray(filterState.country) && filterState.country.length > 0) newFilters.country = filterState.country
    if (Array.isArray(filterState.lineDescription) && filterState.lineDescription.length > 0) newFilters.lineDescription = filterState.lineDescription

    setActiveFilters((prev: Record<string, string[]>) => {
      const fsKeys = ['supplier_name', 'gl_description', 'company', 'year', 'quarter', 'month', 'costCenter', 'country', 'lineDescription']
      const kept: Record<string, string[]> = {}
      Object.keys(prev).forEach((k: string) => { if (!fsKeys.includes(k)) kept[k] = prev[k] })
      return { ...kept, ...newFilters }
    })
  }, [
    filterState.supplier, filterState.classificationL1, filterState.classificationL2,
    filterState.classificationL3, filterState.classificationL4, filterState.glDescription,
    filterState.company, filterState.year, filterState.quarter, filterState.month,
    filterState.costCenter, filterState.country, filterState.lineDescription,
  ])

  // ── Filter callbacks ──
  const clearFilters = useCallback(() => {
    setFilterState({
      supplier: [], classificationL1: [], classificationL2: [], classificationL3: [], classificationL4: [],
      glDescription: [], company: [], year: [], quarter: [], month: [], costCenter: [], country: [], lineDescription: [],
    })
    setActiveFilters({})
    setFilterConnectors({})
    setFilterGroupOperators({})
    setSelectedRows([])
    setFocusedClassificationPath(null)
    setShowFilterPanel(false)
  }, [setActiveFilters, setFilterConnectors, setFilterGroupOperators, setFilterState, setSelectedRows, setShowFilterPanel])

  const removeFilter = useCallback((filterKey: string, valueToRemove: string | null = null) => {
    const clearSelectedForColumn = (columnKey: string, value: string | null) => {
      if (!columnKey) return
      setSelectedRows((prev: string[]) => {
        if (value !== null && value !== undefined) {
          const valueStr = (value || '').toString().trim()
          return prev.filter((k: string) => k !== `${columnKey}:${valueStr}`)
        }
        return prev.filter((k: string) => !k.startsWith(`${columnKey}:`))
      })
    }

    const selectionColumnKeyMap: Record<string, string> = {
      supplier: 'supplier_name', glDescription: 'gl_description', lineDescription: 'line_description',
      country: 'country', company: 'company', costCenter: 'cost_center', year: 'year', quarter: 'quarter', month: 'month',
      supplier_name: 'supplier_name', gl_description: 'gl_description', line_description: 'line_description',
    }

    const uiKeys = new Set([
      'supplier', 'classificationL1', 'classificationL2', 'classificationL3', 'classificationL4',
      'glDescription', 'company', 'year', 'quarter', 'month', 'costCenter', 'country', 'lineDescription',
    ])

    if (uiKeys.has(filterKey)) {
      if (valueToRemove !== null) {
        setFilterState((prev: Record<string, string[]>) => ({
          ...prev,
          [filterKey]: Array.isArray(prev[filterKey]) ? prev[filterKey].filter((v: string) => v !== valueToRemove) : [],
        }))
      } else {
        setFilterState((prev: Record<string, string[]>) => ({ ...prev, [filterKey]: [] }))
      }
      clearSelectedForColumn(selectionColumnKeyMap[filterKey], valueToRemove)
    } else {
      setActiveFilters((prev: Record<string, string[]>) => {
        const next: Record<string, string[]> = { ...prev }
        if (valueToRemove !== null && Array.isArray(next[filterKey])) {
          const valueStr = (valueToRemove || '').toString().trim()
          next[filterKey] = next[filterKey].filter((v: string) => (v || '').toString().trim() !== valueStr)
          if (next[filterKey].length === 0) delete next[filterKey]
        } else if (valueToRemove !== null && next[filterKey]) {
          const currentValue = (next[filterKey] || '').toString().trim()
          const valueStr = (valueToRemove || '').toString().trim()
          if (currentValue === valueStr) delete next[filterKey]
        } else {
          delete next[filterKey]
        }
        return next
      })
      clearSelectedForColumn(selectionColumnKeyMap[filterKey] || filterKey, valueToRemove)
    }
  }, [setActiveFilters, setFilterState, setSelectedRows])

  const handleToggleFilter = useCallback((filterKey: string, value: string) => {
    setFilterState((prev: Record<string, string[]>) => {
      const currentArray = Array.isArray(prev[filterKey]) ? prev[filterKey] : []
      return currentArray.includes(value)
        ? { ...prev, [filterKey]: currentArray.filter((v: string) => v !== value) }
        : { ...prev, [filterKey]: [...currentArray, value] }
    })
  }, [setFilterState])

  const handleDoubleClickFilter = useCallback((column: string, values: string[]) => {
    if (!column || !values || values.length === 0) return
    setActiveFilters((prev: Record<string, string[]>) => {
      const existing = Array.isArray(prev[column]) ? prev[column] : []
      const newValues = values.map((v: string) => v.trim()).filter((v: string) => v && !existing.includes(v))
      if (newValues.length === 0) return prev
      return { ...prev, [column]: [...existing, ...newValues] }
    })
  }, [setActiveFilters])

  const handleAddFilter = useCallback((column: string, values: string[]) => {
    handleDoubleClickFilter(column, values)
  }, [handleDoubleClickFilter])

  const handleApplySelectionAsFilter = useCallback(() => {
    if (!selectedRows || selectedRows.length === 0) return
    const byColumn: Record<string, string[]> = {}
    selectedRows.forEach((key: string) => {
      const idx = key.indexOf(':')
      if (idx <= 0) return
      const col = key.slice(0, idx)
      const val = key.slice(idx + 1)
      if (!val.trim()) return
      if (!byColumn[col]) byColumn[col] = []
      if (!byColumn[col].includes(val)) byColumn[col].push(val)
    })
    setActiveFilters((prev: Record<string, string[]>) => {
      const next: Record<string, string[]> = { ...prev }
      Object.entries(byColumn).forEach(([col, vals]: [string, string[]]) => {
        const existing = Array.isArray(next[col]) ? next[col] : next[col] ? [next[col]] : []
        next[col] = [...new Set([...existing, ...vals])]
      })
      return next
    })
  }, [selectedRows, setActiveFilters])

  // ── currentSelection — used for the classification bar display ──
  const currentSelection = useMemo(() => {
    if (!selectedRows || selectedRows.length === 0 || !transactions || transactions.length === 0) return null
    const lastKey = selectedRows[selectedRows.length - 1]
    if (!lastKey) return null
    const [column, ...rest] = lastKey.split(':')
    const value = rest.join(':')
    if (!column || !value) return null

    const normalizedValue = value.toString().trim() || 'Unknown'
    const matching = transactions.filter((row: DashboardTransactionRow) => {
      const raw = row[column]
      const rowVal = (raw !== null && raw !== undefined && String(raw).trim() !== '') ? String(raw).trim() : 'Unknown'
      return rowVal === normalizedValue
    })
    if (matching.length === 0) return null

    const first = matching[0]
    const supplier = String(first.supplier_name || first.supplierName || normalizedValue)
    const path = String(first.classification_path || first.taxonomy_path || '')
    const levels = path
      ? path.split('|').map((p: string) => p.trim()).filter(Boolean)
      : ([first.L1, first.L2, first.L3, first.L4].filter(Boolean) as string[])

    if (levels.length === 0) return null
    return { supplier, count: matching.length, levels }
  }, [selectedRows, transactions])

  // ── Enable page scrolling when dragging ──
  const dragDropManager = useDragDropManager()
  useEffect(() => {
    const monitor = dragDropManager.getMonitor()
    let isDragging = false
    const unsubscribe = monitor.subscribeToStateChange(() => {
      const isCurrentlyDragging = monitor.isDragging()
      if (isCurrentlyDragging && !isDragging) {
        isDragging = true
        document.body.style.overflow = 'auto'
        document.documentElement.style.overflow = 'auto'
        document.body.classList.add('dragging-active')
        document.documentElement.classList.add('dragging-active')
      } else if (!isCurrentlyDragging && isDragging) {
        isDragging = false
        setTimeout(() => {
          document.body.classList.remove('dragging-active')
          document.documentElement.classList.remove('dragging-active')
        }, 100)
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

  // ── Filter panel ──
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
          {(() => {
            const toggleFilterExpand = (key: string) => {
              setExpandedFilters(prev => {
                const next = new Set(prev)
                next.has(key) ? next.delete(key) : next.add(key)
                return next
              })
            }

            const renderDropdownFilter = (filterKey: string, label: string, options: string[]) => {
              const currentSelected = Array.isArray(filterState[filterKey]) ? filterState[filterKey] : []
              const isExpanded = expandedFilters.has(filterKey)
              return (
                <div className="filter-dropdown-group" key={filterKey}>
                  <div className="filter-dropdown-header" onClick={() => toggleFilterExpand(filterKey)}>
                    <span className="filter-dropdown-label">{label}</span>
                    <ChevronDown size={16} className={`filter-chevron ${isExpanded ? 'expanded' : ''}`} />
                  </div>
                  {isExpanded && (
                    <div className="filter-select-multiple-wrapper">
                      {options.slice(0, 50).map((option: string) => {
                        const isSelected = currentSelected.includes(option)
                        return (
                          <div key={option} className={`filter-option ${isSelected ? 'selected' : ''}`} onClick={() => handleToggleFilter(filterKey, option)}>
                            <input type="checkbox" checked={isSelected} onChange={() => handleToggleFilter(filterKey, option)} onClick={(e) => e.stopPropagation()} />
                            <span>{option}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {currentSelected.length > 0 && <div className="selected-count">{currentSelected.length} selected</div>}
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
                {renderDropdownFilter('country', 'Country', filterOptions.countries)}
                {renderDropdownFilter('lineDescription', 'Line Description', filterOptions.lineDescriptions)}
              </>
            )
          })()}
        </div>
        <div className="filter-panel-footer">
          <button className="btn-clear" onClick={clearFilters}>Clear All</button>
        </div>
      </div>
    </>
  ) : null

  return (
    <div className="tab-content tables-tab">
      {filterPanelContent}

      {/* Toolbar */}
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
            <span className="current-classification-placeholder" style={{ color: '#9ca3af', fontStyle: 'italic' }}>
              Unclassified (no classification assigned yet)
            </span>
          ) : (
            <span className="current-classification-placeholder">Select a supplier to see its current classification</span>
          )}
        </div>
        <div className="review-toolbar-actions">
          <button type="button" className="compact-control dashboard-btn" onClick={onOpenMetrics} title="Open Dashboard">
            <BarChart3 size={14} />
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
                      onClick={() => { addTable(column); setShowAddTableMenu(false) }}
                    >
                      {column.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tables + Classification Tree */}
      <div className="tables-board-layout">
        <div className="tables-layout-container">
          <div className="tables-section">
            <MultiTableSystem
              transactions={transactions}
              groupedData={groupedData}
              activeFilters={activeFilters}
              setActiveFilters={setActiveFilters}
              selectedRows={selectedRows}
              setSelectedRows={setSelectedRows}
              filterState={filterState}
              setFilterState={setFilterState}
              tables={tables}
              setTables={setTables}
              onReorderTables={setTables}
              availableColumns={availableColumns}
              addTable={addTable}
              filterCombinator={filterCombinator}
              filterConnectors={filterConnectors}
              filterGroupOperators={filterGroupOperators}
              onSetFilterCombinator={setFilterCombinator}
              onSetFilterConnector={(key: string, val: 'AND' | 'OR') => setFilterConnectors((prev: Record<string, 'AND' | 'OR'>) => ({ ...prev, [key]: val }))}
              onSetFilterOperator={(key: string, val: string) => setFilterGroupOperators((prev: Record<string, string>) => ({ ...prev, [key]: val }))}
              onRemoveFilter={removeFilter}
              onClearAll={clearFilters}
              onAddFilter={handleAddFilter}
              onDoubleClickFilter={handleDoubleClickFilter}
              onApplySelectionAsFilter={handleApplySelectionAsFilter}
              keyboardFocus={keyboardFocus}
              setKeyboardFocus={setKeyboardFocus}
              tableNav={tableNav}
              setTableNav={setTableNav}
              onFocusedClassificationPathChange={setFocusedClassificationPath}
            />
          </div>
        </div>

        <div className="classification-section">
          <ClassificationTree
            transactions={transactions}
            activeFilters={activeFilters}
            selectedRows={selectedRows}
            setSelectedRows={setSelectedRows}
            keyboardFocus={keyboardFocus}
            setKeyboardFocus={setKeyboardFocus}
            onReclassify={async (rows: Record<string, unknown>[], targetPath: string) => {
              if (!rows || rows.length === 0) return false
              return await onReclassify(rows, targetPath)
            }}
            mode="review"
            datasetId={datasetId}
            foldername={foldername}
          />
        </div>
      </div>
    </div>
  )
}

export default TablesTab
