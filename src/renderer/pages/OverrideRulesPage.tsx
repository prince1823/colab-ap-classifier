import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ipc } from '../lib/ipc'
import { makeEmptyGroup, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import type { OverrideRule } from '../../shared/types/rules'
import type { FieldDefinition, GroupedFilter } from '../../shared/types/transactions'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

export default function OverrideRulesPage() {
  const [rules, setRules] = useState<OverrideRule[]>([])
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
  const [priority, setPriority] = useState(100)
  const [saving, setSaving] = useState(false)
  const [taxonomySearch, setTaxonomySearch] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  type GroupByMode = 'none' | 'condition_fields' | 'supplier_name' | 'supplier_line_desc' | 'supplier_line_gl' | 'target_classification'
  const [groupBy, setGroupBy] = useState<GroupByMode>('none')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const [groupByDropdownOpen, setGroupByDropdownOpen] = useState(false)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)
  const groupByDropdownRef = useRef<HTMLDivElement>(null)

  // Conditions modal
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)

  // Expanded conditions per rule
  const [expandedConditions, setExpandedConditions] = useState<Set<string>>(new Set())

  // Drag-and-drop reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, n, fields] = await Promise.all([
        ipc.rules.list(),
        ipc.taxonomy.getNodes(),
        ipc.transactions.getFilterFields(),
      ])
      setRules(r ?? [])
      setTaxonomyNodes(n ?? [])
      setFilterFields(fields ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const openCreate = () => {
    setEditingRule(null)
    setName('')
    setGrouped({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setTargetNodeId(taxonomyNodes[0]?.id || '')
    setPriority(100)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setShowEditor(true)
  }

  const openEdit = (rule: OverrideRule) => {
    setEditingRule(rule)
    setName(rule.name)
    setGrouped(rule.groupedConditions?.groups?.length > 0 ? rule.groupedConditions : { groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setTargetNodeId(rule.targetTaxonomyNodeId)
    setPriority(rule.priorityScore)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setShowEditor(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      if (editingRule) {
        await ipc.rules.update(editingRule.id, { name, groupedConditions: grouped, targetTaxonomyNodeId: targetNodeId, priorityScore: priority })
      } else {
        await ipc.rules.create({ name, groupedConditions: grouped, targetTaxonomyNodeId: targetNodeId, priorityScore: priority })
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
    // Optimistic update — no loading flash
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r))
    try {
      await ipc.rules.update(rule.id, { isActive: !rule.isActive })
    } catch (e) {
      // Revert on failure
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: rule.isActive } : r))
      setError(e instanceof Error ? e.message : 'Failed to toggle rule')
    }
  }

  // Drag-and-drop reorder
  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
    // Make the dragged row semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.4'
    }
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    setDragIdx(null)
    setOverIdx(null)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIdx(idx)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, toIdx: number) => {
    e.preventDefault()
    const fromIdx = dragIdx
    setDragIdx(null)
    setOverIdx(null)
    if (fromIdx === null || fromIdx === toIdx) return

    const rule = rules[fromIdx]
    if (!rule) return

    // New rank is 1-based position (toIdx + 1)
    const newRank = toIdx + 1
    try {
      await ipc.rules.update(rule.id, { priorityScore: newRank })
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder rule')
    }
  }, [dragIdx, rules])

  // Searchable taxonomy dropdown
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

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (groupByDropdownRef.current && !groupByDropdownRef.current.contains(e.target as Node)) {
        setGroupByDropdownOpen(false)
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

  const filteredRules = useMemo(() => {
    if (!ruleSearch.trim()) return rules
    const q = ruleSearch.toLowerCase()
    return rules.filter(r => {
      const target = getNodePath(r.targetTaxonomyNodeId).toLowerCase()
      const conditions = formatConditionSummary(r).toLowerCase()
      const source = r.source === 'auto_generated' ? 'auto' : 'manual'
      const status = r.isActive ? 'active' : 'inactive'
      const priority = String(r.priorityScore)
      return (
        r.name.toLowerCase().includes(q) ||
        target.includes(q) ||
        conditions.includes(q) ||
        source.includes(q) ||
        status.includes(q) ||
        priority.includes(q)
      )
    })
  }, [rules, ruleSearch, taxonomyNodes])

  const getConditionFieldsKey = (rule: OverrideRule): string => {
    const fields = new Set<string>()
    for (const group of rule.groupedConditions?.groups ?? []) {
      for (const cond of group.conditions) {
        if (cond.field) fields.add(cond.field)
      }
    }
    if (fields.size === 0) return 'No conditions'
    return [...fields].sort().join(' + ')
  }

  const groupedRules = useMemo(() => {
    if (groupBy === 'none') return [{ key: '__all__', rules: filteredRules }]
    const getConditionValue = (rule: OverrideRule, field: string): string => {
      for (const group of rule.groupedConditions?.groups ?? []) {
        for (const cond of group.conditions) {
          if (cond.field === field && cond.value) return String(cond.value)
        }
      }
      return ''
    }
    const getSupplierKey = (rule: OverrideRule): string => getConditionValue(rule, 'supplier_name') || 'No supplier'
    const getSupplierLineKey = (rule: OverrideRule): string => {
      const supplier = getConditionValue(rule, 'supplier_name') || 'No supplier'
      const line = getConditionValue(rule, 'line_description') || 'No line desc'
      return `${supplier} | ${line}`
    }
    const getSupplierLineGlKey = (rule: OverrideRule): string => {
      const supplier = getConditionValue(rule, 'supplier_name') || 'No supplier'
      const line = getConditionValue(rule, 'line_description') || 'No line desc'
      const gl = getConditionValue(rule, 'gl_description') || 'No GL desc'
      return `${supplier} | ${line} | ${gl}`
    }
    const getTargetKey = (rule: OverrideRule): string => getNodePath(rule.targetTaxonomyNodeId) || 'Unclassified'
    const keyFns: Record<string, (r: OverrideRule) => string> = {
      condition_fields: getConditionFieldsKey,
      supplier_name: getSupplierKey,
      supplier_line_desc: getSupplierLineKey,
      supplier_line_gl: getSupplierLineGlKey,
      target_classification: getTargetKey,
    }
    const keyFn = keyFns[groupBy] ?? getConditionFieldsKey
    const map = new Map<string, OverrideRule[]>()
    for (const rule of filteredRules) {
      const key = keyFn(rule)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(rule)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, rules]) => ({ key, rules }))
  }, [filteredRules, groupBy, taxonomyNodes])

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Override Rules</h2>
          <p className="mt-1 text-sm text-gray-500">{rules.length} rules</p>
        </div>
        <div className="flex items-center gap-2">
          <div ref={groupByDropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setGroupByDropdownOpen(!groupByDropdownOpen)}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-600 hover:border-gray-400"
            >
              <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" /></svg>
              <span>{{ none: 'No grouping', condition_fields: 'Condition fields', supplier_name: 'Supplier', supplier_line_desc: 'Supplier + Line', supplier_line_gl: 'Supplier + Line + GL', target_classification: 'Classification' }[groupBy]}</span>
              <svg className={`h-3 w-3 text-gray-400 transition-transform ${groupByDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
            </button>
            {groupByDropdownOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-gray-200 bg-white py-1 shadow-lg">
                {([
                  ['none', 'No grouping'],
                  ['condition_fields', 'Condition fields'],
                  ['supplier_name', 'Supplier name'],
                  ['supplier_line_desc', 'Supplier + Line desc'],
                  ['supplier_line_gl', 'Supplier + Line + GL desc'],
                  ['target_classification', 'Target classification'],
                ] as [GroupByMode, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => { setGroupBy(value); setCollapsedGroups(new Set()); setGroupByDropdownOpen(false) }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${groupBy === value ? 'font-medium text-blue-600' : 'text-gray-700'}`}
                  >
                    {groupBy === value && <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                    {groupBy !== value && <span className="h-3 w-3" />}
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {groupBy !== 'none' && (
            <button
              onClick={() => {
                const allExpanded = collapsedGroups.size === 0
                if (allExpanded) {
                  setCollapsedGroups(new Set(groupedRules.map(g => g.key)))
                } else {
                  setCollapsedGroups(new Set())
                }
              }}
              title={collapsedGroups.size === 0 ? 'Collapse all' : 'Expand all'}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              {collapsedGroups.size === 0 ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 9L3.75 3.75M9 9H3.75M9 9V3.75m6 11.25l5.25 5.25M15 15h5.25M15 15v5.25" /></svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
              )}
            </button>
          )}
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
          <button onClick={openCreate} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Add Rule
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Priority</label>
              <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
            </div>
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
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setShowEditor(false)} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="w-8 px-1 py-3"></th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Conditions</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Target</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase text-gray-500">Source</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Actions</th>
            </tr>
          </thead>
          {groupedRules.map(({ key, rules: groupRuleList }) => (
            <tbody key={key} className="divide-y divide-gray-100 bg-white">
              {groupBy !== 'none' && (
                <tr
                  className="cursor-pointer border-l-2 border-blue-400 bg-gray-50 hover:bg-gray-100"
                  onClick={() => toggleGroup(key)}
                >
                  <td colSpan={7} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <svg
                        className={`h-4 w-4 text-gray-500 transition-transform duration-150 ${collapsedGroups.has(key) ? '' : 'rotate-90'}`}
                        fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                      <span className="text-xs font-semibold text-gray-700">{key}</span>
                      <span className="text-xs text-gray-400">({groupRuleList.length})</span>
                    </div>
                  </td>
                </tr>
              )}
              {!collapsedGroups.has(key) && groupRuleList.map((rule, idx) => (
                <tr
                  key={rule.id}
                  draggable={groupBy === 'none'}
                  onDragStart={groupBy === 'none' ? (e) => handleDragStart(e, idx) : undefined}
                  onDragEnd={groupBy === 'none' ? handleDragEnd : undefined}
                  onDragOver={groupBy === 'none' ? (e) => handleDragOver(e, idx) : undefined}
                  onDrop={groupBy === 'none' ? (e) => handleDrop(e, idx) : undefined}
                  className={`hover:bg-gray-50 ${
                    groupBy === 'none' && overIdx === idx && dragIdx !== null && dragIdx !== idx
                      ? 'border-t-2 border-blue-400'
                      : ''
                  }`}
                >
                  <td className="w-8 px-1 py-2 text-center text-gray-300 hover:text-gray-500">
                    {groupBy === 'none' && (
                      <svg className="mx-auto h-4 w-4 cursor-grab" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
                    )}
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-900">
                    {rule.name}
                    <sup
                      className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 px-1 text-[9px] font-bold text-white shadow-sm"
                      title={`Priority: ${rule.priorityScore}`}
                    >
                      {rule.priorityScore}
                    </sup>
                  </td>
                  <td className="max-w-xs px-4 py-2">
                    {(() => {
                      const summary = formatConditionSummary(rule)
                      const isExpanded = expandedConditions.has(rule.id)
                      const isLong = summary.length > 80
                      return (
                        <div>
                          <span className={`text-[11px] text-gray-500 leading-tight ${isExpanded ? '' : 'line-clamp-2'}`}>{summary}</span>
                          {isLong && (
                            <button
                              onClick={() => setExpandedConditions(prev => {
                                const next = new Set(prev)
                                if (next.has(rule.id)) next.delete(rule.id)
                                else next.add(rule.id)
                                return next
                              })}
                              className="mt-0.5 block text-[10px] font-medium text-blue-600 hover:text-blue-800"
                            >
                              {isExpanded ? 'Show less' : 'Read more'}
                            </button>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{getNodePath(rule.targetTaxonomyNodeId)}</td>
                  <td className="px-4 py-2 text-center">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      rule.source === 'auto_generated'
                        ? 'bg-purple-50 text-purple-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {rule.source === 'auto_generated' ? 'Auto' : 'Manual'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button onClick={() => handleToggle(rule)} className={`text-xs font-medium ${rule.isActive ? 'text-green-600' : 'text-gray-400'}`}>
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => openEdit(rule)} className="rounded p-1 text-blue-600 hover:bg-blue-50" title="Edit">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
                      </button>
                      <button onClick={() => handleDelete(rule.id)} className="rounded p-1 text-red-500 hover:bg-red-50" title="Delete">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          {rules.length === 0 && (
            <tbody><tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No override rules yet.</td></tr></tbody>
          )}
        </table>
      </div>
    </div>
  )
}
