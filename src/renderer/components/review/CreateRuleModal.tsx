import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { GroupedFilterBuilder, makeEmptyGroup } from '../FilterConditionBuilder'
import AdvancedFilterModal from './AdvancedFilterModal'
import { ipc } from '../../lib/ipc'
import type { GroupedFilter, ConditionGroup, FilterCondition } from '../../../shared/types/transactions'
import type { FieldDefinition } from '../FilterConditionBuilder'
import type { TaxonomyNode } from '../../../shared/types/taxonomy'
import type { FlattenedPivotRow } from '../../types/pivot'

interface CreateRuleModalProps {
  isOpen: boolean
  onClose: () => void
  /** Selected rows from the pivot table — used to pre-fill conditions */
  selectedRows: FlattenedPivotRow[]
  /** Called after successful rule creation */
  onCreated?: () => void
}

/**
 * Build a GroupedFilter from selected pivot rows.
 * Groups rows by dimensionField: values in the same field are OR'd via in_list,
 * different fields are AND'd together.
 */
function buildConditionsFromRows(rows: FlattenedPivotRow[]): GroupedFilter {
  // Only use the leaf (deepest) segment of each row — the one the user actually selected.
  // Ancestor segments (L1, L2 parents of an L3 row) are NOT included.
  const fieldValues = new Map<string, Set<string>>()
  for (const row of rows) {
    const leaf = row.pathSegments[row.pathSegments.length - 1]
    if (!leaf) continue
    if (!fieldValues.has(leaf.dimensionField)) {
      fieldValues.set(leaf.dimensionField, new Set())
    }
    fieldValues.get(leaf.dimensionField)!.add(leaf.value)
  }

  if (fieldValues.size === 0) {
    return { groupConnector: 'AND', groups: [makeEmptyGroup()] }
  }

  // Each value becomes its own individual "equals" condition, OR'd within a group per field
  // Multiple fields are AND'd via separate groups
  const groups: ConditionGroup[] = []
  for (const [field, values] of fieldValues) {
    const valArr = Array.from(values)
    const conditions: FilterCondition[] = valArr.map(v => ({
      field,
      operator: 'equals' as const,
      value: v,
      connector: 'OR' as const,
    }))
    groups.push({ connector: 'OR', conditions })
  }

  return { groupConnector: 'AND', groups }
}

export default function CreateRuleModal({
  isOpen,
  onClose,
  selectedRows,
  onCreated,
}: CreateRuleModalProps) {
  const [name, setName] = useState('')
  const [priority, setPriority] = useState(100)
  const [targetNodeId, setTargetNodeId] = useState('')
  const [grouped, setGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Taxonomy
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [taxonomySearch, setTaxonomySearch] = useState('')
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)

  // Conditions modal
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)

  // Filter fields for condition builder
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])

  // Load taxonomy nodes (full L1|L2|L3 paths only) and filter fields when modal opens
  useEffect(() => {
    if (!isOpen) return
    Promise.all([
      ipc.taxonomy.getNodes(),
      ipc.transactions.getFilterFields(),
    ]).then(([nodes, fields]) => {
      // Only show leaf nodes with full L1|L2|L3 path
      setTaxonomyNodes(nodes.filter((n: TaxonomyNode) => n.l3 !== null))
      setFilterFields(fields)
    }).catch(() => {})
  }, [isOpen])

  // Reset form when modal opens with new selected rows
  useEffect(() => {
    if (!isOpen) return
    setName('')
    setPriority(100)
    setTargetNodeId('')
    setError(null)
    setSaving(false)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setGrouped(buildConditionsFromRows(selectedRows))
  }, [isOpen, selectedRows])

  // Close taxonomy dropdown on outside click
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (taxonomyDropdownRef.current && !taxonomyDropdownRef.current.contains(e.target as Node)) {
        setTaxonomyDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [])

  const filteredTaxonomyNodes = useMemo(() => {
    if (!taxonomySearch.trim()) return taxonomyNodes
    const q = taxonomySearch.toLowerCase()
    return taxonomyNodes.filter(n => n.fullPath.toLowerCase().includes(q))
  }, [taxonomyNodes, taxonomySearch])

  const getNodePath = (nodeId: string) =>
    taxonomyNodes.find(n => n.id === nodeId)?.fullPath || nodeId

  const conditionCount = grouped.groups.flatMap(g => g.conditions.filter(c => c.field)).length

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Rule name is required')
      return
    }
    if (!targetNodeId) {
      setError('Target classification is required')
      return
    }

    setSaving(true)
    setError(null)
    try {
      await ipc.rules.create({
        name: name.trim(),
        groupedConditions: grouped,
        targetTaxonomyNodeId: targetNodeId,
        priorityScore: priority,
      })
      onCreated?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create rule')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Create Override Rule</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Create a rule from {selectedRows.length} selected row{selectedRows.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}

          {/* Rule Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Rule Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. IT Software suppliers"
              autoFocus
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Priority</label>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <p className="mt-0.5 text-[10px] text-gray-400">Lower number = higher priority. Rules are evaluated in priority order.</p>
          </div>

          {/* Target Classification */}
          <div ref={taxonomyDropdownRef} className="relative">
            <label className="mb-1 block text-xs font-medium text-gray-600">Target Classification</label>
            <button
              type="button"
              onClick={() => setTaxonomyDropdownOpen(!taxonomyDropdownOpen)}
              className="flex w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm hover:border-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
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
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setTargetNodeId(n.id)
                        setTaxonomyDropdownOpen(false)
                        setTaxonomySearch('')
                      }}
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

          {/* Conditions */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Conditions</label>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <span className="text-xs text-gray-600 truncate">
                {conditionCount > 0
                  ? `${conditionCount} condition${conditionCount !== 1 ? 's' : ''} configured (from selection)`
                  : 'No conditions configured'}
              </span>
              <button
                type="button"
                onClick={() => setConditionsModalOpen(true)}
                className="ml-3 shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50"
              >
                Edit Conditions
              </button>
            </div>
            {conditionCount > 0 && (
              <div className="mt-1.5 rounded border border-gray-100 bg-gray-50/50 px-2.5 py-1.5">
                <ConditionSummary grouped={grouped} />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {saving ? 'Creating...' : 'Create Rule'}
          </button>
        </div>
      </div>

      {/* Conditions editor modal — stacks on top */}
      <AdvancedFilterModal
        isOpen={conditionsModalOpen}
        onClose={() => setConditionsModalOpen(false)}
        groupedFilter={grouped}
        onApply={(g) => setGrouped(g ?? { groupConnector: 'AND', groups: [makeEmptyGroup()] })}
        availableFields={filterFields}
        title="Rule Conditions"
        subtitle="Define when this override rule applies"
      />
    </div>,
    document.body
  )
}

/** Compact inline summary of conditions */
function ConditionSummary({ grouped }: { grouped: GroupedFilter }) {
  const parts: string[] = []
  for (const group of grouped.groups) {
    const conds = group.conditions.filter(c => c.field)
    if (conds.length === 0) continue
    const condStrs = conds.map(c => {
      const val = Array.isArray(c.value) ? c.value.join(', ') : String(c.value)
      return `${c.field} ${c.operator} "${val}"`
    })
    parts.push(condStrs.join(` ${group.connector} `))
  }
  const summary = parts.join(` ${grouped.groupConnector} `)
  return (
    <p className="text-[10px] text-gray-500 leading-relaxed break-all">{summary}</p>
  )
}
