import { useRef, useCallback, useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { showError, showWarning } from '../lib/toast-errors'

interface UndoEntry {
  type: 'reclassify';
  changelogId: string;
}

interface UseUndoRedoOptions {
  onUndoRedo?: () => void | Promise<void>;
}

const MAX_STACK_SIZE = 20

export function useUndoRedo({ onUndoRedo }: UseUndoRedoOptions = {}) {
  const undoStack = useRef<UndoEntry[]>([])
  const redoStack = useRef<UndoEntry[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const updateFlags = useCallback(() => {
    setCanUndo(undoStack.current.length > 0)
    setCanRedo(redoStack.current.length > 0)
  }, [])

  const capStack = (stack: UndoEntry[]) => {
    while (stack.length > MAX_STACK_SIZE) stack.shift()
  }

  const push = useCallback((entry: UndoEntry) => {
    undoStack.current.push(entry)
    capStack(undoStack.current)
    redoStack.current = [] // new action invalidates redo
    updateFlags()
  }, [updateFlags])

  const undo = useCallback(async () => {
    const entry = undoStack.current.pop()
    if (!entry) return

    try {
      const warning = await ipc.changelog.revert(entry.changelogId)
      if (warning) showWarning('Undo', warning)
      redoStack.current.push(entry)
      capStack(redoStack.current)
      updateFlags()
      if (onUndoRedo) await onUndoRedo()
    } catch (err) {
      showError('Undo failed', err)
      undoStack.current.push(entry) // put it back
      updateFlags()
    }
  }, [onUndoRedo, updateFlags])

  const redo = useCallback(async () => {
    const entry = redoStack.current.pop()
    if (!entry) return

    try {
      const warning = await ipc.changelog.revert(entry.changelogId)
      if (warning) showWarning('Redo', warning)
      undoStack.current.push(entry)
      capStack(undoStack.current)
      updateFlags()
      if (onUndoRedo) await onUndoRedo()
    } catch (err) {
      showError('Redo failed', err)
      redoStack.current.push(entry) // put it back
      updateFlags()
    }
  }, [onUndoRedo, updateFlags])

  // Ctrl+Z / Cmd+Z undo, Ctrl+Shift+Z / Cmd+Shift+Z redo
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (!(e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) return

      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      e.preventDefault()
      e.stopPropagation()

      if (e.shiftKey) {
        await redo()
      } else {
        await undo()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [undo, redo])

  return { push, undo, redo, canUndo, canRedo }
}
