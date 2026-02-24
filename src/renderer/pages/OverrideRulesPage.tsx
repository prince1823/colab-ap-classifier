import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import type { OverrideRule, RuleCondition, RuleOperator, RuleSource } from '../../shared/types/rules'
import type { TaxonomyNode, RulePackInfo } from '../../shared/types/taxonomy'

const OPERATORS: RuleOperator[] = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'regex', 'in_list', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal',
]

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: 'equals',
  not_equals: 'not equals',
  contains: 'contains',
  not_contains: 'not contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  regex: 'matches regex',
  in_list: 'in list',
  greater_than: '>',
  less_than: '<',
  greater_than_or_equal: '≥',
  less_than_or_equal: '≤',
}

export default function OverrideRulesPage() {
  const [rules, setRules] = useState<OverrideRule[]>([])
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [rulePacks, setRulePacks] = useState<RulePackInfo[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create/edit modal
  const [showEditor, setShowEditor] = useState(false)
  const [editingRule, setEditingRule] = useState<OverrideRule | null>(null)
  const [name, setName] = useState('')
  const [conditions, setConditions] = useState<RuleCondition[]>([{ field: '', operator: 'equals', value: '', connector: 'AND' }])
  const [targetNodeId, setTargetNodeId] = useState('')
  const [priority, setPriority] = useState(100)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, n, rp, cols] = await Promise.all([
        ipc.rules.list(),
        ipc.taxonomy.getNodes().catch(() => [] as TaxonomyNode[]),
        ipc.colabip.listRulePacks().catch(() => [] as RulePackInfo[]),
        ipc.transactions.getColumns().catch(() => [] as string[]),
      ])
      setRules(r)
      setTaxonomyNodes(n)
      setRulePacks(rp)
      setColumns(cols)
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
    setConditions([{ field: '', operator: 'equals', value: '', connector: 'AND' }])
    setTargetNodeId(taxonomyNodes[0]?.id || '')
    setPriority(100)
    setShowEditor(true)
  }

  const openEdit = (rule: OverrideRule) => {
    setEditingRule(rule)
    setName(rule.name)
    setConditions(rule.conditions.length > 0 ? rule.conditions.map(c => ({ ...c, connector: c.connector || 'AND' })) : [{ field: '', operator: 'equals', value: '', connector: 'AND' }])
    setTargetNodeId(rule.targetTaxonomyNodeId)
    setPriority(rule.priorityScore)
    setShowEditor(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
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

  const handleImport = async (packName: string) => {
    setImporting(true)
    setError(null)
    try {
      await ipc.rules.importFromColabip(packName)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import rules')
    } finally {
      setImporting(false)
    }
  }

  const updateCondition = (index: number, field: keyof RuleCondition, value: string) => {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)))
  }

  const addCondition = () => {
    setConditions((prev) => [...prev, { field: '', operator: 'equals' as RuleOperator, value: '', connector: 'AND' }])
  }

  const toggleConnector = (index: number) => {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, connector: c.connector === 'AND' ? 'OR' : 'AND' } : c)))
  }

  const removeCondition = (index: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== index))
  }

  const getNodePath = (nodeId: string) => taxonomyNodes.find((n) => n.id === nodeId)?.fullPath || nodeId

  const formatConditionSummary = (conds: RuleCondition[]) => {
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
        <div className="flex items-center gap-2">
          {rulePacks.length > 0 && (
            <select
              onChange={(e) => e.target.value && handleImport(e.target.value)}
              disabled={importing}
              defaultValue=""
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="" disabled>Import rule pack...</option>
              {rulePacks.map((rp) => (
                <option key={rp.name} value={rp.name}>{rp.name} ({rp.ruleCount})</option>
              ))}
            </select>
          )}
          <button onClick={openCreate} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Add Rule
          </button>
        </div>
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
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Target Classification</label>
            <select value={targetNodeId} onChange={(e) => setTargetNodeId(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              {taxonomyNodes.map((n) => (
                <option key={n.id} value={n.id}>{n.fullPath}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">Conditions</label>
              <button onClick={addCondition} className="text-xs text-blue-600 hover:text-blue-800">+ Add condition</button>
            </div>
            <div className="space-y-0">
              {conditions.map((c, i) => (
                <div key={i}>
                  {/* Condition row — reads like a sentence: field  operator  value */}
                  <div className="flex items-center gap-0 rounded-lg border border-gray-200 bg-gray-50 px-1 py-1">
                    <select
                      value={c.field as string}
                      onChange={(e) => updateCondition(i, 'field', e.target.value)}
                      className="rounded-md border-0 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-800 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400"
                    >
                      <option value="">field…</option>
                      {columns.map((col) => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                    <span className="px-1.5 text-[10px] text-gray-400 select-none">→</span>
                    <select
                      value={c.operator}
                      onChange={(e) => updateCondition(i, 'operator', e.target.value)}
                      className="rounded-md border-0 bg-white px-2.5 py-1.5 text-xs text-gray-600 shadow-sm ring-1 ring-gray-200 focus:ring-blue-400"
                    >
                      {OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
                    </select>
                    <span className="px-1.5 text-[10px] text-gray-400 select-none">→</span>
                    <input
                      value={String(c.value)}
                      onChange={(e) => updateCondition(i, 'value', e.target.value)}
                      placeholder="value"
                      className="min-w-0 flex-1 rounded-md border-0 bg-white px-2.5 py-1.5 text-xs text-gray-800 shadow-sm ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-blue-400"
                    />
                    {conditions.length > 1 && (
                      <button onClick={() => removeCondition(i)} className="ml-1 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors" title="Remove condition">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>
                  {/* AND/OR connector pill centered between rows */}
                  {i < conditions.length - 1 && (
                    <div className="flex justify-center py-1.5">
                      <button
                        onClick={() => toggleConnector(i)}
                        className={`rounded-full px-4 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                          c.connector === 'OR'
                            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                            : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
                        }`}
                      >
                        {c.connector || 'AND'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
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
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No override rules. Add rules or import from ColabIP.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
