import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import FilterConditionBuilder from '../FilterConditionBuilder'
import { ipc } from '../../lib/ipc'
import type { FilterCondition } from '../../../shared/types/transactions'
import type { FieldDefinition } from '../FilterConditionBuilder'

interface AdvancedFilterModalProps {
  isOpen: boolean
  onClose: () => void
  conditions: FilterCondition[]
  onApply: (conditions: FilterCondition[]) => void
  availableFields: FieldDefinition[]
}

export default function AdvancedFilterModal({
  isOpen,
  onClose,
  conditions: initialConditions,
  onApply,
  availableFields,
}: AdvancedFilterModalProps) {
  const [conditions, setConditions] = useState<FilterCondition[]>(initialConditions)
  // Cache of distinct values per column: { supplier_name: ['Acme', 'Beta'], ... }
  const [distinctCache, setDistinctCache] = useState<Record<string, string[]>>({})

  // Sync when modal opens
  useEffect(() => {
    if (isOpen) {
      setConditions(
        initialConditions.length > 0
          ? initialConditions
          : [{ field: '', operator: 'contains', value: '', connector: 'AND' }]
      )
    }
  }, [isOpen, initialConditions])

  // Fetch distinct values for any fields used in conditions that we haven't cached yet
  useEffect(() => {
    if (!isOpen) return
    const fieldsInUse = [...new Set(conditions.map(c => c.field).filter(Boolean))]
    const missing = fieldsInUse.filter(f => !(f in distinctCache))
    if (missing.length === 0) return

    for (const field of missing) {
      ipc.transactions.distinctValues(field, 200)
        .then((values: string[]) => {
          console.log(`[AdvancedFilter] distinctValues for "${field}":`, values?.length ?? 0, 'values')
          setDistinctCache(prev => ({ ...prev, [field]: values ?? [] }))
        })
        .catch((err) => {
          console.error(`[AdvancedFilter] distinctValues failed for "${field}":`, err)
          setDistinctCache(prev => ({ ...prev, [field]: [] }))
        })
    }
  }, [isOpen, conditions, distinctCache])

  // Enrich string fields with suggestions from cache — keeps full string operators
  // while showing autocomplete dropdown via <datalist>
  const enrichedFields: FieldDefinition[] = useMemo(() =>
    availableFields.map(f => {
      const values = distinctCache[f.name]
      if (values && values.length > 0 && f.type === 'string') {
        return { ...f, suggestions: values }
      }
      return f
    }),
    [availableFields, distinctCache]
  )

  if (!isOpen) return null

  const handleApply = () => {
    // Only keep conditions that have a field selected
    const valid = conditions.filter(c => c.field)
    onApply(valid)
    onClose()
  }

  const handleClear = () => {
    onApply([])
    onClose()
  }

  const hasValidConditions = conditions.some(c => c.field)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-[700px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Advanced Filters</h3>
            <p className="text-xs text-gray-400 mt-0.5">Build conditions to filter transactions</p>
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
          <FilterConditionBuilder
            conditions={conditions}
            onChange={setConditions}
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
