import { useState, useEffect, useMemo, useRef } from 'react'
import { ipc } from '../lib/ipc'
import { GroupedFilterBuilder, conditionsToGrouped, groupedToConditions, makeEmptyGroup, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import type { OverrideRule } from '../../shared/types/rules'
import type { FilterCondition, FieldDefinition, GroupedFilter } from '../../shared/types/transactions'
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
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)

  // Distinct values for autocomplete suggestions (fetched when editor opens)
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({})

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, n, fields] = await Promise.all([
        ipc.rules.list(),
        ipc.taxonomy.getNodes(),
        ipc.transactions.getFilterFields(),
      ])
      setRules(r)
      setTaxonomyNodes(n)
      setFilterFields(fields)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  // Fetch distinct values for string fields when editor opens
  useEffect(() => {
    if (!showEditor) return
    setDistinctValues({})
    const stringFields = filterFields.filter(f => f.type === 'string').map(f => f.name)
    for (const field of stringFields) {
      ipc.transactions.distinctValues(field, 5000)
        .then((values: string[]) => {
          setDistinctValues(prev => ({ ...prev, [field]: values ?? [] }))
        })
        .catch(() => {
          setDistinctValues(prev => ({ ...prev, [field]: [] }))
        })
    }
  }, [showEditor, filterFields])

  // Enrich string fields with fresh suggestions
  const enrichedFields: FieldDefinition[] = useMemo(() =>
    filterFields.map(f => {
      const values = distinctValues[f.name]
      if (values && values.length > 0 && f.type === 'string') {
        return { ...f, suggestions: values }
      }
      return f
    }),
    [filterFields, distinctValues]
  )

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
    setGrouped(rule.conditions.length > 0 ? conditionsToGrouped(rule.conditions) : { groupConnector: 'AND', groups: [makeEmptyGroup()] })
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
      const conditions = groupedToConditions(grouped)
      if (editingRule) {
        await ipc.rules.update(editingRule.id, { name, conditions, targetTaxonomyNodeId: targetNodeId, priorityScore: priority })
      } else {
        await ipc.rules.create({ name, source: 'project', conditions, targetTaxonomyNodeId: targetNodeId, priorityScore: priority })
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
    try {
      await ipc.rules.update(rule.id, { isActive: !rule.isActive })
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle rule')
    }
  }

  // Searchable taxonomy dropdown
  const filteredTaxonomyNodes = useMemo(() => {
    if (!taxonomySearch.trim()) return taxonomyNodes
    const q = taxonomySearch.toLowerCase()
    return taxonomyNodes.filter(n => n.fullPath.toLowerCase().includes(q))
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

  const formatConditionSummary = (conds: FilterCondition[]) => {
    if (conds.length === 0) return 'No conditions'
    return conds.map((c, i) => {
      const parts = `${c.field} ${OPERATOR_LABELS[c.operator]} "${c.value}"`
      if (i < conds.length - 1) {
        return `${parts} ${c.connector || 'AND'}`
      }
      return parts
    }).join(' ')
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
        <button onClick={openCreate} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Add Rule
        </button>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {showEditor && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
          <h3 className="text-sm font-medium text-gray-700">{editingRule ? 'Edit Rule' : 'New Rule'}</h3>
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
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Conditions</label>
            <GroupedFilterBuilder
              value={grouped}
              onChange={setGrouped}
              availableFields={enrichedFields}
            />
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
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Conditions</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Source</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase text-gray-500">Priority</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Target</th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase text-gray-500">Active</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {rules.map((rule) => (
              <tr key={rule.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">{rule.name}</td>
                <td className="max-w-xs px-4 py-2">
                  <span className="text-[11px] text-gray-500 leading-tight line-clamp-2">{formatConditionSummary(rule.conditions)}</span>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    rule.source === 'project' ? 'bg-blue-100 text-blue-700' :
                    rule.source === 'taxonomy' ? 'bg-green-100 text-green-700' :
                    'bg-purple-100 text-purple-700'
                  }`}>{rule.source}</span>
                </td>
                <td className="px-4 py-2 text-center text-gray-600">{rule.priorityScore}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{getNodePath(rule.targetTaxonomyNodeId)}</td>
                <td className="px-4 py-2 text-center">
                  <button onClick={() => handleToggle(rule)} className={`text-xs font-medium ${rule.isActive ? 'text-green-600' : 'text-gray-400'}`}>
                    {rule.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => openEdit(rule)} className="text-xs text-blue-600 hover:text-blue-800">Edit</button>
                    <button onClick={() => handleDelete(rule.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No override rules yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
