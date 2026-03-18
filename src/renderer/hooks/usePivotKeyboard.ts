import { useState, useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { FlattenedPivotRow } from '../types/pivot'

interface UsePivotKeyboardOptions {
  visibleRows: FlattenedPivotRow[]
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>
  onCmdK: (rows: FlattenedPivotRow[]) => void
  onCmdF: (rows: FlattenedPivotRow[]) => void
  onCmdS?: (rows: FlattenedPivotRow[]) => void
  onToggleExpand: (key: string) => void
  onClearAllFilters: () => void
  disabled: boolean
}

interface UsePivotKeyboardReturn {
  focusedIndex: number
  selectedKeys: Set<string>
  handleKeyDown: (e: React.KeyboardEvent) => void
  clearSelection: () => void
  setFocusedIndex: (idx: number) => void
}

export function usePivotKeyboard({
  visibleRows,
  rowVirtualizer,
  onCmdK,
  onCmdF,
  onCmdS,
  onToggleExpand,
  onClearAllFilters,
  disabled,
}: UsePivotKeyboardOptions): UsePivotKeyboardReturn {
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // Row key to restore focus to after filter clear
  const restoreKeyRef = useRef<string | null>(null)
  // How many visibleRows changes to keep trying the restore (async data may take a couple renders)
  const restoreAttemptsRef = useRef(0)
  // Skip the scrollIntoView effect once after a restore (avoid double-scroll)
  const skipScrollIntoViewRef = useRef(false)

  // Clamp focused index when visible rows change
  useEffect(() => {
    if (visibleRows.length === 0) return

    // If we have a key to restore to, find it (or nearest ancestor) and scroll there
    const restoreKey = restoreKeyRef.current
    if (restoreKey && restoreAttemptsRef.current > 0) {
      restoreAttemptsRef.current--
      // Try exact key first, then progressively shorter ancestor paths
      let idx = -1
      let searchKey = restoreKey
      while (idx < 0 && searchKey) {
        idx = visibleRows.findIndex(r => r.key === searchKey)
        if (idx < 0) {
          const lastSep = searchKey.lastIndexOf('|')
          searchKey = lastSep > 0 ? searchKey.slice(0, lastSep) : ''
        }
      }
      if (idx >= 0) {
        restoreKeyRef.current = null
        restoreAttemptsRef.current = 0
        skipScrollIntoViewRef.current = true
        setFocusedIndex(idx)
        setTimeout(() => {
          rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
        }, 100)
        return
      }
      // If we ran out of attempts, give up
      if (restoreAttemptsRef.current <= 0) {
        restoreKeyRef.current = null
      }
    }

    setFocusedIndex(prev => Math.min(prev, visibleRows.length - 1))
  }, [visibleRows, rowVirtualizer])

  // After render, scroll the focused row into view (handles sticky header/footer)
  useEffect(() => {
    if (skipScrollIntoViewRef.current) {
      skipScrollIntoViewRef.current = false
      return
    }
    requestAnimationFrame(() => {
      const el = document.querySelector('tr[data-focused]')
      if (el) {
        (el as HTMLElement).scrollIntoView({ block: 'nearest' })
      }
    })
  }, [focusedIndex])

  // Clean up stale selected keys when rows change (e.g. after reclassification)
  useEffect(() => {
    setSelectedKeys(prev => {
      if (prev.size === 0) return prev
      const validKeys = new Set(visibleRows.map(r => r.key))
      const cleaned = new Set<string>()
      let changed = false
      for (const key of prev) {
        if (validKeys.has(key)) {
          cleaned.add(key)
        } else {
          changed = true
        }
      }
      return changed ? cleaned : prev
    })
  }, [visibleRows])

  // For filter (Cmd+K): fall back to focused row if nothing selected
  const getSelectedRows = useCallback((): FlattenedPivotRow[] => {
    if (selectedKeys.size === 0) {
      const focused = visibleRows[focusedIndex]
      return focused ? [focused] : []
    }
    return visibleRows.filter(r => selectedKeys.has(r.key))
  }, [selectedKeys, visibleRows, focusedIndex])

  // For reclassify (Cmd+F): only explicitly selected rows, no fallback
  const getExplicitlySelectedRows = useCallback((): FlattenedPivotRow[] => {
    if (selectedKeys.size === 0) return []
    return visibleRows.filter(r => selectedKeys.has(r.key))
  }, [selectedKeys, visibleRows])

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set())
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled || visibleRows.length === 0) return

    const metaKey = e.metaKey || e.ctrlKey

    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault()
        setFocusedIndex(prev => {
          const next = Math.max(0, prev - 1)
          rowVirtualizer.scrollToIndex(next, { align: 'auto' })
          return next
        })
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        setFocusedIndex(prev => {
          const next = Math.min(visibleRows.length - 1, prev + 1)
          rowVirtualizer.scrollToIndex(next, { align: 'auto' })
          return next
        })
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const row = visibleRows[focusedIndex]
        if (row && row.hasChildren && !row.isExpanded) {
          onToggleExpand(row.key)
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const row = visibleRows[focusedIndex]
        if (row && row.hasChildren && row.isExpanded) {
          onToggleExpand(row.key)
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        const row = visibleRows[focusedIndex]
        if (!row) break
        setSelectedKeys(prev => {
          const next = new Set(prev)
          if (next.has(row.key)) {
            next.delete(row.key)
          } else {
            next.add(row.key)
          }
          return next
        })
        break
      }
      case 'f': {
        if (metaKey) {
          e.preventDefault()
          onCmdK(getSelectedRows())
        }
        break
      }
      case 'k': {
        if (metaKey) {
          e.preventDefault()
          onCmdF(getExplicitlySelectedRows())
        }
        break
      }
      case 's': {
        if (metaKey && onCmdS) {
          e.preventDefault()
          const rows = getExplicitlySelectedRows()
          if (rows.length > 0) onCmdS(rows)
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        // Save focused row key — will be restored after new data arrives
        const focusedRow = visibleRows[focusedIndex]
        if (focusedRow) {
          restoreKeyRef.current = focusedRow.key
          restoreAttemptsRef.current = 5 // try up to 5 data changes
        }
        clearSelection()
        onClearAllFilters()
        break
      }
    }
  }, [disabled, visibleRows, focusedIndex, rowVirtualizer, onCmdK, onCmdF, onCmdS, onToggleExpand, onClearAllFilters, getSelectedRows, getExplicitlySelectedRows, clearSelection])

  return {
    focusedIndex,
    selectedKeys,
    handleKeyDown,
    clearSelection,
    setFocusedIndex,
  }
}
