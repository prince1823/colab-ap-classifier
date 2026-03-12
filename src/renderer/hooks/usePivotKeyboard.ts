import { useState, useCallback, useEffect } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { FlattenedPivotRow } from '../types/pivot'

interface UsePivotKeyboardOptions {
  visibleRows: FlattenedPivotRow[]
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>
  onCmdK: (rows: FlattenedPivotRow[]) => void
  onCmdF: (rows: FlattenedPivotRow[]) => void
  onToggleExpand: (key: string) => void
  disabled: boolean
}

interface UsePivotKeyboardReturn {
  focusedIndex: number
  selectedKeys: Set<string>
  handleKeyDown: (e: React.KeyboardEvent) => void
  clearSelection: () => void
}

export function usePivotKeyboard({
  visibleRows,
  rowVirtualizer,
  onCmdK,
  onCmdF,
  onToggleExpand,
  disabled,
}: UsePivotKeyboardOptions): UsePivotKeyboardReturn {
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  // Clamp focused index when visible rows change
  useEffect(() => {
    if (visibleRows.length === 0) return
    setFocusedIndex(prev => Math.min(prev, visibleRows.length - 1))
  }, [visibleRows.length])

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

  const getSelectedRows = useCallback((): FlattenedPivotRow[] => {
    if (selectedKeys.size === 0) {
      const focused = visibleRows[focusedIndex]
      return focused ? [focused] : []
    }
    return visibleRows.filter(r => selectedKeys.has(r.key))
  }, [selectedKeys, visibleRows, focusedIndex])

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
      case 'k': {
        if (metaKey) {
          e.preventDefault()
          onCmdK(getSelectedRows())
        }
        break
      }
      case 'f': {
        if (metaKey) {
          e.preventDefault()
          onCmdF(getSelectedRows())
        }
        break
      }
      case 'Escape': {
        e.preventDefault()
        clearSelection()
        break
      }
    }
  }, [disabled, visibleRows, focusedIndex, rowVirtualizer, onCmdK, onCmdF, onToggleExpand, getSelectedRows, clearSelection])

  return {
    focusedIndex,
    selectedKeys,
    handleKeyDown,
    clearSelection,
  }
}
