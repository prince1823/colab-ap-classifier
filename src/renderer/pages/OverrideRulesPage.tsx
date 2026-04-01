import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Zap, X, CheckCircle2 } from 'lucide-react'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import { useWorkflowStore } from '../stores/workflowStore'
import { makeEmptyGroup, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import type { OverrideRule, RuleGroup } from '../../shared/types/rules'
import type { FieldDefinition, GroupedFilter } from '../../shared/types/transactions'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

const UNGROUPED_ID = '__ungrouped__'

/** Rule property field names — must match the backend RULE_PROPERTY_FIELDS set */
const RULE_PROPERTY_FIELD_NAMES = new Set(['rule_name', 'rule_source', 'rule_is_active', 'rule_group', 'rule_category_a'])

const UNGROUPED_PAGE_SIZE = 100

export default function OverrideRulesPage() {
  const projectFilePath = useWorkflowStore((s) => s.projectFilePath)
  const [rules, setRules] = useState<OverrideRule[]>([])  // grouped rules only
  const [ungroupedRulesState, setUngroupedRulesState] = useState<OverrideRule[]>([])
  const [ungroupedTotal, setUngroupedTotal] = useState(0)
  const [ungroupedLoading, setUngroupedLoading] = useState(false)
  const [groups, setGroups] = useState<RuleGroup[]>([])
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create/edit editor
  const [showEditor, setShowEditor] = useState(false)
  const [editingRule, setEditingRule] = useState<OverrideRule | null>(null)
  const [name, setName] = useState('')
  const [grouped, setGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [targetNodeId, setTargetNodeId] = useState('')
  const [editorGroupId, setEditorGroupId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [taxonomySearch, setTaxonomySearch] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  type SourceFilter = 'all' | 'manual' | 'auto' | 'universe'
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)

  // Group UI state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set([UNGROUPED_ID]))
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const [showNewGroupForm, setShowNewGroupForm] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupPriority, setNewGroupPriority] = useState('')
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null)

  // Conditions modal
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)

  // Expanded conditions per rule
  const [expandedConditions, setExpandedConditions] = useState<Set<string>>(new Set())

  // Selection state for ungrouped rules
  const [selectedUngroupedIds, setSelectedUngroupedIds] = useState<Set<string>>(new Set())

  // Selection state for grouped rules
  const [selectedGroupedIds, setSelectedGroupedIds] = useState<Set<string>>(new Set())

  // Combined selection across grouped + ungrouped
  const allSelectedIds = useMemo(
    () => new Set([...selectedGroupedIds, ...selectedUngroupedIds]),
    [selectedGroupedIds, selectedUngroupedIds]
  )

  // Apply rules state
  const [applying, setApplying] = useState(false)
  const [applyPreview, setApplyPreview] = useState<{ affectedRowCount: number; matchingRuleCount: number } | null>(null)
  const [applyResult, setApplyResult] = useState<{ matchedCount: number; ruleCount: number } | null>(null)

  // Bulk assign modal
  const [showBulkAssignModal, setShowBulkAssignModal] = useState(false)
  const [bulkAssignGroupId, setBulkAssignGroupId] = useState<string | null>(null)

  // Filter builder for bulk group assignment
  const [showFilterAssign, setShowFilterAssign] = useState(false)
  const [filterAssignGrouped, setFilterAssignGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [filterAssignConditionsOpen, setFilterAssignConditionsOpen] = useState(false)
  const [filterAssignTargetGroupId, setFilterAssignTargetGroupId] = useState<string | null>(null)

  // Combined filter fields for filter-assign modal: rule properties + transaction condition fields
  const ruleFilterFields = useMemo((): FieldDefinition[] => {
    const groupEnumValues = ['Ungrouped', ...groups.map(g => g.name)]
    const rulePropertyFields: FieldDefinition[] = [
      { name: 'rule_name',      label: 'Rule Name', type: 'string',  group: 'Rule Properties' },
      { name: 'rule_source',     label: 'Source',     type: 'enum',    group: 'Rule Properties', enumValues: ['manual', 'auto_generated', 'supplier_universe'] },
      { name: 'rule_is_active',  label: 'Active',     type: 'boolean', group: 'Rule Properties' },
      { name: 'rule_group',      label: 'Group',      type: 'enum',    group: 'Rule Properties', enumValues: groupEnumValues },
      { name: 'rule_category_a', label: 'Category A', type: 'boolean', group: 'Rule Properties' },
    ]
    const conditionFields: FieldDefinition[] = filterFields.map(f => ({ ...f, group: 'Rule Conditions' }))
    return [...rulePropertyFields, ...conditionFields]
  }, [groups, filterFields])

  const fetchRuleFilterDistinct = useCallback(
    async (field: string, limit: number): Promise<string[]> => {
      if (RULE_PROPERTY_FIELD_NAMES.has(field)) return []
      return ipc.transactions.distinctValues(field, limit)
    },
    [],
  )

  // Drag state — rules
  const dragRuleIdRef = useRef<string | null>(null)
  const dragSourceGroupRef = useRef<string | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)

  // Drag state — group reorder
  const dragGroupIdRef = useRef<string | null>(null)
  const [dragOverGroupReorderId, setDragOverGroupReorderId] = useState<string | null>(null)

  const loadUngrouped = useCallback(async (offset: number, search?: string, append = false) => {
    setUngroupedLoading(true)
    try {
      const result = await ipc.rules.listPaginated({ limit: UNGROUPED_PAGE_SIZE, offset, search })
      if (append) {
        setUngroupedRulesState(prev => [...prev, ...(result?.rules ?? [])])
      } else {
        setUngroupedRulesState(result?.rules ?? [])
      }
      setUngroupedTotal(result?.total ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ungrouped rules')
    } finally {
      setUngroupedLoading(false)
    }
  }, [])

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, g, n, fields] = await Promise.all([
        ipc.rules.list(),
        ipc.rules.listGroups(),
        ipc.taxonomy.getNodes(),
        ipc.transactions.getFilterFields(),
      ])
      setRules(r ?? [])
      setGroups(g ?? [])
      setTaxonomyNodes(n ?? [])
      setFilterFields(fields ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    loadUngrouped(0)
  }, [projectFilePath])

  const openCreate = (groupId?: string | null) => {
    setEditingRule(null)
    setName('')
    setGrouped({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setTargetNodeId(taxonomyNodes[0]?.id || '')
    setEditorGroupId(groupId ?? null)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setShowEditor(true)
  }

  const openEdit = (rule: OverrideRule) => {
    setEditingRule(rule)
    setName(rule.name)
    setGrouped(rule.groupedConditions?.groups?.length > 0 ? rule.groupedConditions : { groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setTargetNodeId(rule.targetTaxonomyNodeId)
    setEditorGroupId(rule.groupId)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setShowEditor(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      if (editingRule) {
        await ipc.rules.update(editingRule.id, { name, groupedConditions: grouped, targetTaxonomyNodeId: targetNodeId, groupId: editorGroupId })
      } else {
        await ipc.rules.create({ name, groupedConditions: grouped, targetTaxonomyNodeId: targetNodeId, groupId: editorGroupId })
      }
      setShowEditor(false)
      await loadData()
      await loadUngrouped(0, ruleSearch.trim() || undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (ruleId: string) => {
    // Optimistic: remove from both lists
    const previousRules = rules
    const previousUngrouped = ungroupedRulesState
    const previousTotal = ungroupedTotal
    const isUngrouped = ungroupedRulesState.some(r => r.id === ruleId)
    setRules(prev => prev.filter(r => r.id !== ruleId))
    if (isUngrouped) {
      setUngroupedRulesState(prev => prev.filter(r => r.id !== ruleId))
      setUngroupedTotal(prev => prev - 1)
    }
    try {
      await ipc.rules.delete(ruleId)
    } catch (e) {
      setRules(previousRules)
      setUngroupedRulesState(previousUngrouped)
      setUngroupedTotal(previousTotal)
      setError(e instanceof Error ? e.message : 'Failed to delete rule')
    }
  }

  const handleToggle = async (rule: OverrideRule) => {
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r))
    setUngroupedRulesState(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r))
    try {
      await ipc.rules.update(rule.id, { isActive: !rule.isActive })
    } catch (e) {
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: rule.isActive } : r))
      setUngroupedRulesState(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: rule.isActive } : r))
      setError(e instanceof Error ? e.message : 'Failed to toggle rule')
    }
  }

  const handleCategoryAToggle = async (rule: OverrideRule) => {
    const newValue = !rule.categoryASupplier
    // Optimistic update
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, categoryASupplier: newValue } : r))
    setUngroupedRulesState(prev => prev.map(r => r.id === rule.id ? { ...r, categoryASupplier: newValue } : r))
    try {
      await ipc.rules.setCategoryA(rule.id, newValue)
    } catch (e) {
      // Revert optimistic update
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, categoryASupplier: rule.categoryASupplier } : r))
      setUngroupedRulesState(prev => prev.map(r => r.id === rule.id ? { ...r, categoryASupplier: rule.categoryASupplier } : r))
      showError('Cat A toggle failed', e)
    }
  }

  // ─── Group CRUD ──────────────────────────────────────────────────────────

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return
    const priority = parseInt(newGroupPriority, 10)
    if (!newGroupPriority.trim() || isNaN(priority) || priority < 1) {
      setError('Priority must be an integer >= 1 (higher number = higher priority)')
      return
    }
    try {
      await ipc.rules.createGroup({ name: newGroupName.trim(), priority })
      setNewGroupName('')
      setNewGroupPriority('')
      setShowNewGroupForm(false)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group')
    }
  }

  const handleRenameGroup = async (groupId: string) => {
    if (!editingGroupName.trim()) { setEditingGroupId(null); return }
    try {
      await ipc.rules.updateGroup(groupId, { name: editingGroupName.trim() })
      setEditingGroupId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename group')
    }
  }

  const handleDeleteGroup = async (groupId: string) => {
    const previousGroups = groups
    const previousRules = rules
    const previousUngrouped = ungroupedRulesState
    const previousUngroupedTotal = ungroupedTotal
    // Optimistic: move rules from deleted group to ungrouped
    const movingRules = rules.filter(r => r.groupId === groupId).map(r => ({ ...r, groupId: null }))
    setGroups(prev => prev.filter(g => g.id !== groupId))
    setRules(prev => prev.filter(r => r.groupId !== groupId))
    setUngroupedRulesState(prev => [...movingRules, ...prev])
    setUngroupedTotal(prev => prev + movingRules.length)
    setDeletingGroupId(null)
    try {
      await ipc.rules.deleteGroup(groupId)
    } catch (e) {
      // Rollback on failure
      setGroups(previousGroups)
      setRules(previousRules)
      setUngroupedRulesState(previousUngrouped)
      setUngroupedTotal(previousUngroupedTotal)
      setError(e instanceof Error ? e.message : 'Failed to delete group')
    }
  }

  // ─── Drag-and-drop: Rule move across groups ───────────────────────────────

  const handleRuleDragStart = useCallback((e: React.DragEvent, ruleId: string, sourceGroupId: string | null) => {
    dragRuleIdRef.current = ruleId
    dragSourceGroupRef.current = sourceGroupId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ruleId)
    requestAnimationFrame(() => {
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.4'
    })
  }, [])

  const handleRuleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1'
    dragRuleIdRef.current = null
    dragSourceGroupRef.current = null
    setDragOverGroupId(null)
  }, [])

  const handleGroupDragOver = useCallback((e: React.DragEvent, groupId: string | null) => {
    if (!dragRuleIdRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverGroupId(groupId ?? UNGROUPED_ID)
  }, [])

  const handleGroupDrop = useCallback(async (e: React.DragEvent, targetGroupId: string | null) => {
    const draggedId = dragRuleIdRef.current
    const sourceGroupId = dragSourceGroupRef.current
    if (!draggedId) return // Not a rule drag — let group reorder handle it
    e.preventDefault()
    setDragOverGroupId(null)
    if (sourceGroupId === targetGroupId) return

    // Optimistic update — move rule between grouped/ungrouped lists
    const previousRules = rules
    const previousUngrouped = ungroupedRulesState
    const previousUngroupedTotal = ungroupedTotal

    // Find the rule in either list
    const draggedRule = rules.find(r => r.id === draggedId) ?? ungroupedRulesState.find(r => r.id === draggedId)
    if (!draggedRule) return

    if (targetGroupId === null) {
      // Moving to ungrouped
      setRules(prev => prev.filter(r => r.id !== draggedId))
      setUngroupedRulesState(prev => [{ ...draggedRule, groupId: null }, ...prev])
      setUngroupedTotal(prev => prev + 1)
    } else if (sourceGroupId === null) {
      // Moving from ungrouped to a group
      setUngroupedRulesState(prev => prev.filter(r => r.id !== draggedId))
      setUngroupedTotal(prev => prev - 1)
      setRules(prev => [...prev, { ...draggedRule, groupId: targetGroupId }])
    } else {
      // Moving between groups
      setRules(prev => prev.map(r => r.id === draggedId ? { ...r, groupId: targetGroupId } : r))
    }

    try {
      await ipc.rules.moveRule(draggedId, targetGroupId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move rule')
      setRules(previousRules)
      setUngroupedRulesState(previousUngrouped)
      setUngroupedTotal(previousUngroupedTotal)
    }
  }, [rules, ungroupedRulesState, ungroupedTotal])

  // ─── Drag-and-drop: Group reorder ──────────────────────────────────────────

  const handleGroupDragStart = useCallback((e: React.DragEvent, groupId: string) => {
    dragGroupIdRef.current = groupId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-group-reorder', groupId)
    requestAnimationFrame(() => {
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.4'
    })
  }, [])

  const handleGroupDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1'
    dragGroupIdRef.current = null
    setDragOverGroupReorderId(null)
  }, [])

  const handleGroupReorderDragOver = useCallback((e: React.DragEvent, targetGroupId: string) => {
    // Only handle group reorder drags, not rule drags
    if (!dragGroupIdRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverGroupReorderId(targetGroupId)
  }, [])

  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const handleGroupReorderDrop = useCallback(async (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverGroupReorderId(null)
    const draggedGroupId = dragGroupIdRef.current
    dragGroupIdRef.current = null
    if (!draggedGroupId || draggedGroupId === targetGroupId) return

    // Reorder: move dragged group to target's position
    const currentOrder = groupsRef.current.map(g => g.id)
    const fromIndex = currentOrder.indexOf(draggedGroupId)
    const toIndex = currentOrder.indexOf(targetGroupId)
    if (fromIndex === -1 || toIndex === -1) return

    const newOrder = [...currentOrder]
    newOrder.splice(fromIndex, 1)
    newOrder.splice(toIndex, 0, draggedGroupId)

    // Optimistic update — reorder groups locally with updated priorities
    const previousGroups = groupsRef.current
    const reorderedGroups = newOrder
      .map((id, i) => {
        const g = previousGroups.find(g => g.id === id)
        return g ? { ...g, priority: newOrder.length - i } : null
      })
      .filter(Boolean) as RuleGroup[]
    setGroups(reorderedGroups)

    try {
      await ipc.rules.reorderGroups(newOrder)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder groups')
      setGroups(previousGroups)
    }
  }, [])

  // ─── Bulk assign selected ungrouped rules ─────────────────────────────

  const handleBulkAssign = async () => {
    if (selectedUngroupedIds.size === 0) return
    try {
      await ipc.rules.assignToGroup(Array.from(selectedUngroupedIds), bulkAssignGroupId)
      setSelectedUngroupedIds(new Set())
      setShowBulkAssignModal(false)
      setBulkAssignGroupId(null)
      await loadData()
      await loadUngrouped(0, ruleSearch.trim() || undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign rules')
    }
  }

  // ─── Filter-based group assignment ─────────────────────────────────────

  const handleFilterAssign = async () => {
    try {
      const result = await ipc.rules.filterAssign(filterAssignGrouped, filterAssignTargetGroupId)
      if (result.matched === 0) {
        setError('No rules match the specified conditions')
        return
      }
      setShowFilterAssign(false)
      setFilterAssignGrouped({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
      setFilterAssignTargetGroupId(null)
      await loadData()
      await loadUngrouped(0, ruleSearch.trim() || undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign rules')
    }
  }

  // ─── Apply selected rules ─────────────────────────────────────────────────

  const handleApplyClick = async () => {
    if (allSelectedIds.size === 0) return
    setApplying(true)
    setApplyPreview(null)
    setApplyResult(null)
    try {
      const preview = await ipc.rules.previewApply(Array.from(allSelectedIds))
      setApplyPreview(preview)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to preview rules')
    } finally {
      setApplying(false)
    }
  }

  const handleApplyConfirm = async () => {
    if (allSelectedIds.size === 0) return
    setApplying(true)
    try {
      const result = await ipc.rules.apply(Array.from(allSelectedIds))
      setApplyPreview(null)
      setApplyResult(result)
      setSelectedGroupedIds(new Set())
      setSelectedUngroupedIds(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply rules')
    } finally {
      setApplying(false)
    }
  }

  // ─── Taxonomy dropdown ────────────────────────────────────────────────────

  const filteredTaxonomyNodes = useMemo(() => {
    const l3Only = taxonomyNodes.filter(n => n.l3 !== null)
    if (!taxonomySearch.trim()) return l3Only
    const q = taxonomySearch.toLowerCase()
    return l3Only.filter(n => n.fullPath.toLowerCase().includes(q))
  }, [taxonomyNodes, taxonomySearch])

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (taxonomyDropdownRef.current && !taxonomyDropdownRef.current.contains(e.target as Node)) {
        setTaxonomyDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [])

  const selectTaxonomyNode = (nodeId: string) => {
    setTargetNodeId(nodeId)
    setTaxonomyDropdownOpen(false)
    setTaxonomySearch('')
  }

  const getNodePath = (nodeId: string) => taxonomyNodes.find((n) => n.id === nodeId)?.fullPath || nodeId

  const formatGroupedFilter = (gf: GroupedFilter) => {
    if (!gf?.groups?.length) return 'No conditions'
    const hasConditions = gf.groups.some(g => g.conditions.some(c => c.field))
    if (!hasConditions) return 'No conditions configured'
    return gf.groups.map((g, gi) => {
      const groupStr = g.conditions
        .filter(c => c.field)
        .map((c, ci, arr) => {
          const part = `${c.field} ${OPERATOR_LABELS[c.operator]} "${c.value}"`
          if (ci < arr.length - 1) return `${part} ${c.connector || g.connector}`
          return part
        })
        .join(' ')
      const prefix = gi > 0 ? ` ${g.groupConnector || gf.groupConnector} ` : ''
      return gf.groups.length > 1 ? `${prefix}(${groupStr})` : `${prefix}${groupStr}`
    }).join('')
  }

  const formatConditionSummary = (rule: OverrideRule) => {
    const { groupedConditions } = rule
    if (!groupedConditions?.groups?.length) return 'No conditions'
    return formatGroupedFilter(groupedConditions)
  }

  // ─── Filtering ────────────────────────────────────────────────────────────

  // Filter grouped rules (client-side — small set)
  const filteredGroupedRules = useMemo(() => {
    let result = rules
    if (sourceFilter === 'manual') result = result.filter(r => r.source === 'manual')
    else if (sourceFilter === 'auto') result = result.filter(r => r.source === 'auto_generated')
    else if (sourceFilter === 'universe') result = result.filter(r => r.source === 'supplier_universe')
    if (ruleSearch.trim()) {
      const q = ruleSearch.toLowerCase()
      result = result.filter(r => {
        const target = getNodePath(r.targetTaxonomyNodeId).toLowerCase()
        const conditions = formatConditionSummary(r).toLowerCase()
        const source = r.source === 'auto_generated' ? 'auto' : r.source === 'supplier_universe' ? 'universe' : 'manual'
        const status = r.isActive ? 'active' : 'inactive'
        return r.name.toLowerCase().includes(q) || target.includes(q) || conditions.includes(q) || source.includes(q) || status.includes(q)
      })
    }
    return result
  }, [rules, ruleSearch, taxonomyNodes, sourceFilter])

  // Filter ungrouped rules (client-side filter on source; search is handled server-side)
  const filteredUngroupedRules = useMemo(() => {
    let result = ungroupedRulesState
    if (sourceFilter === 'manual') result = result.filter(r => r.source === 'manual')
    else if (sourceFilter === 'auto') result = result.filter(r => r.source === 'auto_generated')
    else if (sourceFilter === 'universe') result = result.filter(r => r.source === 'supplier_universe')
    return result
  }, [ungroupedRulesState, sourceFilter])

  // Reload ungrouped when search changes (debounced server-side search)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      loadUngrouped(0, ruleSearch.trim() || undefined)
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [ruleSearch, loadUngrouped])

  // Group rules by groupId. Ungrouped comes from separate paginated state.
  const rulesByGroup = useMemo(() => {
    const map = new Map<string, OverrideRule[]>()
    for (const group of groups) map.set(group.id, [])
    for (const rule of filteredGroupedRules) {
      const key = rule.groupId ?? UNGROUPED_ID
      if (map.has(key)) {
        map.get(key)!.push(rule)
      }
    }
    // Sort rules within each group by createdAt (newest first)
    for (const [, ruleList] of map) {
      ruleList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    // Ungrouped rules come from paginated state
    map.set(UNGROUPED_ID, filteredUngroupedRules)
    return map
  }, [filteredGroupedRules, filteredUngroupedRules, groups])

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const allGroupIds = useMemo(() => [...groups.map(g => g.id), UNGROUPED_ID], [groups])

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  const ungroupedRules = rulesByGroup.get(UNGROUPED_ID) ?? []
  const allUngroupedSelected = ungroupedRules.length > 0 && ungroupedRules.every(r => selectedUngroupedIds.has(r.id))
  const someUngroupedSelected = ungroupedRules.some(r => selectedUngroupedIds.has(r.id))

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Override Rules</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {(rules.length + ungroupedTotal).toLocaleString()} rule{(rules.length + ungroupedTotal) !== 1 ? 's' : ''} across {groups.length} group{groups.length !== 1 ? 's' : ''}.
            Higher priority number = evaluated first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Source filter */}
          <button
            onClick={() => setSourceFilter(prev => prev === 'all' ? 'manual' : prev === 'manual' ? 'auto' : prev === 'auto' ? 'universe' : 'all')}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              sourceFilter === 'all'
                ? 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                : sourceFilter === 'manual'
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : sourceFilter === 'universe'
                ? 'border-teal-300 bg-teal-50 text-teal-700'
                : 'border-purple-300 bg-purple-50 text-purple-700'
            }`}
            title={`Showing: ${sourceFilter === 'all' ? 'All rules' : sourceFilter === 'manual' ? 'Manual only' : sourceFilter === 'auto' ? 'Auto-generated only' : 'Universe only'}`}
          >
            {sourceFilter === 'all' && 'All'}
            {sourceFilter === 'manual' && 'Manual'}
            {sourceFilter === 'auto' && 'Auto'}
            {sourceFilter === 'universe' && 'Universe'}
          </button>

          {/* Collapse / Expand all */}
          <button
            onClick={() => {
              const allCollapsed = collapsedGroups.size === allGroupIds.length
              if (allCollapsed) setCollapsedGroups(new Set())
              else setCollapsedGroups(new Set(allGroupIds))
            }}
            title={collapsedGroups.size === allGroupIds.length ? 'Expand all' : 'Collapse all'}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            {collapsedGroups.size === allGroupIds.length ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 9L3.75 3.75M9 9H3.75M9 9V3.75m6 11.25l5.25 5.25M15 15h5.25M15 15v5.25" /></svg>
            )}
          </button>

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search rules..."
              value={ruleSearch}
              onChange={(e) => setRuleSearch(e.target.value)}
              className="w-56 rounded-md border border-gray-300 py-1.5 pl-9 pr-3 text-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Filter & Assign */}
          <button
            onClick={() => setShowFilterAssign(!showFilterAssign)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              showFilterAssign ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
            title="Use filter conditions to bulk-assign rules to a group"
          >
            <svg className="mr-1.5 -mt-0.5 inline h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" /></svg>
            Filter & Assign
          </button>

          {/* + Group */}
          <button
            onClick={() => setShowNewGroupForm(!showNewGroupForm)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              showNewGroupForm ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            + Group
          </button>

          {/* Add Rule */}
          <button onClick={() => openCreate()} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            Add Rule
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error} <button onClick={() => setError(null)} className="ml-2 text-red-500 underline text-xs">dismiss</button></div>}

      {/* New group form */}
      {showNewGroupForm && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4">
          <h3 className="text-sm font-medium text-gray-800 mb-3">Create New Group</h3>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Group Name</label>
              <input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setShowNewGroupForm(false); setNewGroupName(''); setNewGroupPriority('') } }}
                placeholder="e.g. Critical Overrides"
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div className="w-48">
              <label className="mb-1 block text-xs font-medium text-gray-600">Priority (higher = first)</label>
              <input
                value={newGroupPriority}
                onChange={(e) => setNewGroupPriority(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newGroupName.trim()) handleCreateGroup() }}
                placeholder="e.g. 10"
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <button onClick={handleCreateGroup} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">Create</button>
            <button onClick={() => { setShowNewGroupForm(false); setNewGroupName(''); setNewGroupPriority('') }} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          </div>
          <p className="mt-2 text-[11px] text-gray-500">
            If the priority number is already taken, existing groups at that priority and above will be bumped up automatically.
          </p>
        </div>
      )}

      {/* Filter & Assign panel */}
      {showFilterAssign && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/30 p-4">
          <h3 className="text-sm font-medium text-gray-800 mb-3">Filter Rules & Assign to Group</h3>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Match rules where:</label>
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                <span className="text-xs text-gray-600 truncate" title={formatGroupedFilter(filterAssignGrouped)}>
                  {formatGroupedFilter(filterAssignGrouped)}
                </span>
                <button
                  type="button"
                  onClick={() => setFilterAssignConditionsOpen(true)}
                  className="ml-3 shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50"
                >
                  Configure
                </button>
              </div>
              <AdvancedFilterModal
                isOpen={filterAssignConditionsOpen}
                onClose={() => setFilterAssignConditionsOpen(false)}
                groupedFilter={filterAssignGrouped}
                onApply={(g) => setFilterAssignGrouped(g ?? { groupConnector: 'AND', groups: [makeEmptyGroup()] })}
                availableFields={ruleFilterFields}
                fetchDistinctValues={fetchRuleFilterDistinct}
                title="Rule Filter Conditions"
                subtitle="Define conditions to match rules for bulk group assignment"
              />
            </div>
            <div className="flex items-end gap-3">
              <div className="w-64">
                <label className="mb-1 block text-xs font-medium text-gray-600">Assign matching rules to:</label>
                <select
                  value={filterAssignTargetGroupId ?? ''}
                  onChange={(e) => setFilterAssignTargetGroupId(e.target.value || null)}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                >
                  <option value="">Ungrouped</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name} (P{g.priority})</option>
                  ))}
                </select>
              </div>
              <button onClick={handleFilterAssign} className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
                Apply
              </button>
              <button onClick={() => setShowFilterAssign(false)} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Rule editor panel */}
      {showEditor && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 shadow-sm">
          <h3 className="text-sm font-medium text-gray-700">{editingRule ? 'Edit Rule' : 'New Rule'}</h3>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Conditions</label>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <span className="text-xs text-gray-600 truncate" title={formatGroupedFilter(grouped)}>
                {formatGroupedFilter(grouped)}
              </span>
              <button
                type="button"
                onClick={() => setConditionsModalOpen(true)}
                className="ml-3 shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50"
              >
                Configure
              </button>
            </div>
            <AdvancedFilterModal
              isOpen={conditionsModalOpen}
              onClose={() => setConditionsModalOpen(false)}
              groupedFilter={grouped}
              onApply={(g) => setGrouped(g ?? { groupConnector: 'AND', groups: [makeEmptyGroup()] })}
              availableFields={filterFields}
              title="Rule Conditions"
              subtitle="Define when this override rule applies"
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Group</label>
              <select
                value={editorGroupId ?? ''}
                onChange={(e) => setEditorGroupId(e.target.value || null)}
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              >
                <option value="">Ungrouped</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name} (P{g.priority})</option>
                ))}
              </select>
            </div>
            <div ref={taxonomyDropdownRef} className="relative">
              <label className="mb-1 block text-xs font-medium text-gray-600">Target Classification</label>
              <button
                type="button"
                onClick={() => setTaxonomyDropdownOpen(!taxonomyDropdownOpen)}
                className="flex w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-1.5 text-left text-sm hover:border-gray-400"
              >
                <span className={targetNodeId ? 'text-gray-900 truncate' : 'text-gray-400'}>
                  {targetNodeId ? getNodePath(targetNodeId) : 'Select classification...'}
                </span>
                <svg className={`ml-2 h-4 w-4 shrink-0 text-gray-400 transition-transform ${taxonomyDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
              </button>
              {taxonomyDropdownOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
                  <div className="border-b border-gray-100 p-2">
                    <input
                      value={taxonomySearch}
                      onChange={(e) => setTaxonomySearch(e.target.value)}
                      placeholder="Search taxonomy..."
                      autoFocus
                      className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  </div>
                  <ul className="max-h-48 overflow-y-auto py-1">
                    {filteredTaxonomyNodes.length === 0 && (
                      <li className="px-3 py-2 text-xs text-gray-400">No matches</li>
                    )}
                    {filteredTaxonomyNodes.map((n) => (
                      <li
                        key={n.id}
                        onMouseDown={(e) => { e.preventDefault(); selectTaxonomyNode(n.id) }}
                        className={`cursor-pointer px-3 py-1.5 text-xs leading-snug ${
                          n.id === targetNodeId
                            ? 'bg-blue-50 font-medium text-blue-700'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {n.fullPath}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setShowEditor(false)} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      )}

      {/* Delete group confirmation */}
      {deletingGroupId && (() => {
        const group = groups.find(g => g.id === deletingGroupId)
        const ruleCount = rulesByGroup.get(deletingGroupId)?.length ?? 0
        return (
          <div className="rounded-md border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-700">
              Delete group &ldquo;{group?.name}&rdquo;? {ruleCount > 0 ? `Its ${ruleCount} rule${ruleCount !== 1 ? 's' : ''} will become ungrouped.` : ''}
            </p>
            <div className="mt-2 flex gap-2">
              <button onClick={() => handleDeleteGroup(deletingGroupId)} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">Delete</button>
              <button onClick={() => setDeletingGroupId(null)} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )
      })()}

      {/* Apply rules confirm modal — portal overlay */}
      {applyPreview && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setApplyPreview(null)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
                <Zap className="h-5 w-5 text-white" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">Apply Rules</h2>
                <p className="text-xs text-gray-500">Review before confirming</p>
              </div>
              <button
                onClick={() => setApplyPreview(null)}
                className="ml-auto rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Divider */}
            <div className="my-4 h-px bg-gray-100" />

            {/* Body */}
            {applyPreview.affectedRowCount > 0 ? (
              <p className="text-sm text-gray-700">
                This will apply{' '}
                <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                  {applyPreview.matchingRuleCount} rule{applyPreview.matchingRuleCount !== 1 ? 's' : ''}
                </span>{' '}
                to{' '}
                <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                  {applyPreview.affectedRowCount.toLocaleString()} row{applyPreview.affectedRowCount !== 1 ? 's' : ''}
                </span>
                . This action will overwrite any existing classifications for matched transactions.
              </p>
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <span className="text-lg">⚠️</span>
                No transactions matched the selected rules.
              </div>
            )}

            {/* Footer */}
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setApplyPreview(null)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              {applyPreview.affectedRowCount > 0 && (
                <button
                  onClick={handleApplyConfirm}
                  disabled={applying}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-500/30 hover:from-indigo-600 hover:to-violet-700 disabled:opacity-50 transition-all duration-150"
                >
                  {applying ? (
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                  ) : (
                    <Zap className="h-4 w-4" />
                  )}
                  {applying ? 'Applying…' : 'Confirm & Apply'}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Apply rules result toast */}
      {applyResult && createPortal(
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-xl">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
          <span>
            <span className="font-semibold text-emerald-400">{applyResult.matchedCount.toLocaleString()}</span>
            {' '}row{applyResult.matchedCount !== 1 ? 's' : ''} classified by{' '}
            <span className="font-semibold text-indigo-400">{applyResult.ruleCount}</span>
            {' '}rule{applyResult.ruleCount !== 1 ? 's' : ''}.
          </span>
          <button onClick={() => setApplyResult(null)} className="ml-1 text-gray-400 hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>,
        document.body
      )}

      {/* Bulk action bar — shown when any rules are selected */}
      {allSelectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5">
          <span className="text-sm font-medium text-blue-800">{allSelectedIds.size} rule{allSelectedIds.size !== 1 ? 's' : ''} selected</span>
          {selectedUngroupedIds.size > 0 && (
            <>
              <select
                value={bulkAssignGroupId ?? ''}
                onChange={(e) => setBulkAssignGroupId(e.target.value || null)}
                className="rounded-md border border-blue-300 bg-white px-3 py-1 text-sm"
              >
                <option value="" disabled>Move to group...</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name} (P{g.priority})</option>
                ))}
              </select>
              <button
                onClick={handleBulkAssign}
                disabled={!bulkAssignGroupId}
                className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Move
              </button>
            </>
          )}
          <button
            onClick={handleApplyClick}
            disabled={applying}
            className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 px-3 py-1 text-xs font-semibold text-white shadow shadow-indigo-500/30 hover:from-indigo-600 hover:to-violet-700 disabled:opacity-50 transition-all duration-150"
          >
            {applying ? (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
            ) : (
              <Zap className="h-3 w-3" />
            )}
            {applying ? 'Loading…' : 'Apply Rules'}
          </button>
          <button
            onClick={() => { setSelectedUngroupedIds(new Set()); setSelectedGroupedIds(new Set()) }}
            className="ml-auto text-xs text-blue-600 hover:text-blue-800"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* ═══ Groups as collapsible table sections ═══ */}
      <div className="overflow-auto rounded-lg border border-gray-300">
        <table className="w-full table-fixed border-collapse text-xs">
          {/* Sticky column headers */}
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-50">
              <th className="w-14 px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300"></th>
              <th className="w-[14%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Rule Name</th>
              <th className="w-[30%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Condition</th>
              <th className="w-[28%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Target Classification</th>
              <th className="w-[7%] px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Source</th>
              <th className="w-[6%] px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Cat A</th>
              <th className="w-[7%] px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Status</th>
              <th className="w-20 px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {/* Groups sorted by priority DESC (highest number on top) */}
            {groups.map((group) => {
              const groupRules = rulesByGroup.get(group.id) ?? []
              if (ruleSearch.trim() && groupRules.length === 0) return null
              const isCollapsed = collapsedGroups.has(group.id)
              const isDragOver = dragOverGroupId === group.id

              return (
                <GroupSection
                  key={group.id}
                  group={group}
                  groupRules={groupRules}
                  isCollapsed={isCollapsed}
                  isDragOver={isDragOver}
                  toggleGroup={toggleGroup}
                  editingGroupId={editingGroupId}
                  editingGroupName={editingGroupName}
                  setEditingGroupName={setEditingGroupName}
                  handleRenameGroup={handleRenameGroup}
                  setEditingGroupId={setEditingGroupId}
                  openCreate={openCreate}
                  setDeletingGroupId={setDeletingGroupId}
                  handleGroupDragOver={handleGroupDragOver}
                  setDragOverGroupId={setDragOverGroupId}
                  handleGroupDrop={handleGroupDrop}
                  getNodePath={getNodePath}
                  formatConditionSummary={formatConditionSummary}
                  openEdit={openEdit}
                  handleDelete={handleDelete}
                  handleToggle={handleToggle}
                  handleCategoryAToggle={handleCategoryAToggle}
                  handleRuleDragStart={handleRuleDragStart}
                  handleRuleDragEnd={handleRuleDragEnd}
                  expandedConditions={expandedConditions}
                  setExpandedConditions={setExpandedConditions}
                  selectedGroupedIds={selectedGroupedIds}
                  onGroupRuleSelect={(ruleId, selected) => {
                    setSelectedGroupedIds(prev => {
                      const next = new Set(prev)
                      if (selected) next.add(ruleId)
                      else next.delete(ruleId)
                      return next
                    })
                  }}
                  handleGroupDragStart={handleGroupDragStart}
                  handleGroupDragEnd={handleGroupDragEnd}
                  handleGroupReorderDragOver={handleGroupReorderDragOver}
                  handleGroupReorderDrop={handleGroupReorderDrop}
                  setDragOverGroupReorderId={setDragOverGroupReorderId}
                  isDragOverReorder={dragOverGroupReorderId === group.id}
                />
              )
            })}

            {/* ═══ Ungrouped section — always at the bottom ═══ */}
            {(ungroupedRules.length > 0 || !ruleSearch.trim()) && (
              <>
                {/* Ungrouped header row */}
                <tr
                  className={`cursor-pointer select-none transition-colors ${
                    dragOverGroupId === UNGROUPED_ID ? 'bg-amber-50' : 'bg-gray-50/60 hover:bg-gray-100'
                  }`}
                  onClick={() => toggleGroup(UNGROUPED_ID)}
                  onDragOver={(e) => handleGroupDragOver(e, null)}
                  onDragLeave={() => setDragOverGroupId(null)}
                  onDrop={(e) => handleGroupDrop(e, null)}
                >
                  <td colSpan={8} className="px-3 py-2.5 border border-gray-300">
                    <div className="flex items-center gap-2">
                      <svg className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${collapsedGroups.has(UNGROUPED_ID) ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                      <input
                        type="checkbox"
                        checked={allUngroupedSelected}
                        ref={(el) => { if (el) el.indeterminate = someUngroupedSelected && !allUngroupedSelected }}
                        onChange={(e) => {
                          e.stopPropagation()
                          if (allUngroupedSelected) setSelectedUngroupedIds(new Set())
                          else setSelectedUngroupedIds(new Set(ungroupedRules.map(r => r.id)))
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        title="Select all ungrouped rules"
                      />
                      <span className="flex-1 text-sm font-semibold text-gray-500">Ungrouped</span>
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                        {ungroupedTotal.toLocaleString()} rule{ungroupedTotal !== 1 ? 's' : ''}
                        {ungroupedRules.length < ungroupedTotal ? ` (showing ${ungroupedRules.length.toLocaleString()})` : ''}
                      </span>
                      <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-600" title="Ungrouped rules are evaluated last (lowest priority)">
                        Lowest Priority
                      </span>
                    </div>
                  </td>
                </tr>

                {/* Ungrouped rules */}
                {!collapsedGroups.has(UNGROUPED_ID) && (
                  <>
                    {ungroupedRules.length === 0 && (
                      <tr
                        onDragOver={(e) => handleGroupDragOver(e, null)}
                        onDragLeave={() => setDragOverGroupId(null)}
                        onDrop={(e) => handleGroupDrop(e, null)}
                      >
                        <td colSpan={8} className="px-6 py-6 text-center text-xs text-gray-400 border border-gray-300">
                          No ungrouped rules. Drop rules here to ungroup them.
                        </td>
                      </tr>
                    )}
                    {ungroupedRules.map((rule) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        getNodePath={getNodePath}
                        formatConditionSummary={formatConditionSummary}
                        onEdit={openEdit}
                        onDelete={handleDelete}
                        onToggle={handleToggle}
                        onCategoryAToggle={handleCategoryAToggle}
                        onDragStart={(e) => handleRuleDragStart(e, rule.id, null)}
                        onDragEnd={handleRuleDragEnd}
                        expandedConditions={expandedConditions}
                        setExpandedConditions={setExpandedConditions}
                        selectable
                        selected={selectedUngroupedIds.has(rule.id)}
                        onSelect={(selected) => {
                          setSelectedUngroupedIds(prev => {
                            const next = new Set(prev)
                            if (selected) next.add(rule.id)
                            else next.delete(rule.id)
                            return next
                          })
                        }}
                      />
                    ))}
                    {ungroupedRules.length < ungroupedTotal && (
                      <tr>
                        <td colSpan={8} className="px-3 py-3 text-center border border-gray-300">
                          <button
                            onClick={() => loadUngrouped(ungroupedRules.length, ruleSearch.trim() || undefined, true)}
                            disabled={ungroupedLoading}
                            className="rounded-md bg-gray-100 px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                          >
                            {ungroupedLoading ? 'Loading...' : `Load more (${(ungroupedTotal - ungroupedRules.length).toLocaleString()} remaining)`}
                          </button>
                        </td>
                      </tr>
                    )}
                  </>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {rules.length === 0 && groups.length === 0 && ungroupedTotal === 0 && (
        <div className="text-center py-8 text-gray-500 text-sm">
          No override rules yet. Create groups to organize your rules, then add rules to classify vendors.
        </div>
      )}
    </div>
  )
}

// ─── GroupSection component ───────────────────────────────────────────────────

interface GroupSectionProps {
  group: RuleGroup
  groupRules: OverrideRule[]
  isCollapsed: boolean
  isDragOver: boolean
  toggleGroup: (id: string) => void
  editingGroupId: string | null
  editingGroupName: string
  setEditingGroupName: (v: string) => void
  handleRenameGroup: (id: string) => void
  setEditingGroupId: (id: string | null) => void
  openCreate: (groupId?: string | null) => void
  setDeletingGroupId: (id: string | null) => void
  handleGroupDragOver: (e: React.DragEvent, groupId: string | null) => void
  setDragOverGroupId: (id: string | null) => void
  handleGroupDrop: (e: React.DragEvent, groupId: string | null) => void
  getNodePath: (id: string) => string
  formatConditionSummary: (rule: OverrideRule) => string
  openEdit: (rule: OverrideRule) => void
  handleDelete: (id: string) => void
  handleToggle: (rule: OverrideRule) => void
  handleCategoryAToggle: (rule: OverrideRule) => void
  handleRuleDragStart: (e: React.DragEvent, ruleId: string, sourceGroupId: string | null) => void
  handleRuleDragEnd: (e: React.DragEvent) => void
  expandedConditions: Set<string>
  setExpandedConditions: React.Dispatch<React.SetStateAction<Set<string>>>
  selectedGroupedIds: Set<string>
  onGroupRuleSelect: (ruleId: string, selected: boolean) => void
  handleGroupDragStart: (e: React.DragEvent, groupId: string) => void
  handleGroupDragEnd: (e: React.DragEvent) => void
  handleGroupReorderDragOver: (e: React.DragEvent, targetGroupId: string) => void
  handleGroupReorderDrop: (e: React.DragEvent, targetGroupId: string) => void
  setDragOverGroupReorderId: (id: string | null) => void
  isDragOverReorder: boolean
}

function GroupSection({
  group, groupRules, isCollapsed, isDragOver, toggleGroup,
  editingGroupId, editingGroupName, setEditingGroupName, handleRenameGroup, setEditingGroupId,
  openCreate, setDeletingGroupId,
  handleGroupDragOver, setDragOverGroupId, handleGroupDrop,
  getNodePath, formatConditionSummary, openEdit, handleDelete, handleToggle, handleCategoryAToggle,
  handleRuleDragStart, handleRuleDragEnd, expandedConditions, setExpandedConditions,
  selectedGroupedIds, onGroupRuleSelect,
  handleGroupDragStart, handleGroupDragEnd, handleGroupReorderDragOver, handleGroupReorderDrop, setDragOverGroupReorderId, isDragOverReorder,
}: GroupSectionProps) {
  return (
    <>
      {/* Group header row */}
      <tr
        draggable
        className={`cursor-pointer select-none transition-colors ${
          isDragOverReorder ? 'bg-indigo-50 border-t-2 border-t-indigo-400' : isDragOver ? 'bg-blue-50' : 'bg-gray-50 hover:bg-gray-100'
        }`}
        onClick={() => toggleGroup(group.id)}
        onDragStart={(e) => handleGroupDragStart(e, group.id)}
        onDragEnd={handleGroupDragEnd}
        onDragOver={(e) => {
          handleGroupDragOver(e, group.id)
          handleGroupReorderDragOver(e, group.id)
        }}
        onDragLeave={() => { setDragOverGroupId(null); setDragOverGroupReorderId(null) }}
        onDrop={(e) => {
          handleGroupReorderDrop(e, group.id)
          handleGroupDrop(e, group.id)
        }}
      >
        <td colSpan={8} className={`px-3 py-2.5 border border-gray-300 ${isDragOver ? 'ring-2 ring-inset ring-blue-300' : ''} ${isDragOverReorder ? 'ring-2 ring-inset ring-indigo-300' : ''}`}>
          <div className="flex items-center gap-2">
            {/* Group drag handle */}
            <svg className="h-4 w-4 shrink-0 text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing transition-colors" fill="currentColor" viewBox="0 0 24 24" onClick={(e) => e.stopPropagation()}>
              <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
              <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
              <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
            </svg>
            <svg className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>

            {editingGroupId === group.id ? (
              <input
                autoFocus
                value={editingGroupName}
                onChange={(e) => setEditingGroupName(e.target.value)}
                onBlur={() => handleRenameGroup(group.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameGroup(group.id); if (e.key === 'Escape') setEditingGroupId(null); }}
                className="min-w-0 flex-1 rounded border border-blue-300 px-2 py-0.5 text-sm font-semibold text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800" title={group.name}>
                {group.name}
              </span>
            )}

            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              {groupRules.length} rule{groupRules.length !== 1 ? 's' : ''}
            </span>

            <span
              className="rounded bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600"
              title="Drag groups to change priority order"
            >
              Priority {group.priority}
            </span>

            <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => openCreate(group.id)} className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-600" title="Add rule to this group">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
              </button>
              <button onClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }} className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-600" title="Rename group">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
              </button>
              <button onClick={() => setDeletingGroupId(group.id)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500" title="Delete group">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
              </button>
            </div>
          </div>
        </td>
      </tr>

      {/* Rule rows — shown when expanded */}
      {!isCollapsed && (
        <>
          {groupRules.length === 0 && (
            <tr
              onDragOver={(e) => handleGroupDragOver(e, group.id)}
              onDragLeave={() => setDragOverGroupId(null)}
              onDrop={(e) => handleGroupDrop(e, group.id)}
            >
              <td colSpan={8} className={`px-6 py-6 text-center text-xs text-gray-400 border border-gray-300 ${isDragOver ? 'bg-blue-50/50' : ''}`}>
                No rules in this group. Drag rules here or click + to add.
              </td>
            </tr>
          )}
          {groupRules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              getNodePath={getNodePath}
              formatConditionSummary={formatConditionSummary}
              onEdit={openEdit}
              onDelete={handleDelete}
              onToggle={handleToggle}
              onCategoryAToggle={handleCategoryAToggle}
              onDragStart={(e) => handleRuleDragStart(e, rule.id, group.id)}
              onDragEnd={handleRuleDragEnd}
              expandedConditions={expandedConditions}
              setExpandedConditions={setExpandedConditions}
              selectable
              selected={selectedGroupedIds.has(rule.id)}
              onSelect={(selected) => onGroupRuleSelect(rule.id, selected)}
            />
          ))}
        </>
      )}
    </>
  )
}

// ─── RuleRow component ───────────────────────────────────────────────────────

const CONDITION_TRUNCATE_LENGTH = 50
const MAX_VISIBLE_CONDITIONS = 3

function ConditionBadges({ rule, expanded, onToggle }: {
  rule: OverrideRule
  expanded: boolean
  onToggle: () => void
}) {
  const { groupedConditions } = rule
  if (!groupedConditions?.groups?.length) return <span className="text-gray-400 italic text-[10px]">No conditions</span>

  // Build structured groups with their conditions
  const parsedGroups = groupedConditions.groups
    .map(g => ({
      conditions: g.conditions.filter(c => c.field).map(c => ({
        field: c.field,
        operator: OPERATOR_LABELS[c.operator] || c.operator,
        value: String(c.value),
        connector: c.connector || g.connector,
      })),
      groupConnector: g.groupConnector || groupedConditions.groupConnector,
    }))
    .filter(g => g.conditions.length > 0)

  if (parsedGroups.length === 0) return <span className="text-gray-400 italic text-[10px]">No conditions configured</span>

  const totalConditions = parsedGroups.reduce((sum, g) => sum + g.conditions.length, 0)
  const multipleGroups = parsedGroups.length > 1

  // For collapsed view: count how many conditions to show
  const shouldTruncate = !expanded && totalConditions > MAX_VISIBLE_CONDITIONS

  let conditionCount = 0

  return (
    <div className="flex flex-wrap items-center gap-1">
      {parsedGroups.map((group, gi) => {
        const groupConditions = shouldTruncate
          ? group.conditions.filter(() => {
              if (conditionCount >= MAX_VISIBLE_CONDITIONS) return false
              conditionCount++
              return true
            })
          : group.conditions

        if (groupConditions.length === 0) return null

        return (
          <span key={gi} className="inline-flex flex-wrap items-center gap-0.5">
            {/* Group connector (OR/AND between groups) */}
            {gi > 0 && (
              <span className="text-[9px] font-bold text-purple-600 uppercase px-0.5">{group.groupConnector}</span>
            )}
            {/* Opening paren for multi-group */}
            {multipleGroups && <span className="text-[10px] font-bold text-gray-400">(</span>}
            {groupConditions.map((c, ci) => (
              <span key={ci} className="inline-flex items-center gap-0.5">
                <span className="inline-flex items-center gap-0.5 rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">
                  <span className="font-medium text-gray-700">{c.field}</span>
                  <span className="text-orange-600 font-medium">{c.operator}</span>
                  <span className="text-emerald-700 font-medium">&quot;{c.value}&quot;</span>
                </span>
                {ci < groupConditions.length - 1 && (
                  <span className="text-[9px] font-bold text-blue-500 uppercase px-0.5">{c.connector}</span>
                )}
              </span>
            ))}
            {/* Closing paren for multi-group */}
            {multipleGroups && <span className="text-[10px] font-bold text-gray-400">)</span>}
          </span>
        )
      })}
      {shouldTruncate && totalConditions > MAX_VISIBLE_CONDITIONS && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          className="text-[10px] text-blue-600 hover:text-blue-800 font-medium px-1"
        >
          +{totalConditions - MAX_VISIBLE_CONDITIONS} more
        </button>
      )}
      {expanded && totalConditions > MAX_VISIBLE_CONDITIONS && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          className="text-[10px] text-blue-600 hover:text-blue-800 font-medium px-1"
        >
          show less
        </button>
      )}
    </div>
  )
}

/** Returns true if the rule's conditions only reference supplier_name */
function isSupplierOnlyRule(rule: OverrideRule): boolean {
  const groups = rule.groupedConditions?.groups ?? []
  if (groups.length === 0) return false
  for (const g of groups) {
    for (const c of g.conditions) {
      if (c.field && c.field !== 'supplier_name') return false
    }
  }
  return true
}

interface RuleRowProps {
  rule: OverrideRule
  getNodePath: (id: string) => string
  formatConditionSummary: (rule: OverrideRule) => string
  onEdit: (rule: OverrideRule) => void
  onDelete: (id: string) => void
  onToggle: (rule: OverrideRule) => void
  onCategoryAToggle: (rule: OverrideRule) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
  expandedConditions: Set<string>
  setExpandedConditions: React.Dispatch<React.SetStateAction<Set<string>>>
  selectable?: boolean
  selected?: boolean
  onSelect?: (selected: boolean) => void
}

function RuleRow({
  rule, getNodePath, formatConditionSummary, onEdit, onDelete, onToggle, onCategoryAToggle,
  onDragStart, onDragEnd, expandedConditions, setExpandedConditions,
  selectable, selected, onSelect,
}: RuleRowProps) {
  const conditionText = formatConditionSummary(rule)
  const isLong = conditionText.length > CONDITION_TRUNCATE_LENGTH
  const isExpanded = expandedConditions.has(rule.id)

  return (
    <tr
      className="group transition-colors hover:bg-slate-50"
    >
      {/* Drag handle + optional checkbox */}
      <td
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="pl-3 pr-4 py-2 border border-gray-300 align-top cursor-grab active:cursor-grabbing"
      >
        <div className="flex items-center gap-2.5">
          <svg className="h-3.5 w-3.5 shrink-0 text-transparent group-hover:text-gray-400 transition-colors" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
          </svg>
          {selectable && (
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={(e) => onSelect?.(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      </td>

      {/* Rule Name */}
      <td
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="px-3 py-2 border border-gray-300 align-top cursor-grab active:cursor-grabbing"
      >
        <span className="font-medium text-gray-900" title={rule.name}>
          {rule.name}
        </span>
        <div className="mt-1">
          <span className="inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[9px] text-blue-500 font-medium">
            {new Date(rule.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{' '}
            {new Date(rule.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </td>

      {/* Condition */}
      <td className="px-3 py-2 border border-gray-300 align-top">
        <ConditionBadges
          rule={rule}
          expanded={isExpanded}
          onToggle={() => {
            setExpandedConditions(prev => {
              const n = new Set(prev)
              if (n.has(rule.id)) n.delete(rule.id)
              else n.add(rule.id)
              return n
            })
          }}
        />
      </td>

      {/* Target Classification */}
      <td className="px-3 py-2 border border-gray-300 align-top">
        <span className="text-gray-700" title={getNodePath(rule.targetTaxonomyNodeId)}>
          {getNodePath(rule.targetTaxonomyNodeId)}
        </span>
      </td>

      {/* Source */}
      <td className="px-3 py-2 border border-gray-300 align-top text-center">
        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
          rule.source === 'auto_generated' ? 'bg-purple-50 text-purple-600'
            : rule.source === 'supplier_universe' ? 'bg-teal-50 text-teal-600'
            : 'bg-gray-100 text-gray-500'
        }`}>
          {rule.source === 'auto_generated' ? 'Auto' : rule.source === 'supplier_universe' ? 'Universe' : 'Manual'}
        </span>
      </td>

      {/* Cat A */}
      <td className="px-3 py-2 border border-gray-300 align-top text-center">
        {isSupplierOnlyRule(rule) ? (
          <button
            onClick={(e) => { e.stopPropagation(); onCategoryAToggle(rule) }}
            className="relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors"
            style={{ backgroundColor: rule.categoryASupplier ? '#f59e0b' : '#d1d5db' }}
            title={rule.categoryASupplier ? 'Category A enabled — click to disable' : 'Click to mark as Category A'}
          >
            <span
              className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
                rule.categoryASupplier ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </button>
        ) : (
          <span className="text-gray-300 text-[10px]">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-3 py-2 border border-gray-300 align-top text-center">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(rule) }}
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            rule.isActive ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
          }`}
        >
          {rule.isActive ? 'Active' : 'Inactive'}
        </button>
      </td>

      {/* Actions */}
      <td className="px-3 py-2 border border-gray-300 align-top text-center">
        <div className="flex items-center justify-center gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); onEdit(rule) }} className="rounded p-1 text-blue-500 hover:bg-blue-50" title="Edit">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(rule.id) }} className="rounded p-1 text-red-400 hover:bg-red-50" title="Delete">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
          </button>
        </div>
      </td>
    </tr>
  )
}
