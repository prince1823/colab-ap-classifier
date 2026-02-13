import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import type { OverrideRule, RuleCondition, RuleOperator, RuleSource } from '../../shared/types/rules'
import type { TaxonomyNode, RulePackInfo } from '../../shared/types/taxonomy'

const OPERATORS: RuleOperator[] = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'regex', 'in_list', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal',
]

export default function OverrideRulesPage() {
  const [rules, setRules] = useState<OverrideRule[]>([])
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [rulePacks, setRulePacks] = useState<RulePackInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create/edit modal
  const [showEditor, setShowEditor] = useState(false)
  const [editingRule, setEditingRule] = useState<OverrideRule | null>(null)
  const [name, setName] = useState('')
  const [conditions, setConditions] = useState<RuleCondition[]>([{ field: '', operator: 'equals', value: '' }])
  const [targetNodeId, setTargetNodeId] = useState('')
  const [priority, setPriority] = useState(100)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, n, rp] = await Promise.all([
        ipc.rules.list(),
        ipc.taxonomy.getNodes().catch(() => [] as TaxonomyNode[]),
        ipc.colabip.listRulePacks().catch(() => [] as RulePackInfo[]),
      ])
      setRules(r)
      setTaxonomyNodes(n)
      setRulePacks(rp)
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
    setConditions([{ field: '', operator: 'equals', value: '' }])
    setTargetNodeId(taxonomyNodes[0]?.id || '')
    setPriority(100)
    setShowEditor(true)
  }

  const openEdit = (rule: OverrideRule) => {
    setEditingRule(rule)
    setName(rule.name)
    setConditions(rule.conditions.length > 0 ? rule.conditions : [{ field: '', operator: 'equals', value: '' }])
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
    setConditions((prev) => [...prev, { field: '', operator: 'equals' as RuleOperator, value: '' }])
  }

  const removeCondition = (index: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== index))
  }

  const getNodePath = (nodeId: string) => taxonomyNodes.find((n) => n.id === nodeId)?.fullPath || nodeId

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
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={c.field as string} onChange={(e) => updateCondition(i, 'field', e.target.value)} placeholder="Field" className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs" />
                  <select value={c.operator} onChange={(e) => updateCondition(i, 'operator', e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5 text-xs">
                    {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  <input value={String(c.value)} onChange={(e) => updateCondition(i, 'value', e.target.value)} placeholder="Value" className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs" />
                  {conditions.length > 1 && (
                    <button onClick={() => removeCondition(i)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
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
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No override rules. Add rules or import from ColabIP.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
