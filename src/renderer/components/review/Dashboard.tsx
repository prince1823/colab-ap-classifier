import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDragDropManager } from 'react-dnd'
import MultiTableSystem from './MultiTableSystem'
import ClassificationTree from './ClassificationTree'
import ReclassifyConfirmModal from './ReclassifyConfirmModal'
import { Table, X, ChevronDown, Plus, CheckCircle, BarChart3 } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import MetricsTab from './MetricsTab'
import { useReviewFilterContext } from './ReviewFilterContext'
import { useGroupedTransactions } from '../../hooks/useGroupedTransactions'
import { useReclassification } from '../../hooks/useReclassification'
import { useUndoRedo } from '../../hooks/useUndoRedo'
import type { TransactionFilter, FilterCondition } from '../../../shared/types/transactions'
import type { DashboardTransactionRow } from '../../utils/transactionTransform'
import '../../styles/Dashboard.css'
import '../../styles/Tabs.css'

interface DashboardProps {
  transactions: DashboardTransactionRow[];
  loading: boolean;
  error: string | null;
  datasetId: string | null;
  setDatasetId: (id: string | null) => void;
  foldername: string | null;
  setFoldername: (name: string | null) => void;
  refreshTransactions: (() => Promise<void>) | null;
}

const Dashboard = ({ transactions, loading, error, datasetId, setDatasetId, foldername, setFoldername, refreshTransactions }: DashboardProps) => {
  const [activeTab, setActiveTab] = useState('tables') // 'tables'

  // ── Filter state (survives tab navigation, resets on project close via provider key) ──
  const { filters: reviewFilters, setFilters: setReviewFilters } = useReviewFilterContext()

  const activeFilters = reviewFilters.activeFilters
  const filterCombinator = reviewFilters.filterCombinator
  const filterConnectors = reviewFilters.filterConnectors
  const filterGroupOperators = reviewFilters.filterGroupOperators
  const showFilterPanel = reviewFilters.showFilterPanel

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

  // ── Table/selection state ──
  const selectedRows = reviewFilters.selectedRows || []
  const setSelectedRows = useCallback((updater: ((prev: string[]) => string[]) | string[]) => {
    setReviewFilters(prev => ({ selectedRows: typeof updater === 'function' ? updater(prev.selectedRows || []) : updater }))
  }, [setReviewFilters])

  const [reclassToast, setReclassToast] = useState<{ show: boolean; rowCount: number; targetPath: string; undoable: boolean }>({ show: false, rowCount: 0, targetPath: '', undoable: false })
  const reclassToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showDashboardModal, setShowDashboardModal] = useState(false)
  const [pendingReclassification, setPendingReclassification] = useState<{ rows: any[]; targetPath: string } | null>(null)

  // ── Hooks ──
  // Use ref for refetchGrouped since it's declared later (after useGroupedTransactions)
  const refetchGroupedRef = useRef<() => void>(() => {})
  const { reclassify, isReclassifying } = useReclassification({
    onSuccess: async () => {
      if (refreshTransactions) await refreshTransactions()
      refetchGroupedRef.current()
    },
  })
  const undoRedo = useUndoRedo({
    onUndoRedo: async () => {
      if (refreshTransactions) await refreshTransactions()
      refetchGroupedRef.current()
    },
  })

  // Keyboard navigation state - coordinates between tree and tables
  const [keyboardFocus, setKeyboardFocus] = useState('tree') // 'tree' or 'tables'
  const [tableNav, setTableNav] = useState({ tableIndex: 0, rowIndex: 0 }) // Current table and row position

  // Current classification path for the latest selected supplier (shown in toolbar left)
  const [focusedClassificationPath, setFocusedClassificationPath] = useState<string | null>(null)

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
  const setShowFilterPanel = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    setReviewFilters(prev => ({ showFilterPanel: typeof val === 'function' ? val(prev.showFilterPanel) : val }))
  }, [setReviewFilters])
  const [showAddTableMenu, setShowAddTableMenu] = useState(false)

  const [expandedFilters, setExpandedFilters] = useState<Set<string>>(new Set())
  const filterState = reviewFilters.filterState
  const setFilterState = useCallback((updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => {
    setReviewFilters(prev => ({ filterState: typeof updater === 'function' ? updater(prev.filterState) : updater }))
  }, [setReviewFilters])

  // ── Table config & local filters ──
  const tables = reviewFilters.tables
  const setTables = useCallback((updater: ((prev: typeof reviewFilters.tables) => typeof reviewFilters.tables) | typeof reviewFilters.tables) => {
    setReviewFilters(prev => ({ tables: typeof updater === 'function' ? updater(prev.tables) : updater }))
  }, [setReviewFilters])

  const tableLocalFilters = reviewFilters.tableLocalFilters
  const setTableLocalFilters = useCallback((updater: ((prev: typeof reviewFilters.tableLocalFilters) => typeof reviewFilters.tableLocalFilters) | typeof reviewFilters.tableLocalFilters) => {
    setReviewFilters(prev => ({ tableLocalFilters: typeof updater === 'function' ? updater(prev.tableLocalFilters) : updater }))
  }, [setReviewFilters])


  // ── Server-side grouped data (replaces client-side grouping for 4M+ rows) ──
  // Map filterState keys to backend column names
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

  // Convert activeFilters + filterState to TransactionFilter.conditions for server-side WHERE
  const serverSideFilter = useMemo<TransactionFilter | undefined>(() => {
    const conditions: FilterCondition[] = []
    const seenColumns = new Set<string>()

    // filterState entries (dropdown filters)
    Object.entries(filterState).forEach(([fsKey, fsValues]) => {
      if (!Array.isArray(fsValues) || fsValues.length === 0) return
      const col = fsKeyToCol[fsKey] || fsKey
      const connector = filterConnectors[col] || 'AND'
      conditions.push({ field: col, operator: 'in_list', value: fsValues.map(String), connector })
      seenColumns.add(col)
    })

    // activeFilters: { supplier_name: ["A", "B"], gl_description: ["X"] }
    Object.entries(activeFilters).forEach(([key, value]) => {
      if (!value || (Array.isArray(value) && value.length === 0)) return
      if (seenColumns.has(key)) return // already covered by filterState
      const values = Array.isArray(value) ? value : [value]
      conditions.push({ field: key, operator: 'in_list', value: values.map(String) })
    })

    if (conditions.length === 0) return undefined

    return { conditions }
  }, [activeFilters, filterState, filterConnectors, fsKeyToCol])

  // Columns to fetch grouped data for (all non-taxonomy table columns)
  const groupedColumns = useMemo(() => {
    return tables
      .filter(t => t.column !== 'classification_path')
      .map(t => t.column)
  }, [tables])

  // Server-side GROUP BY — re-runs when filters or tables change
  const { data: groupedData, refetch: refetchGrouped } = useGroupedTransactions(groupedColumns, serverSideFilter)
  refetchGroupedRef.current = refetchGrouped

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

  const addTable = (column: string) => {
    if (!column || !availableColumns.includes(column)) return

    const newTable = {
      id: `table-${Date.now()}`,
      title: column.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      column: column,
      isHierarchical: column.includes('classification') || column.includes('path') || column.includes('Level'),
      collapsed: false
    }
    setTables([...tables, newTable])
    setShowAddTableMenu(false)
  }

  // Filter options fetched from backend via distinctValues
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({
    suppliers: [], classificationsL1: [], classificationsL2: [],
    classificationsL3: [], classificationsL4: [], glDescriptions: [],
    companies: [], years: [], quarters: [], months: [],
    costCenters: [], countries: [], lineDescriptions: []
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

  // Sync filterState → activeFilters when filterState changes.
  // Uses a prev-snapshot ref to detect actual changes — prevents the useEffect
  // from wiping persisted activeFilters on remount (when store values haven't changed).
  const prevFilterStateRef = useRef(filterState)
  useEffect(() => {
    // Compare with previous filterState — only run if something actually changed
    const prev = prevFilterStateRef.current
    const changed = Object.keys(filterState).some(key => filterState[key] !== prev[key])
    prevFilterStateRef.current = filterState

    if (!changed) {
      return // Store values haven't changed — don't touch activeFilters
    }

    const newFilters: Record<string, string[]> = {}

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

    if (Array.isArray(filterState.country) && filterState.country.length > 0) {
      newFilters.country = filterState.country
    }

    if (Array.isArray(filterState.lineDescription) && filterState.lineDescription.length > 0) {
      newFilters.lineDescription = filterState.lineDescription
    }

    // Merge: keep existing activeFilters that don't come from filterState, add new ones

    setActiveFilters((prev: Record<string, string[]>) => {
      // Keys managed by filterState sync
      const fsKeys = ['supplier_name', 'gl_description', 'company', 'year', 'quarter', 'month', 'costCenter', 'country', 'lineDescription']
      // Keep non-filterState keys (e.g., double-click/drag-drop filters)
      const kept: Record<string, string[]> = {}
      Object.keys(prev).forEach((k: string) => {
        if (!fsKeys.includes(k)) kept[k] = prev[k]
      })
      return { ...kept, ...newFilters }
    })
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
      country: [],
      lineDescription: []
    })
    setActiveFilters({})
    setTableLocalFilters({})
    setFilterConnectors({})
    setFilterGroupOperators({})
    setSelectedRows([])
    setFocusedClassificationPath(null)
    setShowFilterPanel(false)
  }, [setActiveFilters])

  // Remove a single filter (from UI filters or drag/drop activeFilters)
  const removeFilter = useCallback((filterKey: string, valueToRemove: string | null = null) => {

    const clearSelectedForColumn = (columnKey: string, value: string | null) => {
      if (!columnKey) return
      setSelectedRows((prev: string[]) => {
        // If a specific value is removed, only clear that exact selection
        if (value !== null && value !== undefined) {
          const valueStr = (value || '').toString().trim()
          return prev.filter((k: string) => k !== `${columnKey}:${valueStr}`)
        }
        // Otherwise clear all selections for that column
        return prev.filter((k: string) => !k.startsWith(`${columnKey}:`))
      })
    }

    // Map filter UI keys / backend keys to table column keys used in `selectedRows` (column:value)
    const selectionColumnKeyMap: Record<string, string> = {
      // UI filterState keys
      supplier: 'supplier_name',
      glDescription: 'gl_description',
      lineDescription: 'line_description',
      country: 'country',
      company: 'company',
      costCenter: 'cost_center',
      year: 'year',
      quarter: 'quarter',
      month: 'month',
      // backend activeFilters keys (often same as column keys)
      supplier_name: 'supplier_name',
      gl_description: 'gl_description',
      line_description: 'line_description',
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
      'country',
      'lineDescription',
    ])

    if (uiKeys.has(filterKey)) {
      // Remove from filterState array
      if (valueToRemove !== null && valueToRemove !== undefined) {
        setFilterState((prev: Record<string, string[]>) => ({
          ...prev,
          [filterKey]: Array.isArray(prev[filterKey])
            ? prev[filterKey].filter((v: string) => v !== valueToRemove)
            : []
        }))
      } else {
        // Clear entire filter
        setFilterState((prev: Record<string, string[]>) => ({
          ...prev,
          [filterKey]: []
        }))
      }

      // Clear selection only for the related table column (not all)
      clearSelectedForColumn(selectionColumnKeyMap[filterKey], valueToRemove)
    } else {
      // Otherwise treat as backend/activeFilters key (e.g. supplier_name, gl_description)
      setActiveFilters((prev: Record<string, string[]>) => {
        const next: Record<string, string[]> = { ...prev }
        if (valueToRemove !== null && Array.isArray(next[filterKey])) {
          // Remove matching value (handle string comparison with trimming)
          const valueToRemoveStr = (valueToRemove || '').toString().trim()
          next[filterKey] = next[filterKey].filter((v: string) => {
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
  const handleToggleFilter = useCallback((filterKey: string, value: string) => {
    setFilterState((prev: Record<string, string[]>) => {
      const currentArray = Array.isArray(prev[filterKey]) ? prev[filterKey] : []
      if (currentArray.includes(value)) {
        return { ...prev, [filterKey]: currentArray.filter((v: string) => v !== value) }
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
            const toggleFilterExpand = (filterKey: string) => {
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

            const renderDropdownFilter = (filterKey: string, label: string, options: string[]) => {
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
                      {options.slice(0, 50).map((option: string) => {
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

  // Reclassification via hook → resolve taxonomy node → call reclassify → push undo
  const executeReclassification = useCallback(async (rows: any[], targetPath: string) => {
    if (rows.length === 0) return false

    try {
      const taxonomyNodes = await ipc.taxonomy.getNodes()
      const cleanPath = targetPath.replace(/^root\|/, '')
      const targetNode = taxonomyNodes.find((n) => n.fullPath === cleanPath)

      if (!targetNode) {
        console.warn(`[Reclassify] No taxonomy node found for path: ${cleanPath}`)
        return false
      }

      const transactionIds = rows.map((row) => row.id).filter((id) => id != null)
      if (transactionIds.length === 0) return false

      await ipc.transactions.update({
        ids: transactionIds,
        taxonomyNodeId: targetNode.id,
        classificationStatus: 'classified_by_ai',
      })

      // Push changelog entry for undo
      try {
        const changelog = await ipc.changelog.list()
        if (changelog.length > 0) {
          undoRedo.push({ type: 'reclassify', changelogId: changelog[0].id })
        }
      } catch (e) {
        console.warn('[Undo] Failed to capture changelog entry:', e)
      }

      // Refresh data from backend
      if (refreshTransactions) await refreshTransactions()
      refetchGroupedRef.current()

      // Show success toast
      const displayPath = cleanPath.replace(/\|/g, ' → ')
      if (reclassToastTimer.current) clearTimeout(reclassToastTimer.current)
      setReclassToast({ show: true, rowCount: transactionIds.length, targetPath: displayPath, undoable: true })
      reclassToastTimer.current = setTimeout(() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false }), 5000)

      return true
    } catch (err) {
      console.error('Failed to reclassify:', err)
      return false
    }
  }, [refreshTransactions, undoRedo])

  // Handle reclassification confirmation from the confirm modal
  const handleConfirmReclassify = useCallback(async () => {
    if (!pendingReclassification) return
    const { rows, targetPath } = pendingReclassification
    setPendingReclassification(null)
    await executeReclassification(rows, targetPath)
  }, [pendingReclassification, executeReclassification])

  // Remove local filter from a table (must be declared before any early return)
  const handleRemoveLocalFilter = useCallback((tableId: string, filterKey: string, value: string | null) => {

    setSelectedRows((prev: string[]) => {
      if (value !== null && value !== undefined) {
        const valueStr = (value || '').toString().trim()
        return prev.filter((k: string) => k !== `${filterKey}:${valueStr}`)
      }
      return prev.filter((k: string) => !k.startsWith(`${filterKey}:`))
    })
    setTableLocalFilters(prev => {
      const tableFilters = prev[tableId] || {}
      if (value !== null && Array.isArray(tableFilters[filterKey])) {
        const newValues = tableFilters[filterKey].filter((v: string) => {
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

  // Handle double-click on a table row to add as global filter
  const handleDoubleClickFilter = useCallback((column: string, values: string[]) => {
    if (!column || !values || values.length === 0) return


    // Map table column to the backend activeFilters key
    // For simple columns (supplier_name, gl_description, line_description, company), use directly
    const filterKey = column

    setActiveFilters((prev: Record<string, string[]>) => {
      const existing = Array.isArray(prev[filterKey]) ? prev[filterKey] : []
      const newValues = values
        .map((v: string) => v.trim())
        .filter((v: string) => v && !existing.includes(v))
      if (newValues.length === 0) return prev
      return { ...prev, [filterKey]: [...existing, ...newValues] }
    })
  }, [])

  // Handle adding a filter from the CurrentFiltersPanel "Add Filter" dropdown
  const handleAddFilter = useCallback((column: string, values: string[]) => {
    handleDoubleClickFilter(column, values)
  }, [handleDoubleClickFilter])

  // Apply all currently selected rows (across tables) as global filters
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
      Object.entries(byColumn).forEach(([column, values]: [string, string[]]) => {
        const existing = Array.isArray(next[column]) ? next[column] : next[column] ? [next[column]] : []
        next[column] = [...new Set([...existing, ...values])]
      })
      return next
    })
  }, [selectedRows])

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
    const matching = transactions.filter((row: DashboardTransactionRow) => {
      const raw = row[column]
      const rowVal = (raw !== null && raw !== undefined && String(raw).trim() !== '')
        ? String(raw).trim()
        : 'Unknown'
      return rowVal === normalizedValue
    })

    if (matching.length === 0) return null

    const first = matching[0]
    const supplier =
      String(first.supplier_name || first.supplierName || normalizedValue)

    const path = String(first.classification_path || first.taxonomy_path || '')
    let levels: string[] = []
    if (path) {
      levels = path.split('|').map((p: string) => p.trim()).filter(Boolean)
    } else {
      levels = [first.L1, first.L2, first.L3, first.L4].filter(Boolean) as string[]
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

  // If no transactions yet, show the loading spinner instead of an error.
  // Data may still be arriving via chunked loading.
  if (!transactions || transactions.length === 0) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading classification data...</p>
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
                {/* Classification status filter placeholder — TODO: add dropdown for status filtering */}
                <button
                  type="button"
                  className="compact-control dashboard-btn"
                  onClick={() => setShowDashboardModal(true)}
                  title="Open Dashboard"
                >
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
                            onClick={() => {
                              addTable(column)
                              setShowAddTableMenu(false)
                            }}
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

            <div className="tables-board-layout">
              <div className="tables-layout-container">
                {/* Multi-Table System (full width, sidebar removed) */}
                <div className="tables-section">
                  <MultiTableSystem
                    transactions={transactions}
                    allTransactions={transactions}
                    groupedData={groupedData}
                    activeFilters={activeFilters}
                    setActiveFilters={setActiveFilters as any}
                    selectedRows={selectedRows}
                    setSelectedRows={setSelectedRows as any}
                    filterState={filterState as any}
                    setFilterState={setFilterState as any}
                    tables={tables as any}
                    setTables={setTables as any}
                    onReorderTables={setTables as any}
                    availableColumns={availableColumns}
                    addTable={addTable}
                    tableLocalFilters={tableLocalFilters}
                    setTableLocalFilters={setTableLocalFilters as any}
                    filterCombinator={filterCombinator}
                    filterConnectors={filterConnectors}
                    filterGroupOperators={filterGroupOperators}
                    onSetFilterCombinator={setFilterCombinator as (val: string) => void}
                    onSetFilterConnector={(key: string, val: 'AND' | 'OR') => setFilterConnectors((prev: Record<string, 'AND' | 'OR'>) => ({ ...prev, [key]: val }))}
                    onSetFilterOperator={(key: string, val: string) => setFilterGroupOperators((prev: Record<string, string>) => ({ ...prev, [key]: val }))}
                    onRemoveFilter={removeFilter}
                    onRemoveLocalFilter={(tableId: string, _key: string | undefined, _value: string | null) => handleRemoveLocalFilter(tableId, _key || '', _value)}
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

              {/* Classification Tree */}
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
                    return await executeReclassification(rows, targetPath)
                  }}
                  mode="review"
                  datasetId={datasetId ?? undefined}
                  foldername={foldername ?? undefined}
                />
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Reclassify Confirm Modal */}
      {pendingReclassification && (
        <ReclassifyConfirmModal
          rowCount={pendingReclassification.rows.length}
          targetPath={pendingReclassification.targetPath}
          onConfirm={handleConfirmReclassify}
          onCancel={() => setPendingReclassification(null)}
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
                filteredTransactions={transactions}
                onDrillToFilters={(filters: Record<string, string[]>) => {
                  setFilterState((prev: Record<string, string[]>) => {
                    const next: Record<string, string[]> = { ...prev }
                    if (filters.supplier) next.supplier = filters.supplier
                    if (filters.classificationL1) next.classificationL1 = filters.classificationL1
                    if (filters.glDescription) next.glDescription = filters.glDescription
                    if (filters.company) next.company = filters.company
                    if (filters.costCenter) next.costCenter = filters.costCenter
                    if (filters.country) next.country = filters.country
                    return next
                  })
                  setShowDashboardModal(false)
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* Reclassification Success Toast */}
      {reclassToast.show && createPortal(
        <div className="reclass-toast">
          <CheckCircle size={16} />
          <span>
            Reclassified <strong>{reclassToast.rowCount}</strong> row{reclassToast.rowCount !== 1 ? 's' : ''} → <strong>{reclassToast.targetPath}</strong>
          </span>
          {reclassToast.undoable && <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '8px' }}>Ctrl+Z to undo</span>}
          <button className="reclass-toast-close" onClick={() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false })}>
            <X size={14} />
          </button>
        </div>,
        document.body
      )}

    </div>
  )
}

export default Dashboard
