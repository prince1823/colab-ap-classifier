import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Check } from 'lucide-react'
import { makeEmptyGroup } from '../FilterConditionBuilder'
import AdvancedFilterModal from './AdvancedFilterModal'
import { ipc } from '../../lib/ipc'
import type { GroupedFilter, ConditionGroup, FilterCondition } from '../../../shared/types/transactions'
import type { FieldDefinition } from '../FilterConditionBuilder'
import type { TaxonomyNode } from '../../../shared/types/taxonomy'
import type { FlattenedPivotRow } from '../../types/pivot'
import type { RuleGroup } from '../../../shared/types/rules'

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
  const [targetNodeId, setTargetNodeId] = useState('')
  const [grouped, setGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Taxonomy
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [taxonomySearch, setTaxonomySearch] = useState('')
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const [taxonomyHighlightIdx, setTaxonomyHighlightIdx] = useState(-1)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)
  const taxonomyListRef = useRef<HTMLUListElement>(null)

  // Conditions modal
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)

  // Filter fields for condition builder
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])

  // Rule groups
  const [ruleGroups, setRuleGroups] = useState<RuleGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  // Refs for keyboard navigation
  const nameInputRef = useRef<HTMLInputElement>(null)
  const taxonomyBtnRef = useRef<HTMLButtonElement>(null)
  const taxonomySearchRef = useRef<HTMLInputElement>(null)
  const editConditionsBtnRef = useRef<HTMLButtonElement>(null)
  const saveBtnRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear auto-close timer on unmount
  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current) }, [])

  // Load taxonomy nodes (full L1|L2|L3 paths only) and filter fields when modal opens
  useEffect(() => {
    if (!isOpen) return
    Promise.all([
      ipc.taxonomy.getNodes(),
      ipc.transactions.getFilterFields(),
      ipc.rules.listGroups(),
    ]).then(([nodes, fields, groups]) => {
      // Only show leaf nodes with full L1|L2|L3 path
      setTaxonomyNodes(nodes.filter((n: TaxonomyNode) => n.l3 !== null))
      setFilterFields(fields)
      setRuleGroups(groups ?? [])
    }).catch(() => {})
  }, [isOpen])

  // Reset form only when modal first opens
  const prevOpenRef = useRef(false)
  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current
    prevOpenRef.current = isOpen
    if (!justOpened) return
    setName('')
    setTargetNodeId('')
    setError(null)
    setSaving(false)
    setSuccessMessage(null)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setTaxonomyHighlightIdx(-1)
    setGrouped(buildConditionsFromRows(selectedRows))
    // Focus the rule name input after modal opens
    requestAnimationFrame(() => nameInputRef.current?.focus())
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

  // Reset highlight when filtered list changes
  useEffect(() => {
    setTaxonomyHighlightIdx(-1)
  }, [filteredTaxonomyNodes])

  const getNodePath = (nodeId: string) =>
    taxonomyNodes.find(n => n.id === nodeId)?.fullPath || nodeId

  const conditionCount = grouped.groups.flatMap(g => g.conditions.filter(c => c.field)).length

  const handleSave = useCallback(async () => {
    if (conditionCount === 0) {
      setError('At least one condition is required')
      return
    }
    if (!name.trim()) {
      setError('Rule name is required')
      nameInputRef.current?.focus()
      return
    }
    if (!targetNodeId) {
      setError('Target classification is required')
      taxonomyBtnRef.current?.focus()
      return
    }

    setSaving(true)
    setError(null)
    try {
      await ipc.rules.create({
        name: name.trim(),
        groupedConditions: grouped,
        targetTaxonomyNodeId: targetNodeId,
        groupId: selectedGroupId,
      })
      onCreated?.()
      setSuccessMessage(`Rule "${name.trim()}" created successfully!`)
      setSaving(false)
      closeTimerRef.current = setTimeout(() => {
        setSuccessMessage(null)
        onClose()
      }, 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create rule')
      setSaving(false)
    }
  }, [conditionCount, name, targetNodeId, grouped, selectedGroupId, onCreated, onClose])

  // Taxonomy dropdown keyboard handling
  const handleTaxonomySearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setTaxonomyHighlightIdx(i => Math.min(i + 1, filteredTaxonomyNodes.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setTaxonomyHighlightIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && taxonomyHighlightIdx >= 0 && taxonomyHighlightIdx < filteredTaxonomyNodes.length) {
      e.preventDefault()
      const node = filteredTaxonomyNodes[taxonomyHighlightIdx]
      setTargetNodeId(node.id)
      setTaxonomyDropdownOpen(false)
      setTaxonomySearch('')
      // Move focus to save button after selecting
      requestAnimationFrame(() => saveBtnRef.current?.focus())
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setTaxonomyDropdownOpen(false)
      taxonomyBtnRef.current?.focus()
    }
  }, [filteredTaxonomyNodes, taxonomyHighlightIdx])

  // Scroll highlighted taxonomy item into view
  useEffect(() => {
    if (taxonomyHighlightIdx < 0 || !taxonomyListRef.current) return
    const items = taxonomyListRef.current.children
    if (items[taxonomyHighlightIdx]) {
      (items[taxonomyHighlightIdx] as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }, [taxonomyHighlightIdx])

  // Global keyboard handler for the modal
  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't interfere with taxonomy dropdown keyboard nav
    if (taxonomyDropdownOpen) return

    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }

    // Cmd/Ctrl+Enter to save from anywhere in the modal
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
      return
    }

    // Tab navigation is native — just let it flow through the focusable elements
  }, [taxonomyDropdownOpen, onClose, handleSave])

  if (!isOpen) return null

  // Success state — green checkmark, auto-closes after 2.5s
  if (successMessage) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40" />
        <div className="relative bg-white rounded-xl shadow-2xl w-[560px] flex flex-col items-center py-10 px-8">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
            <Check size={24} className="text-green-600" />
          </div>
          <p className="text-sm font-medium text-gray-900">{successMessage}</p>
          <p className="text-xs text-gray-400 mt-1">This dialog will close automatically.</p>
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleModalKeyDown}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col" style={{ overflow: 'visible' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">Create Override Rule</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            tabIndex={-1}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — single scrollable view with all fields */}
        <div className="px-5 py-4 flex-1 space-y-4 overflow-y-auto" style={{ overflow: 'visible' }}>
          {error && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}

          {/* Conditions section */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Conditions</label>
            <p className="text-[10px] text-gray-400 mb-2">
              Auto-suggested from your selection ({selectedRows.length} row{selectedRows.length !== 1 ? 's' : ''})
            </p>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
              {conditionCount > 0 ? (
                <ConditionSummary grouped={grouped} />
              ) : (
                <span className="text-xs italic text-gray-400">No conditions configured</span>
              )}
            </div>
            <button
              ref={editConditionsBtnRef}
              type="button"
              onClick={() => setConditionsModalOpen(true)}
              className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50 transition-colors focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              Edit Conditions
            </button>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-100" />

          {/* Rule Name */}
          <div>
            <label htmlFor="rule-name" className="mb-1 block text-xs font-medium text-gray-600">Rule Name</label>
            <input
              id="rule-name"
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. IT Software suppliers"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          {/* Rule Group */}
          <div>
            <label htmlFor="rule-group" className="mb-1 block text-xs font-medium text-gray-600">Rule Group</label>
            <select
              id="rule-group"
              value={selectedGroupId ?? ''}
              onChange={(e) => setSelectedGroupId(e.target.value || null)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              <option value="">Ungrouped (lowest priority)</option>
              {ruleGroups
                .sort((a, b) => b.priority - a.priority)
                .map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name} (Priority {g.priority})
                  </option>
                ))
              }
            </select>
            <p className="mt-0.5 text-[10px] text-gray-400">
              Rules in higher priority groups are evaluated first
            </p>
          </div>

          {/* Target Classification */}
          <div ref={taxonomyDropdownRef} className="relative">
            <label className="mb-1 block text-xs font-medium text-gray-600">Target Classification</label>
            <button
              ref={taxonomyBtnRef}
              type="button"
              onClick={() => {
                setTaxonomyDropdownOpen(!taxonomyDropdownOpen)
                if (!taxonomyDropdownOpen) {
                  requestAnimationFrame(() => taxonomySearchRef.current?.focus())
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === ' ') {
                  e.preventDefault()
                  setTaxonomyDropdownOpen(true)
                  requestAnimationFrame(() => taxonomySearchRef.current?.focus())
                }
              }}
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
                    ref={taxonomySearchRef}
                    value={taxonomySearch}
                    onChange={(e) => setTaxonomySearch(e.target.value)}
                    onKeyDown={handleTaxonomySearchKeyDown}
                    placeholder="Search taxonomy..."
                    className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                </div>
                <ul ref={taxonomyListRef} className="max-h-48 overflow-y-auto py-1">
                  {filteredTaxonomyNodes.length === 0 && (
                    <li className="px-3 py-2 text-xs text-gray-400">No matches</li>
                  )}
                  {filteredTaxonomyNodes.map((n, idx) => (
                    <li
                      key={n.id}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setTargetNodeId(n.id)
                        setTaxonomyDropdownOpen(false)
                        setTaxonomySearch('')
                      }}
                      onMouseEnter={() => setTaxonomyHighlightIdx(idx)}
                      className={`cursor-pointer px-3 py-1.5 text-xs leading-snug ${
                        idx === taxonomyHighlightIdx
                          ? 'bg-blue-50 text-blue-700'
                          : n.id === targetNodeId
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

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
          <span className="text-[10px] text-gray-400">
            {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to save
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition-colors focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              Cancel
            </button>
            <button
              ref={saveBtnRef}
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1"
            >
              {saving ? 'Creating...' : 'Save Rule'}
            </button>
          </div>
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
