import React, { useState, useMemo, useCallback, useEffect, useRef, useDeferredValue } from 'react'
import { createPortal } from 'react-dom'
import { useDragDropManager } from 'react-dnd'
import MultiTableSystem from './MultiTableSystem'
import ClassificationTree from './ClassificationTree'
import ReclassificationLoader from './ReclassificationLoader'
import SystemFeedbackModal from './SystemFeedbackModal'
import ReclassifyConfirmModal from './ReclassifyConfirmModal'
import { Table, X, ChevronDown, Sparkles, Plus, CheckCircle, BarChart3 } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import MetricsTab from './MetricsTab'
import { evaluateFilterConditions } from '../../utils/filterEvaluation'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useGroupedTransactions } from '../../hooks/useGroupedTransactions'
import type { TransactionFilter, ColumnFilter } from '../../../shared/types/transactions'
import '../../styles/Dashboard.css'
import '../../styles/Tabs.css'

const Dashboard = ({ transactions, loading, error, datasetId, setDatasetId, foldername, setFoldername, refreshTransactions, setTransactions }) => {
  const [activeTab, setActiveTab] = useState('tables') // 'tables'

  // ── Persisted filter state (survives tab navigation, resets on project close) ──
  const reviewFilters = useWorkflowStore(s => s.reviewFilters)
  const storeSetReviewFilters = useWorkflowStore(s => s.setReviewFilters)

  // Derive individual filter values from the store
  const activeFilters = reviewFilters.activeFilters
  const filterCombinator = reviewFilters.filterCombinator
  const filterConnectors = reviewFilters.filterConnectors
  const filterGroupOperators = reviewFilters.filterGroupOperators
  const showFilterPanel = reviewFilters.showFilterPanel

  // Setter wrappers that write to the store
  const setActiveFilters = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ activeFilters: updater(useWorkflowStore.getState().reviewFilters.activeFilters) })
    } else {
      storeSetReviewFilters({ activeFilters: updater })
    }
  }, [storeSetReviewFilters])

  const setFilterCombinator = useCallback((val: 'AND' | 'OR') => {
    storeSetReviewFilters({ filterCombinator: val })
  }, [storeSetReviewFilters])

  const setFilterConnectors = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ filterConnectors: updater(useWorkflowStore.getState().reviewFilters.filterConnectors) })
    } else {
      storeSetReviewFilters({ filterConnectors: updater })
    }
  }, [storeSetReviewFilters])

  const setFilterGroupOperators = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ filterGroupOperators: updater(useWorkflowStore.getState().reviewFilters.filterGroupOperators) })
    } else {
      storeSetReviewFilters({ filterGroupOperators: updater })
    }
  }, [storeSetReviewFilters])

  // ── Persisted table/selection state (survives tab navigation) ──
  const selectedRows = reviewFilters.selectedRows || []
  const setSelectedRows = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ selectedRows: updater(useWorkflowStore.getState().reviewFilters.selectedRows || []) })
    } else {
      storeSetReviewFilters({ selectedRows: updater })
    }
  }, [storeSetReviewFilters])

  const [isReclassifying, setIsReclassifying] = useState(false)
  const [reclassificationProgress, setReclassificationProgress] = useState({ current: 0, total: 0 })

  // System feedback generation
  const [systemFeedbackEnabled, setSystemFeedbackEnabled] = useState(false)
  const [feedbackSuggestions, setFeedbackSuggestions] = useState([])
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)
  const [reclassificationHistory, setReclassificationHistory] = useState(new Map()) // Track row reclassification history
  const [showFeedbackNotification, setShowFeedbackNotification] = useState(false)
  const [newFeedbackCount, setNewFeedbackCount] = useState(0)
  const [highlightFeedback, setHighlightFeedback] = useState(false)
  const [reclassToast, setReclassToast] = useState<{ show: boolean; rowCount: number; targetPath: string; undoable: boolean }>({ show: false, rowCount: 0, targetPath: '', undoable: false })
  const reclassToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showDashboardModal, setShowDashboardModal] = useState(false)
  const [pendingReclassification, setPendingReclassification] = useState<{ rows: any[]; targetPath: string } | null>(null)

  // ── Undo / Redo stacks ──
  type UndoEntry =
    | { type: 'filter'; activeFilters: any; selectedRows: any[]; tableLocalFilters: any; filterCombinator: 'AND' | 'OR'; filterConnectors: Record<string, 'AND' | 'OR'>; filterGroupOperators: Record<string, string> }
    | { type: 'reclassify'; changelogId: string }
    | { type: 'table'; tables: any[] }
  const MAX_UNDO_SIZE = 20
  const undoStackRef = useRef<UndoEntry[]>([])
  const redoStackRef = useRef<UndoEntry[]>([])
  const [undoToast, setUndoToast] = useState<{ show: boolean; message: string }>({ show: false, message: '' })
  const undoToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Cap a stack to MAX_UNDO_SIZE by dropping the oldest entries. */
  const capStack = (stack: UndoEntry[]) => {
    while (stack.length > MAX_UNDO_SIZE) stack.shift()
  }

  // Classification status filter (v2 — replaces review score filter)
  const [_classificationStatusFilter] = useState<string | null>(null)

  // Keyboard navigation state - coordinates between tree and tables
  const [keyboardFocus, setKeyboardFocus] = useState('tree') // 'tree' or 'tables'
  const [tableNav, setTableNav] = useState({ tableIndex: 0, rowIndex: 0 }) // Current table and row position

  // Current classification path for the latest selected supplier (shown in toolbar left)
  const [focusedClassificationPath, setFocusedClassificationPath] = useState(null)

  // Refs to track current filter/selection state for undo snapshots
  const activeFiltersRef = useRef(activeFilters)
  const selectedRowsRef = useRef(selectedRows)
  const tableLocalFiltersRef = useRef({})
  const filterCombinatorRef = useRef(filterCombinator)
  const filterConnectorsRef = useRef(filterConnectors)
  const filterGroupOperatorsRef = useRef(filterGroupOperators)
  useEffect(() => { activeFiltersRef.current = activeFilters }, [activeFilters])
  useEffect(() => { selectedRowsRef.current = selectedRows }, [selectedRows])
  useEffect(() => { filterCombinatorRef.current = filterCombinator }, [filterCombinator])
  useEffect(() => { filterConnectorsRef.current = filterConnectors }, [filterConnectors])
  useEffect(() => { filterGroupOperatorsRef.current = filterGroupOperators }, [filterGroupOperators])

  // Ref for current tables state (synced after tables useState below)
  const tablesRef = useRef<any[]>([])

  /** Snapshot current filter state. */
  const snapshotFilter = useCallback((): UndoEntry => ({
    type: 'filter',
    activeFilters: { ...activeFiltersRef.current },
    selectedRows: [...selectedRowsRef.current],
    tableLocalFilters: JSON.parse(JSON.stringify(tableLocalFiltersRef.current)),
    filterCombinator: filterCombinatorRef.current,
    filterConnectors: { ...filterConnectorsRef.current },
    filterGroupOperators: { ...filterGroupOperatorsRef.current },
  }), [])

  /** Snapshot current tables state. */
  const snapshotTables = useCallback((): UndoEntry => ({
    type: 'table',
    tables: [...tablesRef.current],
  }), [])

  // Show a toast message for undo/redo
  const showUndoRedoToast = useCallback((message: string) => {
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current)
    setUndoToast({ show: true, message })
    undoToastTimer.current = setTimeout(() => setUndoToast({ show: false, message: '' }), 3000)
  }, [])

  // Ctrl+Z / Cmd+Z undo and Ctrl+Shift+Z / Cmd+Shift+Z redo handler
  useEffect(() => {
    const handleUndoRedo = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (!(e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) return

      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      const isRedo = e.shiftKey
      e.preventDefault()
      e.stopPropagation()

      if (isRedo) {
        // ── Redo ──
        const entry = redoStackRef.current.pop()
        if (!entry) {
          console.log('[Redo] Nothing to redo')
          return
        }
        console.log('[Redo] Re-applying:', entry.type)

        if (entry.type === 'filter') {
          // Push current state to undo before applying redo
          undoStackRef.current.push(snapshotFilter())
          capStack(undoStackRef.current)
          setActiveFilters(entry.activeFilters)
          setSelectedRows(entry.selectedRows)
          setTableLocalFilters(entry.tableLocalFilters)
          setFilterCombinator(entry.filterCombinator)
          setFilterConnectors(entry.filterConnectors || {})
          setFilterGroupOperators(entry.filterGroupOperators || {})
          showUndoRedoToast('Filter change redone')
        } else if (entry.type === 'table') {
          undoStackRef.current.push(snapshotTables())
          capStack(undoStackRef.current)
          setTables(entry.tables)
          showUndoRedoToast('Table change redone')
        } else if (entry.type === 'reclassify') {
          try {
            // Reverting the revert = redo
            const newRevertId = await ipc.changelog.revert(entry.changelogId)
            undoStackRef.current.push({ type: 'reclassify', changelogId: newRevertId })
            capStack(undoStackRef.current)
            if (refreshTransactions) await refreshTransactions()
            showUndoRedoToast('Reclassification redone')
          } catch (err) {
            console.error('[Redo] Failed:', err)
            redoStackRef.current.push(entry)
          }
        }
      } else {
        // ── Undo ──
        const entry = undoStackRef.current.pop()
        if (!entry) {
          console.log('[Undo] Nothing to undo')
          return
        }
        console.log('[Undo] Reverting:', entry.type)

        if (entry.type === 'filter') {
          // Push current state to redo before applying undo
          redoStackRef.current.push(snapshotFilter())
          capStack(redoStackRef.current)
          setActiveFilters(entry.activeFilters)
          setSelectedRows(entry.selectedRows)
          setTableLocalFilters(entry.tableLocalFilters)
          setFilterCombinator(entry.filterCombinator)
          setFilterConnectors(entry.filterConnectors || {})
          setFilterGroupOperators(entry.filterGroupOperators || {})
          showUndoRedoToast('Filter change undone')
        } else if (entry.type === 'table') {
          redoStackRef.current.push(snapshotTables())
          capStack(redoStackRef.current)
          setTables(entry.tables)
          showUndoRedoToast('Table change undone')
        } else if (entry.type === 'reclassify') {
          try {
            const newRevertId = await ipc.changelog.revert(entry.changelogId)
            // Push the revert entry to redo so Shift+Z can undo the undo
            redoStackRef.current.push({ type: 'reclassify', changelogId: newRevertId })
            capStack(redoStackRef.current)
            if (refreshTransactions) await refreshTransactions()
            showUndoRedoToast('Reclassification undone')
          } catch (err) {
            console.error('[Undo] Failed to revert:', err)
            undoStackRef.current.push(entry)
          }
        }
      }
    }
    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleUndoRedo, true)
    return () => window.removeEventListener('keydown', handleUndoRedo, true)
  }, [refreshTransactions, snapshotFilter, snapshotTables, showUndoRedoToast])

  // Push a UI filter snapshot to the undo stack (clears redo — new action)
  const pushFilterUndo = useCallback(() => {
    undoStackRef.current.push(snapshotFilter())
    capStack(undoStackRef.current)
    redoStackRef.current = [] // new action invalidates redo
  }, [snapshotFilter])

  // Wrapped setters that auto-snapshot before changes
  const setActiveFiltersWithUndo = useCallback((filtersOrUpdater: any) => {
    pushFilterUndo()
    setActiveFilters(filtersOrUpdater)
  }, [pushFilterUndo])

  const setSelectedRowsWithUndo = useCallback((rowsOrUpdater: any) => {
    pushFilterUndo()
    setSelectedRows(rowsOrUpdater)
  }, [pushFilterUndo])

  const setTableLocalFiltersWithUndo = useCallback((filtersOrUpdater: any) => {
    pushFilterUndo()
    setTableLocalFilters(filtersOrUpdater)
  }, [pushFilterUndo])

  const setTablesWithUndo = useCallback((tablesOrUpdater: any) => {
    undoStackRef.current.push(snapshotTables())
    capStack(undoStackRef.current)
    redoStackRef.current = [] // new action invalidates redo
    setTables(tablesOrUpdater)
  }, [snapshotTables])

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
  // showFilterPanel is persisted in the store (survives tab navigation)
  const setShowFilterPanel = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    if (typeof val === 'function') {
      storeSetReviewFilters({ showFilterPanel: val(useWorkflowStore.getState().reviewFilters.showFilterPanel) })
    } else {
      storeSetReviewFilters({ showFilterPanel: val })
    }
  }, [storeSetReviewFilters])
  const [showAddTableMenu, setShowAddTableMenu] = useState(false)

  const [expandedFilters, setExpandedFilters] = useState(new Set()) // Track which filters are expanded
  // filterState is persisted in the store (survives tab navigation)
  const filterState = reviewFilters.filterState
  const setFilterState = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ filterState: updater(useWorkflowStore.getState().reviewFilters.filterState) })
    } else {
      storeSetReviewFilters({ filterState: updater })
    }
  }, [storeSetReviewFilters])
  // ── Persisted table config & local filters (survives tab navigation) ──
  const tables = reviewFilters.tables || [
    { id: 'vendor', title: 'supplier_name', column: 'supplier_name', isHierarchical: false, collapsed: false },
    { id: 'commodity', title: 'line_description', column: 'line_description', isHierarchical: false, collapsed: false },
    { id: 'gl', title: 'gl_description', column: 'gl_description', isHierarchical: false, collapsed: false },
  ]
  const setTables = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ tables: updater(useWorkflowStore.getState().reviewFilters.tables) })
    } else {
      storeSetReviewFilters({ tables: updater })
    }
  }, [storeSetReviewFilters])
  useEffect(() => { tablesRef.current = tables }, [tables])
  // Per-table local filters - only applied to specific tables via drag-drop
  const tableLocalFilters = reviewFilters.tableLocalFilters || {}
  const setTableLocalFilters = useCallback((updater: any) => {
    if (typeof updater === 'function') {
      storeSetReviewFilters({ tableLocalFilters: updater(useWorkflowStore.getState().reviewFilters.tableLocalFilters || {}) })
    } else {
      storeSetReviewFilters({ tableLocalFilters: updater })
    }
  }, [storeSetReviewFilters])
  useEffect(() => { tableLocalFiltersRef.current = tableLocalFilters }, [tableLocalFilters])


  // ── Server-side grouped data (replaces client-side grouping for 4M+ rows) ──
  // Map filterState keys to backend column names
  const fsKeyToCol = useMemo(() => ({
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

  // Convert activeFilters + filterState to TransactionFilter.columnFilters for server-side WHERE
  // Passes per-pair filterConnectors to the backend for SQL-like AND/OR precedence
  const serverSideFilter = useMemo<TransactionFilter | undefined>(() => {
    const columnFilters: ColumnFilter[] = []
    const seenColumns = new Set<string>()

    // filterState entries (dropdown filters)
    Object.entries(filterState).forEach(([fsKey, fsValues]) => {
      if (!Array.isArray(fsValues) || fsValues.length === 0) return
      const col = fsKeyToCol[fsKey] || fsKey
      const op = filterGroupOperators[col] || 'is'
      columnFilters.push({ column: col, operator: op as ColumnFilter['operator'], values: fsValues.map(String) })
      seenColumns.add(col)
    })

    // activeFilters: { supplier_name: ["A", "B"], gl_description: ["X"] }
    Object.entries(activeFilters).forEach(([key, value]) => {
      if (!value || (Array.isArray(value) && value.length === 0)) return
      if (seenColumns.has(key)) return // already covered by filterState
      const values = Array.isArray(value) ? value : [value]
      const op = filterGroupOperators[key] || 'is'
      columnFilters.push({ column: key, operator: op as ColumnFilter['operator'], values: values.map(String) })
    })

    if (columnFilters.length === 0) return undefined

    // Pass per-pair connectors directly — backend builds SQL with AND/OR precedence
    return {
      columnFilters,
      filterCombinator: (filterCombinator as 'AND' | 'OR') || 'AND',
      filterConnectors: filterConnectors as Record<string, 'AND' | 'OR'>,
    }
  }, [activeFilters, filterState, filterGroupOperators, filterCombinator, filterConnectors, fsKeyToCol])

  // Columns to fetch grouped data for (all non-taxonomy table columns)
  const groupedColumns = useMemo(() => {
    return tables
      .filter(t => t.column !== 'classification_path')
      .map(t => t.column)
  }, [tables])

  // Server-side GROUP BY — re-runs when filters or tables change
  const { data: groupedData, refetch: refetchGrouped } = useGroupedTransactions(groupedColumns, serverSideFilter)

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
    setTablesWithUndo([...tables, newTable])
    setShowAddTableMenu(false)
  }

  // Filter options for filter panel — computed from transactions.
  // Use a length-based dependency so it only recomputes when the row count
  // changes (i.e., after each chunk load or reclassification) instead of on
  // every reference change.
  const txnLength = transactions.length
  const filterOptions = useMemo(() => {
    if (txnLength === 0) return {
      suppliers: [], classificationsL1: [], classificationsL2: [],
      classificationsL3: [], classificationsL4: [], glDescriptions: [],
      companies: [], years: [], quarters: [], months: [],
      costCenters: [], countries: [], lineDescriptions: []
    }

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
    const countries = new Set()
    const lineDescriptions = new Set()

    for (let i = 0; i < transactions.length; i++) {
      const row = transactions[i]
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
      if (row.year) years.add(row.year)
      if (row.quarter) quarters.add(row.quarter)
      if (row.month) months.add(row.month)
      if (row.cost_center) costCenters.add(row.cost_center)
      if (row.country) countries.add(row.country)
      if (row.line_description) lineDescriptions.add(row.line_description)
    }

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
      countries: Array.from(countries).sort(),
      lineDescriptions: Array.from(lineDescriptions).sort().slice(0, 50)
    }
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

    if (Array.isArray(filterState.country) && filterState.country.length > 0) {
      newFilters.country = filterState.country
    }

    if (Array.isArray(filterState.lineDescription) && filterState.lineDescription.length > 0) {
      newFilters.lineDescription = filterState.lineDescription
    }

    // Merge: keep existing activeFilters that don't come from filterState, add new ones
    pushFilterUndo()
    setActiveFilters(prev => {
      // Keys managed by filterState sync
      const fsKeys = ['supplier_name', 'gl_description', 'company', 'year', 'quarter', 'month', 'costCenter', 'country', 'lineDescription']
      // Keep non-filterState keys (e.g., double-click/drag-drop filters)
      const kept = {}
      Object.keys(prev).forEach(k => {
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
    pushFilterUndo()
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
  }, [setActiveFilters, pushFilterUndo])

  // Remove a single filter (from UI filters or drag/drop activeFilters)
  const removeFilter = useCallback((filterKey, valueToRemove = null) => {
    pushFilterUndo()
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
  }, [setActiveFilters, pushFilterUndo])

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

  // Map filterState keys → backend keys (used for normalizing operator/connector lookups)
  const fsKeyToBackendKey = useMemo(() => ({
    supplier: 'supplier_name',
    classificationL1: 'classification_l1',
    classificationL2: 'classification_l2',
    classificationL3: 'classification_l3',
    classificationL4: 'classification_l4',
    glDescription: 'gl_description',
    lineDescription: 'line_description',
  }), [])

  // Calculate filtered transactions for metrics (same logic as MultiTableSystem)
  const filteredTransactions = useMemo(() => {
    const isOrMode = filterCombinator === 'OR'

    // Operator-aware match: compares rowVal against filterVal using the given operator
    const matchWithOperator = (rowVal: string, filterVal: string, operator: string): boolean => {
      const rv = (rowVal || '').toString().trim().toLowerCase()
      const fv = (filterVal || '').toString().trim().toLowerCase()
      switch (operator) {
        case 'is': return rv === fv
        case 'is_not': return rv !== fv
        case 'contains': return rv.includes(fv)
        case 'not_contains': return !rv.includes(fv)
        case 'starts_with': return rv.startsWith(fv)
        case 'ends_with': return rv.endsWith(fv)
        default: return rv === fv
      }
    }

    // Helper: check if a row matches a single filter category
    // Uses backend key for operator lookup (filterGroupOperators is keyed by backend key)
    const matchesActiveFilter = (row, key, value) => {
      if (!value) return true
      const op = filterGroupOperators[key] || 'is'
      if (Array.isArray(value)) {
        const isNegative = op === 'is_not' || op === 'not_contains'
        const rowVal = (row[key] || '').toString().trim()
        if (isNegative) {
          return value.every(v => matchWithOperator(rowVal, v, op))
        }
        return value.some(v => matchWithOperator(rowVal, v, op))
      }
      return matchWithOperator((row[key] || '').toString().trim(), (value || '').toString().trim(), op)
    }

    // Resolve the actual row value for a filterState key
    const getRowValueForFsKey = (row, fsKey) => {
      const path = row.classification_path || row.taxonomy_path || ''
      const parts = path.split('|').map(p => p.trim())
      switch (fsKey) {
        case 'supplier': return row.supplier_name || ''
        case 'classificationL1': return parts[0] || ''
        case 'classificationL2': return parts[1] || ''
        case 'classificationL3': return parts[2] || ''
        case 'classificationL4': return parts[3] || ''
        case 'glDescription': return row.gl_description || ''
        case 'company': return row.company || ''
        case 'year': return row.year || ''
        case 'quarter': return row.quarter || ''
        case 'month': return row.month || ''
        case 'costCenter': return row.cost_center || ''
        case 'country': return row.country || ''
        case 'lineDescription': return row.line_description || ''
        default: return ''
      }
    }

    // Helper: check if a row matches a single filterState category
    // Uses backend key for operator lookup
    const matchesFilterStateEntry = (row, fsKey, fsValues) => {
      if (!Array.isArray(fsValues) || fsValues.length === 0) return null // not active — skip
      const backendKey = fsKeyToBackendKey[fsKey] || fsKey
      const op = filterGroupOperators[backendKey] || 'is'
      const rowVal = getRowValueForFsKey(row, fsKey)
      const isNegative = op === 'is_not' || op === 'not_contains'
      if (isNegative) {
        return fsValues.every(v => matchWithOperator(rowVal, v, op))
      }
      return fsValues.some(v => matchWithOperator(rowVal, v, op))
    }

    const filtered = transactions.filter(row => {
      // Collect all filter condition results with their group keys (using backend keys)
      const conditionEntries: Array<{ key: string; result: boolean }> = []
      const seenBackendKeys = new Set<string>()

      // filterState conditions FIRST (these are the source of truth for UI-managed filters)
      Object.entries(filterState).forEach(([fsKey, fsValues]) => {
        const result = matchesFilterStateEntry(row, fsKey, fsValues)
        if (result !== null) {
          const backendKey = fsKeyToBackendKey[fsKey] || fsKey
          conditionEntries.push({ key: backendKey, result })
          seenBackendKeys.add(backendKey)
        }
      })

      // activeFilters conditions — skip keys already covered by filterState to avoid duplicates
      Object.entries(activeFilters).forEach(([key, value]) => {
        if (!value || (Array.isArray(value) && value.length === 0)) return
        if (seenBackendKeys.has(key)) return // already handled via filterState
        conditionEntries.push({ key, result: matchesActiveFilter(row, key, value) })
      })

      // If no filter conditions, row passes
      if (conditionEntries.length === 0) return true

      // Evaluate with SQL-like AND/OR precedence (AND binds tighter than OR)
      const passesFilters = evaluateFilterConditions(conditionEntries, filterConnectors, filterCombinator)
      if (!passesFilters) return false

      return true
    })

    return filtered
  }, [transactions, activeFilters, filterState, filterCombinator, filterConnectors, filterGroupOperators, fsKeyToBackendKey])

  // Defer filtered result so React keeps UI responsive while filtering runs.
  const deferredFilteredTransactions = useDeferredValue(filteredTransactions)

  // Check if there are unclassified rows
  const hasLowConfidenceRows = useMemo(() => {
    if (!transactions || transactions.length === 0) return false
    return transactions.some(row => {
      const status = row.classification_status as string
      return !status || status === 'unclassified'
    })
  }, [txnLength])

  // Check if rows are controlled by Category A supplier rules
  const checkCategoryASuppliers = useCallback((rows) => {
    // In a real implementation, this would check against a Category A supplier mapping
    // For now, we'll check if rows have a specific indicator or check against known Category A suppliers
    // This is a placeholder - you may need to integrate with your backend API to check Category A status
    const categoryASuppliers = new Set() // This would come from your backend/state
    return rows.filter(row => {
      const supplier = row.supplier_name || ''
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
                  (r.spend_amount && r.spend_amount === t.spend_amount && r.supplier_name === t.supplier_name)
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

            // Push latest changelog entry to undo stack for Ctrl+Z
            // Skip undo when system feedback was provided — feedback agent creates
            // side-effects (system_feedback rows) that changelog.revert() won't undo.
            if (!feedbackText) {
              try {
                const changelog = await ipc.changelog.list()
                if (changelog.length > 0) {
                  undoStackRef.current.push({ type: 'reclassify', changelogId: changelog[0].id })
                  capStack(undoStackRef.current)
                  redoStackRef.current = [] // new action invalidates redo
                }
              } catch (e) {
                console.warn('[Undo] Failed to capture changelog entry:', e)
              }
            }
          }
        } else {
          console.warn(`[Reclassify] No taxonomy node found for path: ${cleanPath}`)
        }
      } catch (persistErr) {
        console.error('[Reclassify] Failed to persist to backend:', persistErr)
      }

      // Refresh transactions + grouped data from backend to get updated classification paths
      if (refreshTransactions) {
        try {
          await refreshTransactions()
        } catch (refreshErr) {
          console.error('[Reclassify] Failed to refresh transactions:', refreshErr)
        }
      }
      refetchGrouped()

      // Refresh feedback suggestions from backend if enabled
      // The backend now awaits the feedback agent, so suggestions are ready immediately
      if (systemFeedbackEnabled && feedbackText) {
        refreshFeedbackSuggestions()
      }

      console.log(`✓ Successfully reclassified ${rowCount} rows`)

      // Show success toast
      const displayPath = targetPath.replace(/^root\|/, '').replace(/\|/g, ' → ')
      if (reclassToastTimer.current) clearTimeout(reclassToastTimer.current)
      setReclassToast({ show: true, rowCount, targetPath: displayPath, undoable: !feedbackText })
      reclassToastTimer.current = setTimeout(() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false }), 5000)

      return true // Return true to indicate successful reclassification

    } catch (err: any) {
      console.error('Failed to reclassify rows:', err)

      // Still show toast even on partial failure (rows updated locally)
      const displayPath = targetPath.replace(/^root\|/, '').replace(/\|/g, ' → ')
      if (reclassToastTimer.current) clearTimeout(reclassToastTimer.current)
      setReclassToast({ show: true, rowCount: rows.length, targetPath: displayPath, undoable: !feedbackText })
      reclassToastTimer.current = setTimeout(() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false }), 5000)

      return true
    } finally {
      setIsReclassifying(false)
      setReclassificationProgress({ current: 0, total: 0 })
    }
  }, [setTransactions, refreshTransactions, systemFeedbackEnabled, refreshFeedbackSuggestions, refetchGrouped])

  // Handle reclassification confirmation from the feedback modal
  const handleConfirmReclassify = useCallback(async (feedbackText?: string) => {
    if (!pendingReclassification) return
    const { rows, targetPath } = pendingReclassification
    setPendingReclassification(null)
    await executeReclassification(rows, targetPath, feedbackText)
  }, [pendingReclassification, executeReclassification])

  // Remove local filter from a table (must be declared before any early return)
  const handleRemoveLocalFilter = useCallback((tableId, filterKey, value) => {
    pushFilterUndo()
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
  }, [pushFilterUndo])

  // Handle double-click on a table row to add as global filter
  const handleDoubleClickFilter = useCallback((column, values) => {
    if (!column || !values || values.length === 0) return
    pushFilterUndo()

    // Map table column to the backend activeFilters key
    // For simple columns (supplier_name, gl_description, line_description, company), use directly
    const filterKey = column

    setActiveFilters(prev => {
      const existing = Array.isArray(prev[filterKey]) ? prev[filterKey] : []
      const newValues = values
        .map(v => (typeof v === 'string' ? v : v?.toString() || '').trim())
        .filter(v => v && !existing.includes(v))
      if (newValues.length === 0) return prev
      return { ...prev, [filterKey]: [...existing, ...newValues] }
    })
  }, [pushFilterUndo])

  // Handle adding a filter from the CurrentFiltersPanel "Add Filter" dropdown
  const handleAddFilter = useCallback((column, values) => {
    handleDoubleClickFilter(column, values)
  }, [handleDoubleClickFilter])

  // Apply all currently selected rows (across tables) as global filters
  const handleApplySelectionAsFilter = useCallback(() => {
    if (!selectedRows || selectedRows.length === 0) return
    pushFilterUndo()
    const byColumn = {}
    selectedRows.forEach(key => {
      const idx = key.indexOf(':')
      if (idx <= 0) return
      const col = key.slice(0, idx)
      const val = key.slice(idx + 1)
      if (!val.trim()) return
      if (!byColumn[col]) byColumn[col] = []
      if (!byColumn[col].includes(val)) byColumn[col].push(val)
    })
    setActiveFilters(prev => {
      const next = { ...prev }
      Object.entries(byColumn).forEach(([column, values]) => {
        const existing = Array.isArray(next[column]) ? next[column] : next[column] ? [next[column]] : []
        next[column] = [...new Set([...existing, ...values])]
      })
      return next
    })
  }, [selectedRows, pushFilterUndo])

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
                <button
                  type="button"
                  className={`compact-control system-feedback-compact ${systemFeedbackEnabled ? 'active' : ''}`}
                  onClick={() => setSystemFeedbackEnabled(!systemFeedbackEnabled)}
                  title="System feedback on reclassification"
                  role="switch"
                  aria-checked={systemFeedbackEnabled}
                >
                  <Sparkles size={14} className="system-feedback-icon" />
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
                    transactions={deferredFilteredTransactions}
                    allTransactions={transactions}
                    groupedData={groupedData}
                    activeFilters={activeFilters}
                    setActiveFilters={setActiveFiltersWithUndo}
                    selectedRows={selectedRows}
                    setSelectedRows={setSelectedRowsWithUndo}
                    filterState={filterState}
                    setFilterState={setFilterState}
                    tables={tables}
                    setTables={setTablesWithUndo}
                    onReorderTables={setTables}
                    availableColumns={availableColumns}
                    addTable={addTable}
                    tableLocalFilters={tableLocalFilters}
                    setTableLocalFilters={setTableLocalFiltersWithUndo}
                    filterCombinator={filterCombinator}
                    filterConnectors={filterConnectors}
                    filterGroupOperators={filterGroupOperators}
                    onSetFilterCombinator={setFilterCombinator}
                    onSetFilterConnector={(key: string, val: 'AND' | 'OR') => setFilterConnectors(prev => ({ ...prev, [key]: val }))}
                    onSetFilterOperator={(key: string, val: string) => setFilterGroupOperators(prev => ({ ...prev, [key]: val }))}
                    onRemoveFilter={removeFilter}
                    onRemoveLocalFilter={handleRemoveLocalFilter}
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
                  setSelectedRows={setSelectedRowsWithUndo}
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
                filteredTransactions={deferredFilteredTransactions}
                onDrillToFilters={(filters) => {
                  setFilterState(prev => {
                    const next = { ...prev }
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
          {reclassToast.undoable && <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '8px' }}>Ctrl+Z to undo</span>}
          <button className="reclass-toast-close" onClick={() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false })}>
            <X size={14} />
          </button>
        </div>,
        document.body
      )}

      {/* Undo Toast */}
      {undoToast.show && createPortal(
        <div className="reclass-toast">
          <CheckCircle size={16} />
          <span>{undoToast.message}</span>
          <button className="reclass-toast-close" onClick={() => setUndoToast({ show: false, message: '' })}>
            <X size={14} />
          </button>
        </div>,
        document.body
      )}

    </div>
  )
}

export default Dashboard
