import { useEffect } from 'react'
import { useDrop } from 'react-dnd'
import type { DragItem } from '../types/dragItems'
import { TABLE_ROW_TYPE, ITEM_TYPE } from '../components/review/MultiTableSystem'
import { ipc } from '../lib/ipc'

interface UseNodeDropOptions {
  nodePath: string
  isDroppableLevel: boolean
  onDropIds: ((transactionIds: string[], targetPath: string) => void) | null
  onHoverExpand: ((path: string, level: number) => void) | null
  level: number
}

export function useNodeDrop({ nodePath, isDroppableLevel, onDropIds, onHoverExpand, level }: UseNodeDropOptions) {
  const [{ isOverShallow, canDrop }, drop] = useDrop({
    accept: [TABLE_ROW_TYPE, ITEM_TYPE],
    drop: async (item: DragItem) => {
      if (!onDropIds || nodePath === 'root' || !isDroppableLevel) {
        return { targetPath: nodePath }
      }
      if (item.serverSide && (!item.transactionRows || item.transactionRows.length === 0)) {
        try {
          const values: string[] = item.selectedValues?.length > 0
            ? item.selectedValues
            : [item.value].filter((v): v is string => !!v)
          const idArrays = await Promise.all(
            values.map((v) => ipc.transactions.getIdsByValue(item.column, v))
          )
          const allIds = idArrays.flat()
          if (allIds.length > 0) {
            onDropIds(allIds, nodePath)
          }
        } catch (err) {
          console.error('[Drop] Failed to fetch transaction IDs:', err)
        }
      } else {
        const rows = item.transactionRows || []
        const ids = rows.map((r) => r.id as string).filter(Boolean)
        if (ids.length > 0) {
          onDropIds(ids, nodePath)
        }
      }
      return { targetPath: nodePath }
    },
    canDrop: () => true,
    collect: (monitor) => ({
      isOverShallow: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  })

  useEffect(() => {
    if (isOverShallow && onHoverExpand) {
      onHoverExpand(nodePath, level)
    }
  }, [isOverShallow, nodePath, level, onHoverExpand])

  return { drop, isOverShallow, canDrop }
}
