import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ipc } from '../lib/ipc'
import { makeEmptyGroup, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import type { OverrideRule, RuleGroup } from '../../shared/types/rules'
import type { FieldDefinition, GroupedFilter } from '../../shared/types/transactions'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

// ─── Drag type constants ─────────────────────────────────────────────────────
const DRAG_TYPE_RULE = 'application/x-rule-drag'
const DRAG_TYPE_GROUP = 'application/x-group-drag'

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
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupPriority, setNewGroupPriority] = useState('')
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null)

  // Conditions modal
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)

  // Expanded conditions per rule
  const [expandedConditions, setExpandedConditions] = useState<Set<string>>(new Set())

  // Drag-and-drop refs
  const dragTypeRef = useRef<'rule' | 'group' | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const dragSourceGroupRef = useRef<string | null>(null)
  const prevOverRow = useRef<HTMLElement | null>(null)

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
    try {
      await ipc.rules.delete(ruleId)
      await loadData()
    } catch (e) {
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
      setError('Priority must be an integer >= 1')
      return
    }
    try {
      await ipc.rules.createGroup({ name: newGroupName.trim(), priority })
      setNewGroupName('')
      setNewGroupPriority('')
      setShowNewGroupInput(false)
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
    try {
      await ipc.rules.deleteGroup(groupId)
      setDeletingGroupId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete group')
    }
  }

  // ─── Drag-and-drop: Rule move across groups ───────────────────────────────

  const handleRuleDragStart = useCallback((e: React.DragEvent, ruleId: string, sourceGroupId: string | null) => {
    dragTypeRef.current = 'rule'
    dragIdRef.current = ruleId
    dragSourceGroupRef.current = sourceGroupId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE_RULE, ruleId)
    requestAnimationFrame(() => {
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.4'
    })
  }, [])

  const handleRuleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1'
    if (prevOverRow.current) { prevOverRow.current.style.borderTop = ''; prevOverRow.current = null }
    dragTypeRef.current = null
    dragIdRef.current = null
    dragSourceGroupRef.current = null
  }, [])

  const handleRuleDragOver = useCallback((e: React.DragEvent) => {
    if (dragTypeRef.current !== 'rule') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const row = e.currentTarget as HTMLElement
    if (prevOverRow.current !== row) {
      if (prevOverRow.current) prevOverRow.current.style.borderTop = ''
      row.style.borderTop = '2px solid #60a5fa'
      prevOverRow.current = row
    }
  }, [])

  const handleRuleDropOnGroup = useCallback(async (e: React.DragEvent, targetGroupId: string | null) => {
    e.preventDefault()
    if (prevOverRow.current) { prevOverRow.current.style.borderTop = ''; prevOverRow.current = null }
    const draggedId = dragIdRef.current
    if (!draggedId || dragTypeRef.current !== 'rule') return
    if (dragSourceGroupRef.current === targetGroupId) return

    try {
      await ipc.rules.moveRule(draggedId, targetGroupId)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move rule')
      await loadData()
    }
  }, [])

  // ─── Drag-and-drop: Group reorder ─────────────────────────────────────────

  const handleGroupDragStart = useCallback((e: React.DragEvent, groupId: string) => {
    dragTypeRef.current = 'group'
    dragIdRef.current = groupId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE_GROUP, groupId)
    requestAnimationFrame(() => {
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.5'
    })
  }, [])

  const handleGroupDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1'
    if (prevOverRow.current) { prevOverRow.current.style.borderTop = ''; prevOverRow.current = null }
    dragTypeRef.current = null
    dragIdRef.current = null
  }, [])

  const handleGroupDragOver = useCallback((e: React.DragEvent) => {
    if (dragTypeRef.current === 'group') {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const el = e.currentTarget as HTMLElement
      if (prevOverRow.current !== el) {
        if (prevOverRow.current) prevOverRow.current.style.borderTop = ''
        el.style.borderTop = '2px solid #818cf8'
        prevOverRow.current = el
      }
    } else if (dragTypeRef.current === 'rule') {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const el = e.currentTarget as HTMLElement
      if (prevOverRow.current !== el) {
        if (prevOverRow.current) prevOverRow.current.style.borderTop = ''
        el.style.borderTop = '2px solid #60a5fa'
        prevOverRow.current = el
      }
    }
  }, [])

  const handleGroupDrop = useCallback(async (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault()
    if (prevOverRow.current) { prevOverRow.current.style.borderTop = ''; prevOverRow.current = null }

    if (dragTypeRef.current === 'group') {
      const draggedId = dragIdRef.current
      if (!draggedId || draggedId === targetGroupId) return
      const currentOrder = groups.map(g => g.id)
      const newOrder = currentOrder.filter(id => id !== draggedId)
      const targetIdx = newOrder.indexOf(targetGroupId)
      newOrder.splice(targetIdx, 0, draggedId)
      try {
        await ipc.rules.reorderGroups(newOrder)
        await loadData()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to reorder groups')
        await loadData()
      }
    } else if (dragTypeRef.current === 'rule') {
      await handleRuleDropOnGroup(e, targetGroupId)
    }
  }, [groups, handleRuleDropOnGroup])

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

  // Group rules by groupId; ungrouped → UNGROUPED_ID
  const rulesByGroup = useMemo(() => {
    const map = new Map<string, OverrideRule[]>()
    for (const group of groups) map.set(group.id, [])
    map.set(UNGROUPED_ID, [])
    for (const rule of filteredRules) {
      const key = rule.groupId ?? UNGROUPED_ID
      const list = map.get(key) ?? map.get(UNGROUPED_ID)!
      if (!map.has(key)) map.set(UNGROUPED_ID, [...(map.get(UNGROUPED_ID) ?? []), rule])
      else list.push(rule)
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

  // Groups displayed highest priority first (already sorted by listGroups DESC)
  // Ungrouped column is always last
  const allColumnIds: string[] = [...groups.map(g => g.id), UNGROUPED_ID]

  return (
    <div className="space-y-4 p-6">
      {/* Header toolbar */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Override Rules</h2>
          <p className="mt-1 text-sm text-gray-500">{rules.length} rules in {groups.length} group{groups.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSourceFilter(prev => prev === 'all' ? 'manual' : prev === 'manual' ? 'auto' : 'all')}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              sourceFilter === 'all'
                ? 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                : sourceFilter === 'manual'
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-purple-300 bg-purple-50 text-purple-700'
            }`}
            title={`Showing: ${sourceFilter === 'all' ? 'All rules' : sourceFilter === 'manual' ? 'Manual rules only' : 'Auto-generated rules only'}. Click to cycle.`}
          >
            {sourceFilter === 'all' && 'All Rules'}
            {sourceFilter === 'manual' && 'Manual'}
            {sourceFilter === 'auto' && 'Auto'}
          </button>
          {/* Collapse / Expand all */}
          <button
            onClick={() => {
              const allCollapsed = collapsedGroups.size === allColumnIds.length
              if (allCollapsed) setCollapsedGroups(new Set())
              else setCollapsedGroups(new Set(allColumnIds))
            }}
            title={collapsedGroups.size === allColumnIds.length ? 'Expand all' : 'Collapse all'}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            {collapsedGroups.size === allColumnIds.length ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 9L3.75 3.75M9 9H3.75M9 9V3.75m6 11.25l5.25 5.25M15 15h5.25M15 15v5.25" /></svg>
            )}
          </button>
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search rules..."
              value={ruleSearch}
              onChange={(e) => setRuleSearch(e.target.value)}
              className="w-64 rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => setShowNewGroupInput(true)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            + Group
          </button>
          <button onClick={() => openCreate()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Add Rule
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {/* Rule editor panel */}
      {showEditor && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
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
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Group</label>
              <select
                value={editorGroupId ?? ''}
                onChange={(e) => setEditorGroupId(e.target.value || null)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Ungrouped</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name} (priority {g.priority})</option>
                ))}
              </select>
            </div>
            <div ref={taxonomyDropdownRef} className="relative">
              <label className="mb-1 block text-xs font-medium text-gray-600">Target Classification</label>
              <button
                type="button"
                onClick={() => setTaxonomyDropdownOpen(!taxonomyDropdownOpen)}
                className="flex w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm hover:border-gray-400"
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

      {/* Kanban board */}
      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 280px)' }}>
        {/* Named groups (sorted by priority DESC, highest first) */}
        {groups.map((group) => {
          const groupRules = rulesByGroup.get(group.id) ?? []
          if (ruleSearch.trim() && groupRules.length === 0) return null

          return (
            <div
              key={group.id}
              className="flex w-80 min-w-[320px] shrink-0 flex-col rounded-xl border border-gray-200 bg-gray-50"
            >
              {/* Column header */}
              <div
                draggable
                onDragStart={(e) => handleGroupDragStart(e, group.id)}
                onDragEnd={handleGroupDragEnd}
                onDragOver={handleGroupDragOver}
                onDrop={(e) => handleGroupDrop(e, group.id)}
                className="flex flex-col gap-1 rounded-t-xl bg-white px-3 py-3 border-b border-gray-200 cursor-grab active:cursor-grabbing select-none"
              >
                <div className="flex items-center gap-2">
                  <svg className="h-3.5 w-3.5 text-gray-300 hover:text-gray-500 shrink-0" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>

                  {editingGroupId === group.id ? (
                    <input
                      autoFocus
                      value={editingGroupName}
                      onChange={(e) => setEditingGroupName(e.target.value)}
                      onBlur={() => handleRenameGroup(group.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameGroup(group.id); if (e.key === 'Escape') setEditingGroupId(null); }}
                      className="min-w-0 flex-1 rounded border border-blue-300 px-1.5 py-0.5 text-xs font-semibold text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-800"
                      onDoubleClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }}
                      title={group.name}
                    >
                      {group.name}
                    </span>
                  )}

                  <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-medium text-gray-600 shrink-0">
                    {groupRules.length}
                  </span>
                  <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium text-indigo-600 shrink-0" title="Priority — higher = evaluated first">
                    P{group.priority}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => openCreate(group.id)}
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    title="Add rule to this group"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                  </button>
                  <button
                    onClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }}
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    title="Rename"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
                  </button>
                  <button
                    onClick={() => setDeletingGroupId(group.id)}
                    className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                    title="Delete group"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                  </button>
                </div>
              </div>

              {/* Card list */}
              {!collapsedGroups.has(group.id) && (
                <div
                  className="flex-1 space-y-2 overflow-y-auto p-2"
                  style={{ maxHeight: 'calc(100vh - 340px)' }}
                  onDragOver={(e) => { if (dragTypeRef.current === 'rule') { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
                  onDrop={(e) => handleRuleDropOnGroup(e, group.id)}
                >
                  {groupRules.length === 0 && (
                    <div className="rounded-lg border border-dashed border-gray-300 px-3 py-8 text-center text-[11px] text-gray-400">
                      Drop rules here
                    </div>
                  )}
                  {groupRules.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      getNodePath={getNodePath}
                      formatConditionSummary={formatConditionSummary}
                      onEdit={openEdit}
                      onDelete={handleDelete}
                      onToggle={handleToggle}
                      onDragStart={(e) => handleRuleDragStart(e, rule.id, group.id)}
                      onDragEnd={handleRuleDragEnd}
                      onDragOver={handleRuleDragOver}
                      expandedConditions={expandedConditions}
                      setExpandedConditions={setExpandedConditions}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* Ungrouped column — always last, not draggable */}
        {(() => {
          const ungroupedRules = rulesByGroup.get(UNGROUPED_ID) ?? []
          if (ruleSearch.trim() && ungroupedRules.length === 0) return null
          return (
            <div className="flex w-80 min-w-[320px] shrink-0 flex-col rounded-xl border border-dashed border-gray-300 bg-gray-50/60">
              <div
                className="flex items-center gap-2 rounded-t-xl bg-white/80 px-3 py-3 border-b border-gray-200 select-none"
                onDragOver={(e) => { if (dragTypeRef.current === 'rule') { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
                onDrop={(e) => handleRuleDropOnGroup(e, null)}
              >
                <span className="min-w-0 flex-1 text-xs font-semibold text-gray-400">Ungrouped</span>
                <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-medium text-gray-500 shrink-0">
                  {ungroupedRules.length}
                </span>
                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 shrink-0" title="Ungrouped rules are evaluated last">
                  last
                </span>
              </div>
              {!collapsedGroups.has(UNGROUPED_ID) && (
                <div
                  className="flex-1 space-y-2 overflow-y-auto p-2"
                  style={{ maxHeight: 'calc(100vh - 340px)' }}
                  onDragOver={(e) => { if (dragTypeRef.current === 'rule') { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
                  onDrop={(e) => handleRuleDropOnGroup(e, null)}
                >
                  {ungroupedRules.length === 0 && (
                    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-8 text-center text-[11px] text-gray-400">
                      Drop rules here to ungroup
                    </div>
                  )}
                  {ungroupedRules.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      getNodePath={getNodePath}
                      formatConditionSummary={formatConditionSummary}
                      onEdit={openEdit}
                      onDelete={handleDelete}
                      onToggle={handleToggle}
                      onDragStart={(e) => handleRuleDragStart(e, rule.id, null)}
                      onDragEnd={handleRuleDragEnd}
                      onDragOver={handleRuleDragOver}
                      expandedConditions={expandedConditions}
                      setExpandedConditions={setExpandedConditions}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })()}

        {/* Add group column */}
        {showNewGroupInput ? (
          <div className="flex w-80 min-w-[320px] shrink-0 flex-col rounded-xl border border-dashed border-gray-300 bg-gray-50 overflow-hidden">
            <div className="border-b border-gray-200 bg-white px-3 py-2.5 space-y-2">
              <input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setShowNewGroupInput(false); setNewGroupName(''); setNewGroupPriority('') } }}
                placeholder="Group name..."
                className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <input
                value={newGroupPriority}
                onChange={(e) => setNewGroupPriority(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newGroupName.trim()) handleCreateGroup() }}
                placeholder="Priority (integer ≥ 1, higher = applied first)..."
                type="number"
                min={1}
                className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <div className="flex gap-1.5">
                <button onClick={handleCreateGroup} className="flex-1 rounded-md bg-blue-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Create</button>
                <button onClick={() => { setShowNewGroupInput(false); setNewGroupName(''); setNewGroupPriority('') }} className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowNewGroupInput(true)}
            className="flex w-16 min-w-[64px] shrink-0 items-center justify-center rounded-xl border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-500 hover:bg-gray-50 transition-colors"
            title="Add group"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          </button>
        )}
      </div>

      {rules.length === 0 && groups.length === 0 && (
        <div className="text-center py-8 text-gray-500 text-sm">
          No override rules yet. Create groups to organize your rules, then add rules to classify vendors.
        </div>
      )}
    </div>
  )
}

// ─── RuleCard component ───────────────────────────────────────────────────────

interface RuleCardProps {
  rule: OverrideRule
  getNodePath: (id: string) => string
  formatConditionSummary: (rule: OverrideRule) => string
  onEdit: (rule: OverrideRule) => void
  onDelete: (id: string) => void
  onToggle: (rule: OverrideRule) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  expandedConditions: Set<string>
  setExpandedConditions: React.Dispatch<React.SetStateAction<Set<string>>>
}

function RuleCard({ rule, getNodePath, formatConditionSummary, onEdit, onDelete, onToggle, onDragStart, onDragEnd, onDragOver, expandedConditions, setExpandedConditions }: RuleCardProps) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      className="group cursor-grab rounded-lg border border-gray-200 bg-white p-2.5 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      <div className="flex items-start gap-1.5">
        <svg className="mt-0.5 h-3 w-3 shrink-0 text-gray-300 group-hover:text-gray-400" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900" title={rule.name}>
          {rule.name}
        </span>
        <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onEdit(rule)} className="rounded p-0.5 text-blue-500 hover:bg-blue-50" title="Edit">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
          </button>
          <button onClick={() => onDelete(rule.id)} className="rounded p-0.5 text-red-400 hover:bg-red-50" title="Delete">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
          </button>
        </div>
      </div>

      <p className="mt-1 text-[10px] leading-tight text-gray-500 line-clamp-2">
        {formatConditionSummary(rule)}
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="truncate rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 max-w-[200px]" title={getNodePath(rule.targetTaxonomyNodeId)}>
          {getNodePath(rule.targetTaxonomyNodeId)}
        </span>
        <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${
          rule.source === 'auto_generated' ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'
        }`}>
          {rule.source === 'auto_generated' ? 'Auto' : 'Manual'}
        </span>
        <button
          onClick={() => onToggle(rule)}
          className={`rounded px-1 py-0.5 text-[9px] font-medium ${
            rule.isActive ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400'
          }`}
        >
          {rule.isActive ? 'Active' : 'Inactive'}
        </button>
      </div>
    </div>
  )
}
