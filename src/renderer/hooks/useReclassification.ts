import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ipc } from '../lib/ipc'
import { useUndoRedo } from './useUndoRedo'
import type { FlattenedPivotRow, PathSegment } from '../types/pivot'
import type { TaxonomyNode } from '../../shared/types/taxonomy'
import type { FilterCondition } from '../../shared/types/transactions'
import type { PivotFilterState } from '../components/review/PivotFilterBar'

const UNCLASSIFIED_LABEL = '(Unclassified)'

/** Classification virtual dims that resolve via taxonomy JOIN */
const CLASSIFICATION_DIMS = new Set(['classification_l1', 'classification_l2', 'classification_l3'])

/**
 * Build FilterCondition[] from a pivot row's pathSegments + active filter state.
 * Handles (Unclassified) labels:
 *   - L1 unclassified → taxonomy_node_id IS NULL (no taxonomy node at all)
 *   - L2/L3 unclassified → that specific level IS NULL (node exists but at shallower depth)
 */
function buildConditionsFromRow(
  pathSegments: PathSegment[],
  filterState: PivotFilterState
): FilterCondition[] {
  const conditions: FilterCondition[] = []

  for (const segment of pathSegments) {
    if (segment.value === UNCLASSIFIED_LABEL && CLASSIFICATION_DIMS.has(segment.dimensionField)) {
      if (segment.dimensionField === 'classification_l1') {
        // L1 unclassified → no taxonomy node assigned at all
        conditions.push({ field: 'taxonomy_node_id', operator: 'is_null', value: '' })
      } else {
        // L2/L3 unclassified → node exists but this level is NULL
        conditions.push({ field: segment.dimensionField, operator: 'is_null', value: '' })
      }
    } else {
      conditions.push({ field: segment.dimensionField, operator: 'equals', value: segment.value })
    }
  }

  // Merge active pivot filter state (dimension pill filters)
  for (const [field, values] of Object.entries(filterState)) {
    if (values.length > 0) {
      conditions.push({ field, operator: 'in_list', value: values })
    }
  }

  return conditions
}

interface UseReclassificationOptions {
  filterState: PivotFilterState
  onSuccess: () => void | Promise<void>
}

export function useReclassification({ filterState, onSuccess }: UseReclassificationOptions) {
  const [isOpen, setIsOpen] = useState(false)
  const [targetRows, setTargetRows] = useState<FlattenedPivotRow[]>([])
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [search, setSearch] = useState('')
  const [focusedIdx, setFocusedIdx] = useState(0)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const { push: pushUndo, undo, redo, canUndo, canRedo } = useUndoRedo({
    onUndoRedo: onSuccess,
  })

  const open = useCallback((rows: FlattenedPivotRow[]) => {
    setTargetRows(rows)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setTargetRows([])
    setSearch('')
    setFocusedIdx(0)
    setError(null)
  }, [])

  // Fetch taxonomy on open
  useEffect(() => {
    if (!isOpen) return
    setSearch('')
    setFocusedIdx(0)
    setError(null)
    ipc.taxonomy.getNodes().then(setTaxonomyNodes).catch(() => {})
    setTimeout(() => searchRef.current?.focus(), 50)
  }, [isOpen])

  // Filter to full 3-level nodes only (L1 + L2 + L3), sorted by L1 → L2 → L3
  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase()
    const leafNodes = taxonomyNodes.filter(n => n.l1 && n.l2 && n.l3)
    const matched = q
      ? leafNodes.filter(n =>
          n.fullPath.toLowerCase().includes(q) ||
          n.l1.toLowerCase().includes(q) ||
          (n.l2 && n.l2.toLowerCase().includes(q)) ||
          (n.l3 && n.l3.toLowerCase().includes(q))
        )
      : leafNodes

    // Sort by L1, then L2, then L3 — groups all categories together
    const sorted = [...matched].sort((a, b) => {
      const cmpL1 = a.l1.localeCompare(b.l1)
      if (cmpL1 !== 0) return cmpL1
      const cmpL2 = (a.l2 ?? '').localeCompare(b.l2 ?? '')
      if (cmpL2 !== 0) return cmpL2
      return (a.l3 ?? '').localeCompare(b.l3 ?? '')
    })

    return sorted.slice(0, 100)
  }, [taxonomyNodes, search])

  // Clamp focused index
  useEffect(() => {
    setFocusedIdx(prev => Math.min(prev, Math.max(0, filteredNodes.length - 1)))
  }, [filteredNodes.length])

  const apply = useCallback(async (node: TaxonomyNode) => {
    if (applying) return
    setApplying(true)
    setError(null)

    try {
      // Build conditions from ALL path segments of each target row (Bug A fix)
      const allIds: string[] = []

      for (const row of targetRows) {
        const conditions = buildConditionsFromRow(row.pathSegments, filterState)
        if (conditions.length === 0) continue
        const ids = await ipc.transactions.getIdsByConditions(conditions)
        allIds.push(...ids)
      }

      const uniqueIds = [...new Set(allIds)]
      if (uniqueIds.length === 0) {
        setError('No matching transactions found.')
        setApplying(false)
        return
      }

      const changelogId = await ipc.transactions.update({
        ids: uniqueIds,
        taxonomyNodeId: node.id,
        classificationStatus: 'classified_by_ai',
      })

      // Push to undo stack if we got a changelog ID
      if (changelogId) {
        pushUndo({ type: 'reclassify', changelogId })
      }

      close()
      await onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reclassification failed')
    } finally {
      setApplying(false)
    }
  }, [targetRows, filterState, applying, close, onSuccess, pushUndo])

  return {
    isOpen,
    targetRows,
    open,
    close,
    taxonomyNodes,
    search,
    setSearch,
    filteredNodes,
    focusedIdx,
    setFocusedIdx,
    apply,
    applying,
    error,
    searchRef,
    undoRedo: { canUndo, canRedo, undo, redo },
  }
}
