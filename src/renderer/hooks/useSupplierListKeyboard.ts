import { useState, useCallback, useEffect } from 'react'

interface UseSupplierListKeyboardOptions {
  itemCount: number
  onSelect: (index: number) => void
  onToggleCheck: (index: number) => void
  onMoveToDetail: () => void
  onClearSelections: () => void
  disabled: boolean
}

interface UseSupplierListKeyboardReturn {
  focusedIndex: number
  setFocusedIndex: (idx: number) => void
  handleKeyDown: (e: React.KeyboardEvent) => void
}

export function useSupplierListKeyboard({
  itemCount,
  onSelect,
  onToggleCheck,
  onMoveToDetail,
  onClearSelections,
  disabled,
}: UseSupplierListKeyboardOptions): UseSupplierListKeyboardReturn {
  const [focusedIndex, setFocusedIndex] = useState(0)

  // Clamp focused index when list length changes
  useEffect(() => {
    if (itemCount === 0) return
    setFocusedIndex(prev => Math.min(prev, itemCount - 1))
  }, [itemCount])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled || itemCount === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.min(focusedIndex + 1, itemCount - 1)
      setFocusedIndex(next)
      onSelect(next)
      const el = document.querySelector(`[data-supplier-index="${next}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(focusedIndex - 1, 0)
      setFocusedIndex(next)
      onSelect(next)
      const el = document.querySelector(`[data-supplier-index="${next}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onToggleCheck(focusedIndex)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onMoveToDetail()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClearSelections()
    }
  }, [disabled, itemCount, focusedIndex, onSelect, onToggleCheck, onMoveToDetail, onClearSelections])

  return { focusedIndex, setFocusedIndex, handleKeyDown }
}
