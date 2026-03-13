import { useCallback } from 'react'
import useKeyboardShortcuts from './useKeyboardShortcuts'
import type { TaxonomyTreeNode } from '../utils/taxonomyLoader'

interface UseTreeKeyboardOptions {
  columns: TaxonomyTreeNode[][]
  keyboardNav: { columnIndex: number; nodeIndex: number }
  setKeyboardNav: (updater: ((prev: { columnIndex: number; nodeIndex: number }) => { columnIndex: number; nodeIndex: number }) | { columnIndex: number; nodeIndex: number }) => void
  selectedPath: string | null
  setSelectedPath: (path: string | null) => void
  setPathAtLevel: (path: string, level: number) => void
  setDrillSelection: (updater: ((prev: string[]) => string[]) | string[]) => void
  keyboardFocus: 'tree' | 'tables'
  setKeyboardFocus: (focus: 'tree' | 'tables') => void
  onReclassifyWithKeyboard: () => void
}

export function useTreeKeyboard({
  columns,
  keyboardNav,
  setKeyboardNav,
  setSelectedPath,
  setPathAtLevel,
  setDrillSelection,
  keyboardFocus,
  setKeyboardFocus,
  onReclassifyWithKeyboard,
}: UseTreeKeyboardOptions): void {
  const handleKeyboardNavigation = useCallback((direction: string) => {
    if (!columns || columns.length === 0) return

    setKeyboardNav((prev) => {
      const { columnIndex, nodeIndex } = prev
      const currentColumn = columns[columnIndex]

      if (!currentColumn || currentColumn.length === 0) return prev

      let newColumnIndex = columnIndex
      let newNodeIndex = nodeIndex

      switch (direction) {
        case 'up':
          if (nodeIndex > 0) newNodeIndex = nodeIndex - 1
          break
        case 'down':
          if (nodeIndex < currentColumn.length - 1) newNodeIndex = nodeIndex + 1
          break
        case 'left':
          if (columnIndex > 0) {
            newColumnIndex = columnIndex - 1
            const prevColumn = columns[newColumnIndex]
            if (!prevColumn || prevColumn.length === 0) break
            const currentNode = currentColumn[nodeIndex]
            if (currentNode?.path && currentNode.path !== 'root') {
              const pathParts = currentNode.path.split('|').filter((p) => p.trim())
              if (pathParts.length > 1) {
                const parentPath = pathParts.slice(0, -1).join('|')
                const parentIndex = prevColumn.findIndex((n: TaxonomyTreeNode) => n.path === parentPath)
                if (parentIndex >= 0) {
                  newNodeIndex = parentIndex
                } else {
                  newNodeIndex = Math.min(nodeIndex, prevColumn.length - 1)
                }
              } else {
                newNodeIndex = 0
              }
            } else {
              newNodeIndex = 0
            }
            // Side-effect inside updater is preserved from original behavior
            setDrillSelection((prev) => prev.slice(0, newColumnIndex))
          }
          break
        case 'right': {
          const curNode = currentColumn[nodeIndex]
          if (curNode?.children?.length > 0) {
            setPathAtLevel(curNode.path, columnIndex + 1)
            return prev
          } else if (columnIndex < columns.length - 1) {
            newColumnIndex = columnIndex + 1
            const nextColumn = columns[newColumnIndex] || []
            newNodeIndex = Math.min(0, nextColumn.length - 1)
          }
          break
        }
        default:
          return prev
      }

      const newColumn = columns[newColumnIndex]
      if (newColumn?.[newNodeIndex]) {
        setSelectedPath(newColumn[newNodeIndex].path)
      }

      return { columnIndex: newColumnIndex, nodeIndex: newNodeIndex }
    })
  }, [columns, setPathAtLevel, setDrillSelection, setSelectedPath])

  useKeyboardShortcuts({
    'arrowup': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        if (keyboardNav.columnIndex === 0 && keyboardNav.nodeIndex === 0) {
          e.preventDefault()
          setKeyboardFocus('tables')
          return
        }
        e.preventDefault()
        handleKeyboardNavigation('up')
      }
    },
    'arrowdown': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        e.preventDefault()
        handleKeyboardNavigation('down')
      }
    },
    'arrowleft': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        e.preventDefault()
        handleKeyboardNavigation('left')
      }
    },
    'arrowright': (e: KeyboardEvent) => {
      if (keyboardFocus === 'tree') {
        e.preventDefault()
        handleKeyboardNavigation('right')
      }
    },
    'enter': (e: KeyboardEvent) => {
      if (
        keyboardFocus === 'tree' &&
        (e.target as HTMLElement).tagName !== 'INPUT' &&
        (e.target as HTMLElement).tagName !== 'TEXTAREA'
      ) {
        e.preventDefault()
        onReclassifyWithKeyboard()
      }
    },
  })
}
