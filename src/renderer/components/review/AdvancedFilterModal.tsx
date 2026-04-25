import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { GroupedFilterBuilder, conditionsToGrouped, makeEmptyGroup, normalizeGroupedFilter } from '../FilterConditionBuilder'
import { ipc } from '../../lib/ipc'
import { showError } from '../../lib/toast-errors'
import type { FilterCondition, GroupedFilter } from '../../../shared/types/transactions'
import type { FieldDefinition } from '../FilterConditionBuilder'

interface AdvancedFilterModalProps {
  isOpen: boolean
  onClose: () => void
  /** The persisted grouped filter (preserved across open/close). */
  groupedFilter: GroupedFilter | null
  onApply: (grouped: GroupedFilter | null) => void
  availableFields: FieldDefinition[]
  /** Pill filters from double-click / ⌘F — shown as editable conditions */
  pillFilterState?: Record<string, string[]>
  /** Called on apply to clear pill filters (they become advanced conditions) */
  onClearPillFilters?: () => void
  /** Custom function to fetch distinct values for a field. Defaults to ipc.transactions.distinctValues. */
  fetchDistinctValues?: (field: string, limit: number) => Promise<string[]>
  /** Title override */
  title?: string
  /** Subtitle override */
  subtitle?: string
}

export default function AdvancedFilterModal({
  isOpen,
  onClose,
  groupedFilter,
  onApply,
  availableFields,
  pillFilterState = {},
  onClearPillFilters,
  fetchDistinctValues,
  title = 'Advanced Filters',
  subtitle = 'Build conditions to filter transactions',
}: AdvancedFilterModalProps) {
  const getDistinctValues = fetchDistinctValues ?? ((field: string, limit: number) => ipc.transactions.distinctValues(field, limit))
  const [grouped, setGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  // Fresh distinct values fetched each time modal opens
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({})

  // Track previous isOpen to detect open transitions (false → true)
  const prevOpenRef = useRef(false)

  // Sync ONLY when the modal opens (isOpen transitions from false → true)
  // NOT on every re-render, which would reset user's in-progress edits
  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current
    prevOpenRef.current = isOpen
    if (!justOpened) return

    // Convert pill filters to conditions
    const pillConditions: FilterCondition[] = []
    for (const [field, values] of Object.entries(pillFilterState)) {
      if (values.length > 0) {
        pillConditions.push({
          field,
          operator: values.length > 1 ? 'in_list' : 'equals',
          value: values.length > 1 ? values : values[0],
          connector: 'AND',
        })
      }
    }

    if (groupedFilter && groupedFilter.groups.some(g => g.conditions.some(c => c.field))) {
      // We have a persisted grouped filter — prepend pill conditions as a group if any.
      // Normalize external data to enforce within-group and between-group homogeneity.
      const normalized = normalizeGroupedFilter(groupedFilter)
      if (pillConditions.length > 0) {
        const pillGroup = { connector: 'AND' as const, conditions: pillConditions }
        setGrouped({
          groupConnector: normalized.groupConnector,
          groups: [pillGroup, ...normalized.groups],
        })
      } else {
        setGrouped(normalized)
      }
    } else if (pillConditions.length > 0) {
      // Only pill filters, wrap in a single group
      setGrouped({ groupConnector: 'AND', groups: [{ connector: 'AND', conditions: pillConditions }] })
    } else {
      setGrouped({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
    }
  }, [isOpen, groupedFilter, pillFilterState])

  // Fetch fresh distinct values for all string fields every time modal opens
  useEffect(() => {
    if (!isOpen) return
    // Reset so we always get fresh data from the backend
    setDistinctValues({})

    const stringFields = availableFields.filter(f => f.type === 'string').map(f => f.name)
    for (const field of stringFields) {
      getDistinctValues(field, 5000)
        .then((values: string[]) => {
          setDistinctValues(prev => ({ ...prev, [field]: values ?? [] }))
        })
        .catch((e) => {
          setDistinctValues(prev => ({ ...prev, [field]: [] }))
          showError(`Failed to load suggestions for "${field}"`, e)
        })
    }
  }, [isOpen, availableFields])

  // Enrich string fields with fresh suggestions from backend
  const enrichedFields: FieldDefinition[] = useMemo(() =>
    availableFields.map(f => {
      const values = distinctValues[f.name]
      if (values && values.length > 0 && f.type === 'string') {
        return { ...f, suggestions: values }
      }
      return f
    }),
    [availableFields, distinctValues]
  )

  if (!isOpen) return null

  const handleApply = () => {
    // Check if there are any valid conditions
    const hasValid = grouped.groups.some(g => g.conditions.some(c => c.field))
    onApply(hasValid ? grouped : null)
    onClearPillFilters?.()
    onClose()
  }

  const handleClear = () => {
    onApply(null)
    onClearPillFilters?.()
    onClose()
  }

  const hasValidConditions = grouped.groups.some(g => g.conditions.some(c => c.field))

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-[740px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">{title}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          <GroupedFilterBuilder
            value={grouped}
            onChange={setGrouped}
            availableFields={enrichedFields}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
          <button
            onClick={handleClear}
            className="text-xs text-red-500 hover:text-red-600 font-medium"
          >
            Clear all filters
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!hasValidConditions}
              className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              Apply Filters
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
