import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import { useUndoRedo } from './useUndoRedo'
import { buildGroupedConditionsFromRows } from '../utils/buildConditionsFromRows'
import type { FlattenedPivotRow } from '../types/pivot'
import type { TaxonomyNode } from '../../shared/types/taxonomy'
import type { ConflictRow } from '../../shared/types/rules'
import type { PivotFilterState } from '../components/review/PivotFilterBar'

interface UseReclassificationOptions {
  filterState: PivotFilterState
  selectedGroupId?: string | null
  selectedGroupName?: string | null
  onSuccess: () => void | Promise<void>
}

export interface ConflictState {
  covered: ConflictRow[]
  eligibleIds: string[]
  node: TaxonomyNode
  ruleName: string
}

export function useReclassification({ filterState, selectedGroupId, selectedGroupName, onSuccess }: UseReclassificationOptions) {
  const [isOpen, setIsOpen] = useState(false)
  const [targetRows, setTargetRows] = useState<FlattenedPivotRow[]>([])
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [search, setSearch] = useState('')
  const [focusedIdx, setFocusedIdx] = useState(0)
  const [applying, setApplying] = useState(false)
  const [conflictChecking, setConflictChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ConflictState | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const { push: pushUndo, undo, redo, canUndo, canRedo } = useUndoRedo({
    onUndoRedo: onSuccess,
  })

  const open = useCallback((rows: FlattenedPivotRow[]) => {
    setTargetRows(rows)
    setConflicts(null)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setTargetRows([])
    setSearch('')
    setFocusedIdx(0)
    setError(null)
    setConflicts(null)
  }, [])

  // Fetch taxonomy on open
  useEffect(() => {
    if (!isOpen) return
    setSearch('')
    setFocusedIdx(0)
    setError(null)
    ipc.taxonomy.getNodes().then(setTaxonomyNodes).catch((e) => showError('Failed to load taxonomy', e))
    setTimeout(() => searchRef.current?.focus(), 50)
  }, [isOpen])

  // Filter to full 3-level nodes only (L1 + L2 + L3), sorted by L1 → L2 → L3
  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase()
    const leafNodes = taxonomyNodes.filter(n => n.l1 && n.l2 && n.l3)
    const words = q ? q.split(/\s+/).filter(Boolean) : []
    const matched = words.length > 0
      ? leafNodes.filter(n => {
          const haystack = `${n.l1} ${n.l2 ?? ''} ${n.l3 ?? ''} ${n.fullPath}`.toLowerCase()
          return words.every(w => haystack.includes(w))
        })
      : leafNodes

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

  const refreshNodes = useCallback(async () => {
    const nodes = await ipc.taxonomy.getNodes()
    setTaxonomyNodes(nodes)
  }, [])

  const addNode = useCallback(async (l1: string, l2: string, l3: string, description?: string): Promise<TaxonomyNode | null> => {
    if (!l1) return null
    try {
      await ipc.taxonomy.addNode(l1)
      if (l2) {
        await ipc.taxonomy.addNode(`${l1}|${l2}`)
      }
      let node: TaxonomyNode | null = null
      if (l2 && l3) {
        node = await ipc.taxonomy.addNode(`${l1}|${l2}|${l3}`, description || undefined) as TaxonomyNode
      } else if (l2) {
        const nodes = await ipc.taxonomy.getNodes() as TaxonomyNode[]
        node = nodes.find(n => n.l1 === l1 && n.l2 === l2 && !n.l3) ?? null
      } else {
        const nodes = await ipc.taxonomy.getNodes() as TaxonomyNode[]
        node = nodes.find(n => n.l1 === l1 && !n.l2 && !n.l3) ?? null
      }
      await refreshNodes()
      return node
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add node')
      return null
    }
  }, [refreshNodes])

  /**
   * Phase 1: called when user selects a taxonomy node.
   * Gets candidate IDs, checks for conflicts, either applies immediately or shows warning.
   */
  const apply = useCallback(async (node: TaxonomyNode) => {
    if (applying || conflictChecking) return
    setConflictChecking(true)
    setError(null)

    try {
      // Build grouped conditions from selected rows
      const groupedConditions = buildGroupedConditionsFromRows(targetRows)

      // Get candidate transaction IDs (grouped, preserving OR-within-field semantics)
      const candidateIds = await ipc.transactions.getIdsByGroupedConditions(groupedConditions)

      if (candidateIds.length === 0) {
        setError('No matching transactions found.')
        return
      }

      // Check for priority conflicts
      const { covered, eligibleIds } = await ipc.rules.previewConflicts(candidateIds)

      const ruleName = selectedGroupName?.trim() || node.l3 || node.l2 || node.l1

      if (covered.length > 0) {
        // Show conflict warning screen
        setConflicts({ covered, eligibleIds, node, ruleName })
      } else {
        // No conflicts — apply immediately
        await confirmApply(node, ruleName, eligibleIds, groupedConditions)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reclassification failed')
    } finally {
      setConflictChecking(false)
    }
  }, [targetRows, applying, conflictChecking, selectedGroupName, selectedGroupId])

  /**
   * Phase 2: called after user confirms on the conflict warning screen (or directly from phase 1).
   */
  const confirmApply = useCallback(async (
    node: TaxonomyNode,
    ruleName: string,
    eligibleIds: string[],
    groupedConditions?: import('../../shared/types/transactions').GroupedFilter
  ) => {
    if (applying) return
    setApplying(true)
    setError(null)

    try {
      const conditions = groupedConditions ?? buildGroupedConditionsFromRows(targetRows)

      const result = await ipc.rules.createAndApply({
        name: ruleName,
        groupedConditions: conditions,
        targetTaxonomyNodeId: node.id,
        groupId: selectedGroupId ?? null,
      })

      if (result.changelogId) {
        pushUndo({ type: 'reclassify', changelogId: result.changelogId })
      }

      close()
      await onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reclassification failed')
    } finally {
      setApplying(false)
    }
  }, [targetRows, applying, selectedGroupId, close, onSuccess, pushUndo])

  /**
   * Called from the conflict warning screen when user clicks "Apply to N transactions".
   */
  const confirmConflicts = useCallback(async () => {
    if (!conflicts) return
    const { node, ruleName, eligibleIds } = conflicts
    setConflicts(null)
    await confirmApply(node, ruleName, eligibleIds)
  }, [conflicts, confirmApply])

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
    confirmConflicts,
    addNode,
    applying,
    conflictChecking,
    conflicts,
    error,
    searchRef,
    undoRedo: { canUndo, canRedo, undo, redo },
  }
}
