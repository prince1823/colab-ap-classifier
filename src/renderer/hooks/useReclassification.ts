import { useState, useCallback } from 'react'
import { ipc } from '../lib/ipc'

interface UseReclassificationOptions {
  onSuccess?: () => void | Promise<void>;
}

export function useReclassification({ onSuccess }: UseReclassificationOptions = {}) {
  const [isReclassifying, setIsReclassifying] = useState(false)

  const reclassify = useCallback(async (rowIds: string[], targetNodeId: string) => {
    if (rowIds.length === 0) return

    setIsReclassifying(true)
    try {
      await ipc.transactions.update({
        ids: rowIds,
        taxonomyNodeId: targetNodeId,
        classificationStatus: 'classified_by_ai',
      })

      if (onSuccess) {
        await onSuccess()
      }
    } finally {
      setIsReclassifying(false)
    }
  }, [onSuccess])

  return { reclassify, isReclassifying }
}
