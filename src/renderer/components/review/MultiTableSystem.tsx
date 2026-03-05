import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { useDrag, useDrop } from 'react-dnd'
import { Plus, X, ChevronRight, ChevronDown } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import useKeyboardShortcuts from '../../hooks/useKeyboardShortcuts'
import { ipc } from '../../lib/ipc'
import CurrentFiltersPanel from './CurrentFiltersPanel'
import type { ReviewTableConfig } from './ReviewFilterContext'
import type { GroupedRow, GroupedTransactionsResult } from '../../../shared/types/transactions'
import type { DashboardTransactionRow } from '../../utils/transactionTransform'

// ─── Shared internal types ────────────────────────────────────────────────────

interface HierarchicalItem {
  value: string;
  amount: number;
  count?: number;
  children?: HierarchicalItem[];
  fullPath?: string;
}

interface FlatItem {
  value: string;
  amount: number;
  count?: number;
  fullPath?: string;
}

type TableItem = HierarchicalItem | FlatItem;

interface DragItem {
  type: string;
  column: string;
  value: string;
  selectedValues: string[];
  transactionRows: Record<string, unknown>[];
  serverSide: boolean;
  isSelected: boolean;
  isMultiSelect: boolean;
}

interface TableCardDragItem {
  tableId: string;
  index: number;
}

interface TableNavState {
  tableIndex: number;
  rowIndex: number;
}

import { fmtAbbrev } from '../../utils/formatSpend'
import '../../styles/MultiTableSystem.css'

export const ITEM_TYPE = 'FILTER_ROW'
export const TABLE_ROW_TYPE = 'TABLE_ROW'
export const TABLE_CARD_TYPE = 'TABLE_CARD'

// Helper function to format column names for display
const formatColumnTitle = (title: string): string => {
  if (!title) return title

  // Map of long names to shorter, cleaner versions
  const titleMap: Record<string, string> = {
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
  return title.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())
}

const NAME_DISPLAY_LENGTH = 20
const truncateName = (str: string | null | undefined): string | null | undefined => {
  if (str == null || str === '') return str
  const s = String(str).trim()
  if (s.length <= NAME_DISPLAY_LENGTH) return s
  return s.slice(0, NAME_DISPLAY_LENGTH) + '…'
}

// Hierarchical row component with expand/collapse
interface HierarchicalRowProps {
  item: HierarchicalItem;
  level?: number;
  expandedNodes: Set<string>;
  toggleExpanded: (value: string) => void;
  onSelect: ((value: string) => void) | null;
  isSelected: boolean | string;
  onDragStart?: (() => void) | null;
  data: DashboardTransactionRow[] | null;
  column: string;
  taxonomyLevelFilter?: number | null;
  focusedPath?: string | null;
  onDoubleClickFilter?: ((column: string, values: string[]) => void) | null;
}

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
  taxonomyLevelFilter = null,
  focusedPath = null,
  onDoubleClickFilter = null
}: HierarchicalRowProps): React.ReactElement => {
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasChildren = item.children && item.children.length > 0
  const isExpanded = expandedNodes.has(item.value)
  const amount = item.amount || 0
  const isOnFocusedPath = focusedPath && item.fullPath && (
    focusedPath === item.fullPath ||
    focusedPath.startsWith(item.fullPath + '|') ||
    item.fullPath.startsWith(focusedPath + '|')
  )
  const effectiveIsExpanded = taxonomyLevelFilter ? true : (isExpanded || isOnFocusedPath)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    const selectionValue = item.fullPath || item.value
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      if (onSelect && selectionValue) {
        onSelect(selectionValue)
      }
      if (hasChildren) {
        toggleExpanded(item.value)
      }
    }, 200)
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Cancel the pending single-click
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    if (!onDoubleClickFilter) return
    const selectionValue = item.fullPath || item.value
    onDoubleClickFilter(column, [selectionValue])
  }

  // Calculate total amount including children if not already calculated
  const displayAmount = hasChildren && amount === 0
    ? (item.children || []).reduce((sum: number, child: HierarchicalItem) => sum + (child.amount || 0), 0)
    : amount

  // Extract current classification from fullPath or transaction data
  const getCurrentClassification = () => {
    // Try to get from fullPath if available (for hierarchical classification paths)
    if (item.fullPath) {
      const parts = item.fullPath.split('|').map((p: string) => p.trim()).filter((p: string) => p)
      return {
        l1: parts[0] || '',
        l2: parts[1] || '',
        l3: parts[2] || '',
        l4: parts[3] || ''
      }
    }

    // Otherwise, try to find matching transactions and get classification
    if (data && column) {
      const matchingTransactions = data.filter((t: DashboardTransactionRow) => {
        const val = (String(t[column] || '')).trim() || 'Unknown'
        const itemVal = (item.value || '').toString().trim() || 'Unknown'
        return val === itemVal
      })

      if (matchingTransactions.length > 0) {
        const firstRow = matchingTransactions[0]
        const path = String(firstRow.classification_path || firstRow['taxonomy_path'] || '')
        if (path) {
          const parts = path.split('|').map((p: string) => p.trim()).filter((p: string) => p)
          return {
            l1: parts[0] || String(firstRow['L1'] || firstRow.l1 || ''),
            l2: parts[1] || String(firstRow['L2'] || firstRow.l2 || ''),
            l3: parts[2] || String(firstRow['L3'] || firstRow.l3 || ''),
            l4: parts[3] || String(firstRow['L4'] || '') || ''
          }
        }
        return {
          l1: String(firstRow['L1'] || firstRow.l1 || ''),
          l2: String(firstRow['L2'] || firstRow.l2 || ''),
          l3: String(firstRow['L3'] || firstRow.l3 || ''),
          l4: String(firstRow['L4'] || '') || ''
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
        .filter((level: string) => level && level.trim() !== '')
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
          onDoubleClick={handleDoubleClick}
          style={{ paddingLeft: `${level * 12 + 8}px`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}
        >
          <div className="row-left" style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
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
          <span className="row-amount" style={{ flexShrink: 0, marginLeft: 'auto', textAlign: 'right' }}>
            {fmtAbbrev(Number(displayAmount || 0))}
          </span>
        </div>
      )}
      {hasChildren && effectiveIsExpanded && (item.children || []).map((child: HierarchicalItem, idx: number) => (
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
          onDoubleClickFilter={onDoubleClickFilter}
        />
      ))}
    </>
  )
}

// Regular draggable row component - can be dragged for filtering or reclassification
interface DraggableTableRowProps {
  row: string;
  column: string;
  amount: number;
  count?: number;
  onDragEnd?: (() => void) | null;
  isSelected: boolean;
  isKeyboardFocused?: boolean;
  onSelect: ((value: string) => void) | null;
  transactionRows: DashboardTransactionRow[];
  onToggleSelect?: ((value: string) => void) | null;
  isMultiSelectMode: boolean;
  selectedRowsInTable?: string[];
  data: DashboardTransactionRow[] | null;
  rowRef: React.MutableRefObject<HTMLDivElement | null> | null;
  onDoubleClickFilter?: ((column: string, values: string[]) => void) | null;
  serverSide?: boolean;
}

const DraggableTableRow = ({ row, column, amount, count, onDragEnd, isSelected, isKeyboardFocused = false, onSelect, transactionRows, onToggleSelect, isMultiSelectMode, selectedRowsInTable = [], data, rowRef, onDoubleClickFilter, serverSide = false }: DraggableTableRowProps) => {
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Collect all selected rows from the same table for multi-drag
  const selectedValues = selectedRowsInTable.length > 0 && isSelected
    ? selectedRowsInTable
    : [row]

  // Collect all transaction rows for selected values (skip in server-side mode)
  const allTransactionRows: DashboardTransactionRow[] = serverSide
    ? []
    : selectedValues.length > 1
      ? selectedValues.flatMap((val: string) =>
          (data || []).filter((t: DashboardTransactionRow) => {
            const tVal = String(t[column] || '').trim() || 'Unknown'
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
        // In server-side mode, carry column+value for lazy ID fetch on drop
        // In client-side mode, include transaction rows directly
        transactionRows: serverSide ? [] : allTransactionRows,
        serverSide,
        isSelected: isSelected,
        isMultiSelect: selectedValues.length > 1
      }
    },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  })

  const transactionCount = serverSide ? (count || 0) : (allTransactionRows?.length || transactionRows?.length || 0)
  const isMultiDrag = selectedValues.length > 1
  const tooltipText = isMultiDrag
    ? `Dragging ${selectedValues.length} selected rows (${transactionCount} transactions)`
    : transactionCount > 0 
      ? `Drag to reclassify ${transactionCount} transaction${transactionCount !== 1 ? 's' : ''}`
      : 'Click to select, drag to filter or reclassify'
  
  const handleClick = (e: React.MouseEvent) => {
    // If clicking on checkbox, don't trigger row select
    if ((e.target as HTMLElement).closest('.row-checkbox')) {
      return
    }
    // Delay single-click so double-click can cancel it
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    const isMeta = e.ctrlKey || e.metaKey
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      if (isMeta) {
        onToggleSelect && onToggleSelect(row)
      } else {
        onSelect && onSelect(row)
      }
    }, 200)
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Cancel the pending single-click so it doesn't toggle selection
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    if (!onDoubleClickFilter) return
    // If multi-selected, apply all selected values as filter
    if (isSelected && selectedRowsInTable.length > 1) {
      onDoubleClickFilter(column, selectedRowsInTable)
    } else {
      onDoubleClickFilter(column, [row])
    }
  }

  // Extract current classification (L1, L2, L3, L4) from transaction rows
  const getCurrentClassification = () => {
    if (!transactionRows || transactionRows.length === 0) return null

    // Get classification from first transaction (assuming all transactions in a row have same classification)
    const firstRow = transactionRows[0]
    const l1 = String(firstRow['L1'] || firstRow.l1 || '')
    const l2 = String(firstRow['L2'] || firstRow.l2 || '')
    const l3 = String(firstRow['L3'] || firstRow.l3 || '')
    const l4 = String(firstRow['L4'] || '')

    // Also try to parse from classification_path
    const path = String(firstRow.classification_path || firstRow['taxonomy_path'] || '')
    if (path) {
      const parts = path.split('|').map((p: string) => p.trim()).filter((p: string) => p)
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
        .filter((level: string) => level && level.trim() !== '')
        .join(' → ')
    : null

  // Combine drag ref with rowRef for keyboard navigation scrolling
  const combinedRef = useCallback((node: HTMLDivElement | null) => {
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
      onDoubleClick={handleDoubleClick}
      style={{ opacity: isDragging ? 0.5 : 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}
      title={tooltipText}
    >
      <span className="row-value" title={row} style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {truncateName(fullDisplayValue)}
      </span>
      <span className="row-amount" style={{ flexShrink: 0, marginLeft: 'auto', textAlign: 'right' }}>
        {fmtAbbrev(amount)}
      </span>
    </div>
  )
}


// Virtualized flat row renderer — renders only ~50 DOM nodes for thousands of grouped rows
interface VirtualizedFlatRowsProps {
  tableData: FlatItem[];
  column: string;
  selectedRows: string[];
  tableSelectedRows: string[];
  keyboardFocus: string;
  tableNav: TableNavState;
  tableIndex: number;
  onSelectRow: ((value: string) => void) | null;
  onToggleRowSelect: ((value: string, column: string) => void) | null;
  transactionsByValue: Map<string, DashboardTransactionRow[]>;
  data: DashboardTransactionRow[] | null;
  focusedRowRef: React.MutableRefObject<HTMLDivElement | null>;
  onDoubleClickFilter: ((column: string, values: string[]) => void) | null;
  serverSide: boolean;
  scrollParentRef: React.MutableRefObject<HTMLDivElement | null>;
}

const VirtualizedFlatRows = ({ tableData, column, selectedRows, tableSelectedRows, keyboardFocus, tableNav, tableIndex, onSelectRow, onToggleRowSelect, transactionsByValue, data, focusedRowRef, onDoubleClickFilter, serverSide, scrollParentRef }: VirtualizedFlatRowsProps) => {
  // --- Scroll preservation across filter apply/clear ---
  // Continuously track the current scrollTop via scroll events.
  const lastScrollTopRef = useRef(0)
  // When data shrinks (filter applied), snapshot the scrollTop from BEFORE the shrink.
  const preFilterScrollRef = useRef(0)
  // Track previous row count so we can detect shrink (filter) vs grow (clear).
  const prevCountRef = useRef(tableData.length)

  const rowVirtualizer = useVirtualizer({
    count: tableData.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 32,
    overscan: 20,
  })

  // Always track the scroll position of the container
  useEffect(() => {
    const el = scrollParentRef.current
    if (!el) return
    const handler = () => { lastScrollTopRef.current = el.scrollTop }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [scrollParentRef])

  // Detect when data shrinks (filter applied) vs grows (filter cleared).
  // On shrink: save the pre-filter scrollTop.
  // On grow:   restore it so the user lands back where they were.
  useLayoutEffect(() => {
    const prevCount = prevCountRef.current
    const newCount = tableData.length
    prevCountRef.current = newCount

    if (prevCount === 0 || newCount === 0) return

    if (newCount < prevCount) {
      // Data shrank → filter was applied.  lastScrollTopRef still holds the
      // scroll position from before the DOM update (the scroll handler hasn't
      // fired yet because useLayoutEffect runs synchronously before paint).
      preFilterScrollRef.current = lastScrollTopRef.current
    } else if (newCount > prevCount && preFilterScrollRef.current > 0) {
      // Data grew → filter was cleared.  Restore the saved position.
      const savedTop = preFilterScrollRef.current
      preFilterScrollRef.current = 0
      // Use rAF so the virtualizer finishes measuring first.
      requestAnimationFrame(() => {
        const el = scrollParentRef.current
        if (el) {
          // Clamp to max scrollable range in case the dataset is smaller now
          el.scrollTop = Math.min(savedTop, el.scrollHeight - el.clientHeight)
        }
      })
    }
  }, [tableData, scrollParentRef])

  return (
    <div
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const item = tableData[virtualRow.index]
        const itemVal = (item.value || '').toString().trim() || 'Unknown'
        const matchingTransactions = serverSide ? [] : (transactionsByValue.get(itemVal) || [])
        const rowKey = `${column}:${item.value}`
        const isSelected = selectedRows?.includes(rowKey)
        const isKeyboardFocused = keyboardFocus === 'tables' && tableNav?.tableIndex === tableIndex && tableNav?.rowIndex === virtualRow.index

        return (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <DraggableTableRow
              row={item.value}
              column={column}
              amount={item.amount}
              count={item.count}
              isSelected={isSelected}
              isKeyboardFocused={isKeyboardFocused}
              onSelect={onSelectRow}
              onToggleSelect={(val) => onToggleRowSelect && onToggleRowSelect(val, column)}
              transactionRows={matchingTransactions}
              isMultiSelectMode={tableSelectedRows.length > 0}
              selectedRowsInTable={tableSelectedRows}
              data={serverSide ? null : data}
              rowRef={isKeyboardFocused ? focusedRowRef : null}
              onDoubleClickFilter={onDoubleClickFilter}
              serverSide={serverSide}
            />
          </div>
        )
      })}
    </div>
  )
}

// Table Component — wrapped with React.memo to avoid re-rendering when
// only sibling tables' selection/filter state changes (props are shallow-compared).
interface FilterTableProps {
  tableId: string;
  title: string;
  column: string;
  data: DashboardTransactionRow[];
  groupedRows?: GroupedRow[] | false | null;
  activeFilters: Record<string, string | string[]>;
  onClose: ((tableId: string) => void) | null;
  selectedRows: string[];
  onSelectRow: ((value: string) => void) | null;
  onToggleRowSelect: ((value: string, column: string) => void) | null;
  isHierarchical?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: (() => void) | null;
  keyboardFocus?: string;
  tableNav?: TableNavState;
  tableIndex?: number;
  focusedClassificationPath?: string | null;
  headerDragRef?: ((el: HTMLDivElement | null) => void) | null;
  onDoubleClickFilter?: ((column: string, values: string[]) => void) | null;
  onTableDataComputed?: ((tableIndex: number, tableData: FlatItem[]) => void) | null;
}

const FilterTable = React.memo(({
  tableId,
  title,
  column,
  data,
  groupedRows,
  activeFilters,
  onClose,
  selectedRows,
  onSelectRow,
  onToggleRowSelect,
  isHierarchical = false,
  collapsed = false,
  onToggleCollapse,
  keyboardFocus = 'tree',
  tableNav = { tableIndex: 0, rowIndex: 0 },
  tableIndex = 0,
  focusedClassificationPath = null,
  headerDragRef = null,
  onDoubleClickFilter = null,
  onTableDataComputed = null
}: FilterTableProps) => {
  const isTaxonomyTable = column === 'classification_path'
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const sortColumn: string = 'amount'
  const sortDirection: string = 'desc'
  const tableContentRef = useRef<HTMLDivElement | null>(null)
  const focusedRowRef = useRef<HTMLDivElement | null>(null)
  // For taxonomy table we always show a hierarchical tree view
  const effectiveHierarchical = isHierarchical || isTaxonomyTable
  // Active taxonomy level filter for classification_path tree (1–4). null = show all.
  const [activeTaxonomyLevel, setActiveTaxonomyLevel] = useState<number | null>(null)

  // Fetch all taxonomy nodes so the classification_path table shows the full
  // taxonomy tree (all 74 nodes) — not just nodes that have transactions.
  const [taxonomyNodes, setTaxonomyNodes] = useState<Array<{ fullPath: string }>>([])
  useEffect(() => {
    if (isTaxonomyTable) {
      ipc.taxonomy.getNodes().then((nodes: Array<{ fullPath: string }>) => {
        setTaxonomyNodes(nodes || [])
      }).catch(() => {})
    }
  }, [isTaxonomyTable])

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

  const toggleExpanded = (value: string) => {
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

  // Tables no longer accept drag-drop filters — drops go to the filter panel instead
  
  // Get selected rows for this table
  const tableSelectedRows = useMemo(() => {
    return selectedRows
      .filter(key => key.startsWith(`${column}:`))
      .map(key => key.split(':').slice(1).join(':'))
  }, [selectedRows, column])

  // Data is used directly — no per-table local filters

  // Pre-build a lookup map: column value → matching transaction rows.
  // This replaces the O(n) data.filter() that was running inside EVERY row render,
  // turning O(rows × transactions) into O(transactions) once + O(1) per row.
  const transactionsByValue = useMemo(() => {
    const map = new Map<string, DashboardTransactionRow[]>()
    if (!data || !column) return map
    for (let i = 0; i < data.length; i++) {
      const row = data[i]
      const val = (row[column] || '').toString().trim() || 'Unknown'
      let arr = map.get(val)
      if (!arr) {
        arr = []
        map.set(val, arr)
      }
      arr.push(row)
    }
    return map
  }, [data, column])

  // When server-side groupedRows are provided for flat tables, use them directly
  const serverSideMode = !!groupedRows && !effectiveHierarchical

  // Build hierarchical or flat table data
  const tableData = useMemo(() => {
    // Server-side mode: use pre-grouped data directly (skip all client-side grouping)
    if (serverSideMode && groupedRows) {
      return groupedRows
        .filter(r => {
          const v = (r.value || '').trim()
          return v && v !== '(blank)' && v.toLowerCase() !== 'unknown' && v.toLowerCase() !== 'blank' && v.toLowerCase() !== '[blank]'
        })
        .map((r): HierarchicalItem => ({ value: r.value, amount: r.amount, count: r.count }))
    }

    if (!data || !column) return []

    // ── Taxonomy table: build tree from ALL taxonomy nodes, then overlay
    //    transaction amounts so every node is visible even with $0 spend.
    if (isTaxonomyTable && taxonomyNodes.length > 0) {
      // 1. Accumulate spend per full_path from server-side grouped rows
      const spendByPath: Record<string, number> = {}
      if (groupedRows && groupedRows.length > 0) {
        for (const row of groupedRows) {
          if (row.value) spendByPath[row.value] = (spendByPath[row.value] || 0) + row.amount
        }
      }

      // 2. Build nested tree from taxonomy nodes
      const tree: Record<string, any> = {}
      for (const node of taxonomyNodes) {
        const parts = node.fullPath.split('|').map((p: string) => p.trim()).filter(Boolean)
        let current: Record<string, any> = tree
        parts.forEach((part: string, idx: number) => {
          const fp = parts.slice(0, idx + 1).join('|')
          if (!current[part]) {
            current[part] = { value: part, amount: 0, children: {}, fullPath: fp }
          }
          current = current[part].children
        })
      }

      // 3. Roll up transaction amounts into every ancestor level
      for (const [path, amount] of Object.entries(spendByPath)) {
        const parts = path.split('|').map((p: string) => p.trim()).filter(Boolean)
        let current: Record<string, any> = tree
        for (let i = 0; i < parts.length; i++) {
          const key = parts[i]
          if (current[key]) {
            current[key].amount = (current[key].amount || 0) + amount
            current = current[key].children
          } else {
            // Transaction path not in taxonomy — create ad-hoc node
            const fp = parts.slice(0, i + 1).join('|')
            current[key] = { value: key, amount: amount, children: {}, fullPath: fp }
            current = current[key].children
          }
        }
      }

      // 4. Convert nested object to sorted array
      const buildHierarchy = (obj: Record<string, any>): HierarchicalItem[] => {
        return Object.values(obj)
          .map((item: any) => ({
            ...item,
            amount: item.amount || 0,
            children: item.children && Object.keys(item.children).length > 0
              ? buildHierarchy(item.children)
              : []
          }))
          .sort((a: HierarchicalItem, b: HierarchicalItem) => {
            if (sortColumn === 'amount') {
              return sortDirection === 'asc'
                ? (a.amount || 0) - (b.amount || 0)
                : (b.amount || 0) - (a.amount || 0)
            }
            return sortDirection === 'asc'
              ? (a.value || '').localeCompare(b.value || '', undefined, { sensitivity: 'base' })
              : (b.value || '').localeCompare(a.value || '', undefined, { sensitivity: 'base' })
          })
      }
      return buildHierarchy(tree)
    }

    // Non-taxonomy tables: server-side grouped data only.
    // If groupedRows not yet available (loading), show empty table.
    return []
  }, [
    column,
    isTaxonomyTable,
    sortColumn,
    sortDirection,
    taxonomyNodes,
    serverSideMode,
    groupedRows,
  ])

  // Report flat tableData to parent for keyboard navigation alignment.
  // This ensures getCurrentTableData() matches what VirtualizedFlatRows renders.
  useEffect(() => {
    if (onTableDataComputed && !effectiveHierarchical) {
      onTableDataComputed(tableIndex, tableData)
    }
  }, [onTableDataComputed, tableIndex, tableData, effectiveHierarchical])

  // Compute the max depth of the taxonomy tree so we only show level tabs that exist
  const maxTaxonomyDepth = useMemo(() => {
    if (!isTaxonomyTable || !effectiveHierarchical) return 0
    const getDepth = (items: HierarchicalItem[], level: number): number => {
      if (!Array.isArray(items) || items.length === 0) return level - 1
      return Math.max(...items.map((item: HierarchicalItem) =>
        item.children && item.children.length > 0
          ? getDepth(item.children, level + 1)
          : level
      ))
    }
    return getDepth(tableData, 1)
  }, [isTaxonomyTable, effectiveHierarchical, tableData])

  // When a taxonomy level pill is active for the Classification Path
  // table, flatten the hierarchy to that exact level and sort globally so the
  // list appears in clear descending or ascending order by Amount.
  const displayedHierarchicalData = useMemo(() => {
    if (!effectiveHierarchical) return tableData
    if (!isTaxonomyTable || !activeTaxonomyLevel) return tableData

    const flattened: HierarchicalItem[] = []

    const walk = (items: HierarchicalItem[], level: number) => {
      if (!Array.isArray(items) || items.length === 0) return
      items.forEach((item: HierarchicalItem) => {
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
    const calculateTotal = (items: HierarchicalItem[]): number => {
      return items.reduce((sum: number, item: HierarchicalItem) => {
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
      className={`filter-table ${isTaxonomyTable ? 'taxonomy-table' : ''}`}
    >
      {/* Table Header with Title and Close - header bar is the drag handle for reordering */}
      <div
        ref={headerDragRef}
        className={`table-header-bar ${headerDragRef ? 'draggable' : ''}`}
        style={{ position: 'relative' }}
      >
        <div className="table-header-actions" onClick={(e) => e.stopPropagation()}>
          <button className="close-btn" onClick={() => onClose && onClose(tableId)} title="Close">
            <X size={12} />
          </button>
        </div>
        <div className="table-title-section">
          <span
            className="table-title-text"
            title={title}
          >
            {formatColumnTitle(title)}
          </span>
          {!collapsed && (
            <>
              <span className="table-total-badge" title={`Total: ${fmtAbbrev(totalAmount)}`}>
                {fmtAbbrev(totalAmount)}
              </span>
            </>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Legend for hierarchy levels in the Classification Path tree */}
          {isTaxonomyTable && maxTaxonomyDepth > 0 && (
            <div className="taxonomy-level-toggle taxonomy-level-legend">
              {Array.from({ length: maxTaxonomyDepth }, (_, i) => i + 1).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  className={`taxonomy-level-pill taxonomy-level-pill-l${lvl} ${activeTaxonomyLevel === lvl ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveTaxonomyLevel(prev => (prev === lvl ? null : lvl))
                  }}
                >
                  L{lvl}
                </button>
              ))}
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

                  // When using the flattened list for a specific taxonomy level,
                  // we don't want HierarchicalRow to apply an extra level filter,
                  // otherwise nothing will render (all rows are rendered at level 0).
                  const taxonomyLevelFilterProp =
                    usingFlattenedTaxonomy
                      ? null
                      : (isTaxonomyTable ? activeTaxonomyLevel : null)
                  return (
                    <>
                      {baseData.map((item, idx) => (
                        <HierarchicalRow
                          key={`${item.fullPath || item.value}-${idx}`}
                          item={item}
                          level={0}
                          expandedNodes={expandedNodes}
                          toggleExpanded={toggleExpanded}
                          onSelect={onSelectRow}
                          isSelected={selectedRows?.includes(`${column}:${item.value}`) || selectedRows?.includes(item.value)}
                          data={data}
                          column={column}
                          taxonomyLevelFilter={taxonomyLevelFilterProp}
                          focusedPath={isTaxonomyTable ? focusedClassificationPath : null}
                          onDoubleClickFilter={onDoubleClickFilter}
                        />
                      ))}
                    </>
                  )
                })()}
              </>
            ) : (
              <VirtualizedFlatRows
                tableData={tableData}
                column={column}
                selectedRows={selectedRows}
                tableSelectedRows={tableSelectedRows}
                keyboardFocus={keyboardFocus}
                tableNav={tableNav}
                tableIndex={tableIndex}
                onSelectRow={onSelectRow}
                onToggleRowSelect={onToggleRowSelect}
                transactionsByValue={transactionsByValue}
                data={data}
                focusedRowRef={focusedRowRef}
                onDoubleClickFilter={onDoubleClickFilter}
                serverSide={serverSideMode}
                scrollParentRef={tableContentRef}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
})

// Wrapper component that makes a FilterTable draggable for reordering
interface DraggableTableCardProps {
  tableId: string;
  index: number;
  isDraggable: boolean;
  moveTable: (fromIndex: number, toIndex: number) => void;
  children: React.ReactNode;
}

const DraggableTableCard = ({ tableId, index, isDraggable, moveTable, children }: DraggableTableCardProps) => {
  const ref = useRef<HTMLDivElement | null>(null)

  const [{ isDragging }, drag, preview] = useDrag({
    type: TABLE_CARD_TYPE,
    item: () => ({ tableId, index }),
    canDrag: () => isDraggable,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  })

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: TABLE_CARD_TYPE,
    canDrop: () => isDraggable,
    hover: (dragItem: { tableId: string; index: number }, monitor) => {
      if (!ref.current) return
      const dragIndex = dragItem.index
      const hoverIndex = index
      if (dragIndex === hoverIndex) return

      // Determine rectangle on screen
      const hoverBoundingRect = ref.current.getBoundingClientRect()
      // Get horizontal middle
      const hoverMiddleX = (hoverBoundingRect.right - hoverBoundingRect.left) / 2
      // Determine mouse position
      const clientOffset = monitor.getClientOffset()
      if (!clientOffset) return
      // Get pixels to the left
      const hoverClientX = clientOffset.x - hoverBoundingRect.left

      // Only perform the move when the mouse has crossed half of the item's width
      // When dragging right, only move when cursor is past 50%
      if (dragIndex < hoverIndex && hoverClientX < hoverMiddleX) return
      // When dragging left, only move when cursor is before 50%
      if (dragIndex > hoverIndex && hoverClientX > hoverMiddleX) return

      moveTable(dragIndex, hoverIndex)
      dragItem.index = hoverIndex
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  })

  // Connect both drag preview and drop to the same ref
  preview(drop(ref))

  return (
    <div
      ref={ref}
      className={`draggable-table-card ${isDragging ? 'table-dragging' : ''} ${isOver && canDrop ? 'table-drop-target' : ''}`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {React.Children.map(children, (child: React.ReactNode) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<any>, { headerDragRef: isDraggable ? drag : null })
        }
        return child
      })}
    </div>
  )
}

interface MultiTableSystemProps {
  // ── Data ──────────────────────────────────────────────────────────────────
  transactions: DashboardTransactionRow[];
  groupedData: Map<string, GroupedTransactionsResult> | null;

  // ── Filter state (read-only in MultiTableSystem — for display in panels) ──
  activeFilters: Record<string, string[]>;
  filterState: Record<string, string[]>;
  filterCombinator: 'AND' | 'OR';
  filterConnectors: Record<string, 'AND' | 'OR'>;
  filterGroupOperators: Record<string, string>;

  // ── Filter state setters (plain callbacks, not Dispatch<SetStateAction>) ──
  setActiveFilters: (updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => void;
  setFilterState: (updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => void;

  // ── Row selection ─────────────────────────────────────────────────────────
  selectedRows: string[];
  setSelectedRows: (updater: ((prev: string[]) => string[]) | string[]) => void;

  // ── Table config ──────────────────────────────────────────────────────────
  tables: ReviewTableConfig[];
  setTables: (updater: ((prev: ReviewTableConfig[]) => ReviewTableConfig[]) | ReviewTableConfig[]) => void;
  onReorderTables?: (updater: ((prev: ReviewTableConfig[]) => ReviewTableConfig[]) | ReviewTableConfig[]) => void;
  availableColumns?: string[];
  addTable: (column: string) => void;

  // ── Filter event callbacks ─────────────────────────────────────────────────
  onSetFilterCombinator: (val: 'AND' | 'OR') => void;
  onSetFilterConnector: (key: string, val: 'AND' | 'OR') => void;
  onSetFilterOperator: (key: string, val: string) => void;
  onRemoveFilter: (key: string, value: string | null) => void;
  onClearAll: () => void;
  onAddFilter: (column: string, values: string[]) => void;
  onDoubleClickFilter: (column: string, values: string[]) => void;
  onApplySelectionAsFilter: () => void;

  // ── Keyboard navigation ───────────────────────────────────────────────────
  keyboardFocus: 'tree' | 'tables';
  setKeyboardFocus: (focus: 'tree' | 'tables') => void;
  tableNav: TableNavState;
  setTableNav: (updater: ((prev: TableNavState) => TableNavState) | TableNavState) => void;

  // ── Optional callbacks ────────────────────────────────────────────────────
  onFocusedClassificationPathChange?: ((path: string | null) => void) | null;
}

const MultiTableSystem = ({
  transactions,
  groupedData,
  activeFilters,
  setActiveFilters,
  selectedRows,
  setSelectedRows,
  filterState = {},
  setFilterState,
  tables = [],
  setTables,
  onReorderTables,
  availableColumns = [],
  addTable,
  filterCombinator = 'AND',
  filterConnectors = {},
  filterGroupOperators = {},
  onSetFilterCombinator,
  onSetFilterConnector,
  onSetFilterOperator,
  onRemoveFilter,
  onClearAll,
  onAddFilter,
  onDoubleClickFilter,
  onApplySelectionAsFilter,
  keyboardFocus,
  setKeyboardFocus,
  tableNav,
  setTableNav,
  onFocusedClassificationPathChange
}: MultiTableSystemProps) => {
  const [focusedClassificationPath, setFocusedClassificationPath] = useState<string | null>(null)

  // Ref for tableNav to avoid stale closures during rapid keyboard Enter presses
  const tableNavRef = useRef(tableNav)
  tableNavRef.current = tableNav

  // Map of tableIndex → rendered flat tableData, reported by FilterTable.
  // This ensures keyboard navigation uses the exact same data as the rendered table.
  const renderedTableDataRef = useRef<Record<number, FlatItem[]>>({})
  const handleTableDataComputed = useCallback((tableIndex: number, tableData: FlatItem[]) => {
    renderedTableDataRef.current[tableIndex] = tableData
  }, [])

  // Double-click applies ALL selected rows as filters (any table), not just the clicked row
  const effectiveOnDoubleClickFilter = useCallback((column: string, values: string[]) => {
    if ((selectedRows && selectedRows.length > 0) && onApplySelectionAsFilter) {
      onApplySelectionAsFilter()
      return
    }
    if (onDoubleClickFilter) onDoubleClickFilter(column, values)
  }, [selectedRows, onApplySelectionAsFilter, onDoubleClickFilter])

  const setFocusedPath = useCallback((path: string | null) => {
    setFocusedClassificationPath(path)
    if (onFocusedClassificationPathChange) onFocusedClassificationPathChange(path)
  }, [onFocusedClassificationPathChange])

  // Keep parent toolbar in sync with current classification path (for "Current classification" bar)
  useEffect(() => {
    if (onFocusedClassificationPathChange) {
      onFocusedClassificationPathChange(focusedClassificationPath)
    }
  }, [focusedClassificationPath, onFocusedClassificationPathChange])


  const removeTable = (tableId: string) => {
    setTables(tables.filter(t => t.id !== tableId))
  }

  // Move table from one position to another (for drag-and-drop reordering)
  // Uses onReorderTables (raw setter) so reordering is NOT undoable
  const moveTable = useCallback((fromIndex: number, toIndex: number) => {
    const setter = onReorderTables || setTables
    setter((prevTables: ReviewTableConfig[]) => {
      const updated = [...prevTables]
      const [moved] = updated.splice(fromIndex, 1)
      updated.splice(toIndex, 0, moved)
      return updated
    })
  }, [onReorderTables, setTables])

  const toggleTableCollapse = (tableId: string) => {
    setTables(tables.map((t: ReviewTableConfig) =>
      t.id === tableId ? { ...t, collapsed: !t.collapsed } : t
    ))
  }

  // Clear all selected rows
  const clearSelection = useCallback(() => {
    setSelectedRows([])
  }, [])

  // Handle toggle row selection (for multi-select with Ctrl/Cmd+Click).
  // Supports cross-table selection: Ctrl+click in any table adds/removes that row
  // without clearing selections in other tables.
  const handleToggleRowSelect = useCallback((rowValue: string, column: string) => {
    // Activate table keyboard focus on Ctrl/Cmd+Click
    if (column && setKeyboardFocus) {
      setKeyboardFocus('tables')
      const clickedTableIndex = tables.findIndex(t => t.column === column)
      if (clickedTableIndex >= 0 && setTableNav) {
        setTableNav(prev => ({ ...prev, tableIndex: clickedTableIndex }))
      }
    }

    const key = column ? `${column}:${rowValue}` : rowValue
    setSelectedRows(prev => {
      if (!column) {
        if (prev.includes(key)) return prev.filter(v => v !== key)
        return [...prev, key]
      }
      // Toggle this row (add or remove) regardless of which table other selections are from
      if (prev.includes(key)) {
        return prev.filter(v => v !== key)
      }
      return [...prev, key]
    })
  }, [tables, setKeyboardFocus, setTableNav, setSelectedRows])


  // Helper to toggle a value within an array (add if missing, remove if present)
  const toggleValueInArray = useCallback((arr: string[], value: string): string[] => {
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

  const handleRowSelect = useCallback((rowValue: string, column: string | null = null) => {
    // Activate table keyboard focus when a row is clicked
    if (column && setKeyboardFocus) {
      setKeyboardFocus('tables')
      // Also update tableNav to point to the clicked table
      const clickedTableIndex = tables.findIndex(t => t.column === column)
      if (clickedTableIndex >= 0 && setTableNav) {
        setTableNav(prev => ({ ...prev, tableIndex: clickedTableIndex }))
      }
    }

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
    const getPathForSupplier = (supplierName: string): string | null => {
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
    }
    // For non-supplier, non-taxonomy columns: don't clear focusedPath
    // so the last selected supplier's classification stays visible
    // If column is provided, create a unique key with column prefix
    const key = column ? `${column}:${rowValue}` : rowValue
    
    setSelectedRows(prev => {
      if (!column) {
        if (prev.includes(key)) return prev.filter(v => v !== key)
        return [...prev, key]
      }
      // Regular click: keep other tables' selections, set this table's selection to this row only.
      // So double-click later still has multi-table selection to apply as filter.
      const otherColumns = (prev || []).filter(v => {
        const idx = v.indexOf(':')
        return idx > 0 && v.slice(0, idx) !== column
      })
      if (prev.includes(key)) {
        return prev.filter(v => v !== key)
      }
      return [...otherColumns, key]
    })
  }, [selectedRows])

  // Get current table's rendered data for keyboard navigation.
  // Uses the exact data reported by FilterTable via onTableDataComputed,
  // so row indices match what VirtualizedFlatRows actually renders.
  const getCurrentTableData = useCallback(() => {
    const idx = tableNav.tableIndex
    if (!tables || tables.length === 0 || idx >= tables.length) return []

    // Use the rendered data reported by FilterTable (exact index match)
    const rendered = renderedTableDataRef.current[idx]
    if (rendered && rendered.length > 0) return rendered

    // Not yet populated — keyboard nav waits for FilterTable to report
    return []
  }, [tables, tableNav.tableIndex])

  // Handle keyboard navigation in tables
  const handleTableKeyboardNav = useCallback((direction: string) => {
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

  // Handle Enter to add row to selection (add-only, never deselects)
  // Uses tableNavRef to read fresh nav state during rapid keypresses
  const handleTableEnter = useCallback(() => {
    if (keyboardFocus !== 'tables') return

    const nav = tableNavRef.current
    const currentTableData = getCurrentTableData()
    if (currentTableData.length === 0) return

    const currentRow = currentTableData[nav.rowIndex]
    if (!currentRow) return

    const currentTable = tables[nav.tableIndex]
    if (!currentTable) return

    const key = `${currentTable.column}:${currentRow.value}`

    // Add to selection (not toggle) — prevents rapid-press deselection
    setSelectedRows(prev => prev.includes(key) ? prev : [...prev, key])

    // Move to next row — update ref synchronously to handle rapid presses
    if (nav.rowIndex < currentTableData.length - 1) {
      const nextNav = { ...nav, rowIndex: nav.rowIndex + 1 }
      tableNavRef.current = nextNav
      setTableNav(nextNav)
    }
  }, [keyboardFocus, getCurrentTableData, tables, setSelectedRows, setTableNav])

  // Handle Cmd/Ctrl+K — apply ALL selected rows (across all tables) as global filters
  const handleApplyFilters = useCallback(() => {
    if (selectedRows.length === 0) return

    // If the parent provides onApplySelectionAsFilter, use it (applies as global activeFilters)
    if (onApplySelectionAsFilter) {
      onApplySelectionAsFilter()
      return
    }

    // Fallback: apply each selected column:value via onAddFilter
    if (onAddFilter) {
      // Group selected rows by column
      const byColumn: Record<string, string[]> = {}
      for (const key of selectedRows) {
        const colonIdx = key.indexOf(':')
        if (colonIdx > 0) {
          const col = key.slice(0, colonIdx)
          const val = key.slice(colonIdx + 1)
          if (!byColumn[col]) byColumn[col] = []
          byColumn[col].push(val)
        }
      }
      for (const [col, vals] of Object.entries(byColumn)) {
        onAddFilter(col, vals)
      }
    }
  }, [selectedRows, onApplySelectionAsFilter, onAddFilter])

  useKeyboardShortcuts({
    'ctrl+d': (e: KeyboardEvent) => {
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
    'arrowup': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('up')
      }
    },
    'cmd+arrowup': (e: KeyboardEvent) => {
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
    'ctrl+arrowup': (e: KeyboardEvent) => {
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
    'arrowdown': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('down')
      }
    },
    'cmd+arrowdown': (e: KeyboardEvent) => {
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
    'ctrl+arrowdown': (e: KeyboardEvent) => {
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
    'arrowright': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('right')
      }
    },
    'arrowleft': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tables') {
        e.preventDefault()
        handleTableKeyboardNav('left')
      }
    },
    'enter': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tables' && (e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        e.preventDefault()
        handleTableEnter()
      }
    },
    'ctrl+k': (e: KeyboardEvent) => {
      e.preventDefault()
      handleApplyFilters()
    },
    'cmd+k': (e: KeyboardEvent) => {
      e.preventDefault()
      handleApplyFilters()
    },
    // Apply all selected rows (across tables) as global filter
    'ctrl+shift+k': (e: KeyboardEvent) => {
      e.preventDefault()
      if (onApplySelectionAsFilter && selectedRows.length > 0) onApplySelectionAsFilter()
    },
    'cmd+shift+k': (e: KeyboardEvent) => {
      e.preventDefault()
      if (onApplySelectionAsFilter && selectedRows.length > 0) onApplySelectionAsFilter()
    }
  })

  return (
    <>
      {/* Kanban Board - Tables grid + fixed filters sidebar */}
      <div className="kanban-board">
        <div className="kanban-layout">
          {/* Tables grid: max 3 columns per row, wraps to new rows */}
          <div className="kanban-tables-grid">
            {tables.map((table: ReviewTableConfig, index: number) => {
              const isTaxonomy = table.column === 'classification_path'
              return (
                <DraggableTableCard
                  key={table.id}
                  tableId={table.id}
                  index={index}
                  isDraggable={!isTaxonomy}
                  moveTable={moveTable}
                >
                  <FilterTable
                    tableId={table.id}
                    title={table.title}
                    column={table.column}
                    data={transactions}
                    groupedRows={groupedData?.get(table.column)?.rows || null}
                    activeFilters={activeFilters}
                    onClose={removeTable}
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
                    onDoubleClickFilter={effectiveOnDoubleClickFilter}
                    onTableDataComputed={handleTableDataComputed}
                  />
                </DraggableTableCard>
              )
            })}
          </div>

          {/* Fixed rightmost panel: Current Filters */}
          <CurrentFiltersPanel
            activeFilters={activeFilters}
            filterState={filterState}
            tables={tables}
            filterCombinator={filterCombinator}
            filterConnectors={filterConnectors}
            filterGroupOperators={filterGroupOperators}
            onSetFilterCombinator={onSetFilterCombinator}
            onSetFilterConnector={onSetFilterConnector}
            onSetFilterOperator={onSetFilterOperator}
            onRemoveFilter={onRemoveFilter}
            onClearAll={onClearAll}
            onAddFilter={onAddFilter}
            transactions={transactions}
          />
        </div>
      </div>
    </>
  )
}

export default MultiTableSystem

