import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ipc } from '../lib/ipc'
import { makeEmptyGroup, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import type { OverrideRule, RuleGroup } from '../../shared/types/rules'
import type { FieldDefinition, GroupedFilter } from '../../shared/types/transactions'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

const UNGROUPED_ID = '__ungrouped__'

export default function OverrideRulesPage() {
  const [rules, setRules] = useState<OverrideRule[]>([])
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
  type SourceFilter = 'all' | 'manual' | 'auto'
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)

  // Group UI state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const [showNewGroupForm, setShowNewGroupForm] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupPriority, setNewGroupPriority] = useState('')
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null)

  // Priority editing
  const [editingPriorityGroupId, setEditingPriorityGroupId] = useState<string | null>(null)
  const [editingPriorityValue, setEditingPriorityValue] = useState('')

  // Conditions modal
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)

  // Expanded conditions per rule
  const [expandedConditions, setExpandedConditions] = useState<Set<string>>(new Set())

  // Selection state for ungrouped rules
  const [selectedUngroupedIds, setSelectedUngroupedIds] = useState<Set<string>>(new Set())

  // Bulk assign modal
  const [showBulkAssignModal, setShowBulkAssignModal] = useState(false)
  const [bulkAssignGroupId, setBulkAssignGroupId] = useState<string | null>(null)

  // Filter builder for bulk group assignment
  const [showFilterAssign, setShowFilterAssign] = useState(false)
  const [filterAssignGrouped, setFilterAssignGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [filterAssignConditionsOpen, setFilterAssignConditionsOpen] = useState(false)
  const [filterAssignTargetGroupId, setFilterAssignTargetGroupId] = useState<string | null>(null)

  // Drag state
  const dragRuleIdRef = useRef<string | null>(null)
  const dragSourceGroupRef = useRef<string | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)

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

  useEffect(() => { loadData() }, [])

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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (ruleId: string) => {
    // Optimistic: remove from local state immediately
    const previousRules = rules
    setRules(prev => prev.filter(r => r.id !== ruleId))
    try {
      await ipc.rules.delete(ruleId)
    } catch (e) {
      // Rollback on failure
      setRules(previousRules)
      setError(e instanceof Error ? e.message : 'Failed to delete rule')
    }
  }

  const handleToggle = async (rule: OverrideRule) => {
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r))
    try {
      await ipc.rules.update(rule.id, { isActive: !rule.isActive })
    } catch (e) {
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: rule.isActive } : r))
      setError(e instanceof Error ? e.message : 'Failed to toggle rule')
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

  const handleUpdatePriority = async (groupId: string) => {
    const priority = parseInt(editingPriorityValue, 10)
    if (isNaN(priority) || priority < 1) {
      setEditingPriorityGroupId(null)
      return
    }
    try {
      await ipc.rules.updateGroup(groupId, { priority })
      setEditingPriorityGroupId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update priority')
    }
  }

  const handleDeleteGroup = async (groupId: string) => {
    const previousGroups = groups
    const previousRules = rules
    // Optimistic: remove group and ungroup its rules locally
    setGroups(prev => prev.filter(g => g.id !== groupId))
    setRules(prev => prev.map(r => r.groupId === groupId ? { ...r, groupId: undefined } : r))
    setDeletingGroupId(null)
    try {
      await ipc.rules.deleteGroup(groupId)
    } catch (e) {
      // Rollback on failure
      setGroups(previousGroups)
      setRules(previousRules)
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
    e.preventDefault()
    setDragOverGroupId(null)
    const draggedId = dragRuleIdRef.current
    if (!draggedId) return
    if (dragSourceGroupRef.current === targetGroupId) return

    try {
      await ipc.rules.moveRule(draggedId, targetGroupId)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move rule')
      await loadData()
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign rules')
    }
  }

  // ─── Filter-based group assignment ─────────────────────────────────────

  const handleFilterAssign = async () => {
    // Find rules matching the filter conditions
    const matchingRuleIds: string[] = []
    for (const rule of rules) {
      if (matchesFilter(rule, filterAssignGrouped)) {
        matchingRuleIds.push(rule.id)
      }
    }
    if (matchingRuleIds.length === 0) {
      setError('No rules match the specified conditions')
      return
    }
    try {
      await ipc.rules.assignToGroup(matchingRuleIds, filterAssignTargetGroupId)
      setShowFilterAssign(false)
      setFilterAssignGrouped({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
      setFilterAssignTargetGroupId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign rules')
    }
  }

  // Match filter conditions against the rule's actual groupedConditions fields
  const matchesFilter = (rule: OverrideRule, filter: GroupedFilter): boolean => {
    if (!filter.groups.length) return false

    // Extract all condition values from the rule's groupedConditions, keyed by field name
    const ruleConditionsByField = new Map<string, string[]>()
    for (const g of rule.groupedConditions?.groups ?? []) {
      for (const c of g.conditions) {
        if (!c.field) continue
        const existing = ruleConditionsByField.get(c.field) ?? []
        existing.push(String(c.value ?? '').toLowerCase())
        ruleConditionsByField.set(c.field, existing)
      }
    }

    const matchCondition = (field: string, operator: string, value: unknown): boolean => {
      const val = String(value ?? '').toLowerCase()
      const ruleValues = ruleConditionsByField.get(field)

      // If the rule has no condition on this field, it doesn't match
      if (!ruleValues || ruleValues.length === 0) {
        return operator === 'not_contains' || operator === 'not_equals' || operator === 'is_null'
      }

      switch (operator) {
        case 'equals':
          return ruleValues.some(rv => rv === val)
        case 'not_equals':
          return ruleValues.every(rv => rv !== val)
        case 'contains':
          return ruleValues.some(rv => rv.includes(val))
        case 'not_contains':
          return ruleValues.every(rv => !rv.includes(val))
        case 'starts_with':
          return ruleValues.some(rv => rv.startsWith(val))
        case 'ends_with':
          return ruleValues.some(rv => rv.endsWith(val))
        case 'regex':
          try { const re = new RegExp(val, 'i'); return ruleValues.some(rv => re.test(rv)) }
          catch { return false }
        default:
          return false
      }
    }

    // Evaluate each group's conditions using per-condition connectors (c.connector), falling back to g.connector
    const groupResults = filter.groups.map(g => {
      const conditions = g.conditions.filter(c => c.field && (c.value != null || ['is_null', 'is_true', 'is_false'].includes(c.operator)))
      if (conditions.length === 0) return true
      let groupResult = matchCondition(conditions[0].field, conditions[0].operator, conditions[0].value)
      for (let i = 1; i < conditions.length; i++) {
        const connector = conditions[i - 1].connector || g.connector
        const condResult = matchCondition(conditions[i].field, conditions[i].operator, conditions[i].value)
        if (connector === 'OR') groupResult = groupResult || condResult
        else groupResult = groupResult && condResult
      }
      return groupResult
    })
    // Combine groups: each group can override the top-level connector via its own groupConnector
    if (groupResults.length <= 1) return groupResults[0] ?? false
    let result = groupResults[0]
    for (let i = 1; i < groupResults.length; i++) {
      const connector = filter.groups[i].groupConnector || filter.groupConnector
      if (connector === 'OR') result = result || groupResults[i]
      else result = result && groupResults[i]
    }
    return result
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

  const filteredRules = useMemo(() => {
    let result = rules
    if (sourceFilter === 'manual') result = result.filter(r => r.source !== 'auto_generated')
    else if (sourceFilter === 'auto') result = result.filter(r => r.source === 'auto_generated')
    if (ruleSearch.trim()) {
      const q = ruleSearch.toLowerCase()
      result = result.filter(r => {
        const target = getNodePath(r.targetTaxonomyNodeId).toLowerCase()
        const conditions = formatConditionSummary(r).toLowerCase()
        const source = r.source === 'auto_generated' ? 'auto' : 'manual'
        const status = r.isActive ? 'active' : 'inactive'
        return r.name.toLowerCase().includes(q) || target.includes(q) || conditions.includes(q) || source.includes(q) || status.includes(q)
      })
    }
    return result
  }, [rules, ruleSearch, taxonomyNodes, sourceFilter])

  // Group rules by groupId; ungrouped → UNGROUPED_ID. Sort within groups by createdAt.
  const rulesByGroup = useMemo(() => {
    const map = new Map<string, OverrideRule[]>()
    for (const group of groups) map.set(group.id, [])
    map.set(UNGROUPED_ID, [])
    for (const rule of filteredRules) {
      const key = rule.groupId ?? UNGROUPED_ID
      if (!map.has(key)) {
        // Rule's group wasn't loaded (edge case) — treat as ungrouped
        map.get(UNGROUPED_ID)!.push(rule)
      } else {
        map.get(key)!.push(rule)
      }
    }
    // Sort rules within each group by createdAt (newest first)
    for (const [, ruleList] of map) {
      ruleList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    return map
  }, [filteredRules, groups])

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
            {rules.length} rule{rules.length !== 1 ? 's' : ''} across {groups.length} group{groups.length !== 1 ? 's' : ''}.
            Higher priority number = evaluated first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Source filter */}
          <button
            onClick={() => setSourceFilter(prev => prev === 'all' ? 'manual' : prev === 'manual' ? 'auto' : 'all')}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              sourceFilter === 'all'
                ? 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                : sourceFilter === 'manual'
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-purple-300 bg-purple-50 text-purple-700'
            }`}
            title={`Showing: ${sourceFilter === 'all' ? 'All rules' : sourceFilter === 'manual' ? 'Manual only' : 'Auto-generated only'}`}
          >
            {sourceFilter === 'all' && 'All'}
            {sourceFilter === 'manual' && 'Manual'}
            {sourceFilter === 'auto' && 'Auto'}
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
                availableFields={filterFields}
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

      {/* Bulk assign bar for selected ungrouped rules */}
      {selectedUngroupedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5">
          <span className="text-sm font-medium text-blue-800">{selectedUngroupedIds.size} rule{selectedUngroupedIds.size !== 1 ? 's' : ''} selected</span>
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
          <button
            onClick={() => setSelectedUngroupedIds(new Set())}
            className="ml-auto text-xs text-blue-600 hover:text-blue-800"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* ═══ Groups as collapsible table sections ═══ */}
      <div className="overflow-auto rounded-lg border border-gray-300">
        <table className="w-full border-collapse text-xs">
          {/* Sticky column headers */}
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-50">
              <th className="w-8 px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300"></th>
              <th className="w-[15%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Rule Name</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Condition</th>
              <th className="w-[20%] px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Target Classification</th>
              <th className="w-[7%] px-3 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 border border-gray-300">Source</th>
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
                  editingPriorityGroupId={editingPriorityGroupId}
                  editingPriorityValue={editingPriorityValue}
                  setEditingPriorityValue={setEditingPriorityValue}
                  handleUpdatePriority={handleUpdatePriority}
                  setEditingPriorityGroupId={setEditingPriorityGroupId}
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
                  handleRuleDragStart={handleRuleDragStart}
                  handleRuleDragEnd={handleRuleDragEnd}
                  expandedConditions={expandedConditions}
                  setExpandedConditions={setExpandedConditions}
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
                  <td colSpan={7} className="px-3 py-2.5 border border-gray-300">
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
                        {ungroupedRules.length} rule{ungroupedRules.length !== 1 ? 's' : ''}
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
                        <td colSpan={7} className="px-6 py-6 text-center text-xs text-gray-400 border border-gray-300">
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
                  </>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {rules.length === 0 && groups.length === 0 && (
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
  editingPriorityGroupId: string | null
  editingPriorityValue: string
  setEditingPriorityValue: (v: string) => void
  handleUpdatePriority: (id: string) => void
  setEditingPriorityGroupId: (id: string | null) => void
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
  handleRuleDragStart: (e: React.DragEvent, ruleId: string, sourceGroupId: string | null) => void
  handleRuleDragEnd: (e: React.DragEvent) => void
  expandedConditions: Set<string>
  setExpandedConditions: React.Dispatch<React.SetStateAction<Set<string>>>
}

function GroupSection({
  group, groupRules, isCollapsed, isDragOver, toggleGroup,
  editingGroupId, editingGroupName, setEditingGroupName, handleRenameGroup, setEditingGroupId,
  editingPriorityGroupId, editingPriorityValue, setEditingPriorityValue, handleUpdatePriority, setEditingPriorityGroupId,
  openCreate, setDeletingGroupId,
  handleGroupDragOver, setDragOverGroupId, handleGroupDrop,
  getNodePath, formatConditionSummary, openEdit, handleDelete, handleToggle,
  handleRuleDragStart, handleRuleDragEnd, expandedConditions, setExpandedConditions,
}: GroupSectionProps) {
  return (
    <>
      {/* Group header row */}
      <tr
        className={`cursor-pointer select-none transition-colors ${
          isDragOver ? 'bg-blue-50' : 'bg-gray-50 hover:bg-gray-100'
        }`}
        onClick={() => toggleGroup(group.id)}
        onDragOver={(e) => handleGroupDragOver(e, group.id)}
        onDragLeave={() => setDragOverGroupId(null)}
        onDrop={(e) => handleGroupDrop(e, group.id)}
      >
        <td colSpan={7} className={`px-3 py-2.5 border border-gray-300 ${isDragOver ? 'ring-2 ring-inset ring-blue-300' : ''}`}>
          <div className="flex items-center gap-2">
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

            {editingPriorityGroupId === group.id ? (
              <input
                autoFocus
                type="number"
                min={1}
                value={editingPriorityValue}
                onChange={(e) => setEditingPriorityValue(e.target.value)}
                onBlur={() => handleUpdatePriority(group.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleUpdatePriority(group.id)
                  if (e.key === 'Escape') setEditingPriorityGroupId(null)
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-16 rounded border border-indigo-300 px-1.5 py-0.5 text-xs font-medium text-indigo-700 text-center focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingPriorityGroupId(group.id)
                  setEditingPriorityValue(String(group.priority))
                }}
                className="rounded bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-100 transition-colors"
                title="Click to change priority (higher = evaluated first). Duplicate priorities cascade upward."
              >
                Priority {group.priority}
              </button>
            )}

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
              <td colSpan={7} className={`px-6 py-6 text-center text-xs text-gray-400 border border-gray-300 ${isDragOver ? 'bg-blue-50/50' : ''}`}>
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
              onDragStart={(e) => handleRuleDragStart(e, rule.id, group.id)}
              onDragEnd={handleRuleDragEnd}
              expandedConditions={expandedConditions}
              setExpandedConditions={setExpandedConditions}
            />
          ))}
        </>
      )}
    </>
  )
}

// ─── RuleRow component ───────────────────────────────────────────────────────

const CONDITION_TRUNCATE_LENGTH = 50

interface RuleRowProps {
  rule: OverrideRule
  getNodePath: (id: string) => string
  formatConditionSummary: (rule: OverrideRule) => string
  onEdit: (rule: OverrideRule) => void
  onDelete: (id: string) => void
  onToggle: (rule: OverrideRule) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
  expandedConditions: Set<string>
  setExpandedConditions: React.Dispatch<React.SetStateAction<Set<string>>>
  selectable?: boolean
  selected?: boolean
  onSelect?: (selected: boolean) => void
}

function RuleRow({
  rule, getNodePath, formatConditionSummary, onEdit, onDelete, onToggle,
  onDragStart, onDragEnd, expandedConditions, setExpandedConditions,
  selectable, selected, onSelect,
}: RuleRowProps) {
  const conditionText = formatConditionSummary(rule)
  const isLong = conditionText.length > CONDITION_TRUNCATE_LENGTH
  const isExpanded = expandedConditions.has(rule.id)

  return (
    <tr
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="group transition-colors hover:bg-slate-50"
    >
      {/* Drag handle + optional checkbox */}
      <td className="px-3 py-2 border border-gray-300 align-top cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-1.5">
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
      <td className="px-3 py-2 border border-gray-300 align-top">
        <span className="font-medium text-gray-900" title={rule.name}>
          {rule.name}
        </span>
        <div className="mt-1">
          <span className="inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-400 font-normal">
            {new Date(rule.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{' '}
            {new Date(rule.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </td>

      {/* Condition */}
      <td className="px-3 py-2 border border-gray-300 align-top">
        <div className="text-gray-600">
          {isLong && !isExpanded ? (
            <>
              <span>{conditionText.slice(0, CONDITION_TRUNCATE_LENGTH)}...</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setExpandedConditions(prev => { const n = new Set(prev); n.add(rule.id); return n })
                }}
                className="ml-1 text-blue-600 hover:text-blue-800 font-medium"
              >
                read more
              </button>
            </>
          ) : isLong && isExpanded ? (
            <>
              <span>{conditionText}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setExpandedConditions(prev => { const n = new Set(prev); n.delete(rule.id); return n })
                }}
                className="ml-1 text-blue-600 hover:text-blue-800 font-medium"
              >
                show less
              </button>
            </>
          ) : (
            <span>{conditionText}</span>
          )}
        </div>
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
          rule.source === 'auto_generated' ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'
        }`}>
          {rule.source === 'auto_generated' ? 'Auto' : 'Manual'}
        </span>
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
