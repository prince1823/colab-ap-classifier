import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import type { ProjectSupplierView, SupplierInfo, SupplierType } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'
import { ipc } from '../../lib/ipc'

const SUPPLIER_TYPES: SupplierType[] = ['company', 'individual', 'government']

/** Info fields config — order and layout */
const DETAIL_FIELDS: {
  key: keyof SupplierInfo | 'parentName' | 'l1L2Path' | 'mappedTaxonomyPaths'
  label: string
  editable: boolean
  type: 'text' | 'select' | 'readonly'
  wide?: boolean
}[] = [
  { key: 'l1L2Path', label: 'L1|L2 Category', editable: true, type: 'text', wide: true },
  { key: 'mappedTaxonomyPaths', label: 'Mapped Taxonomy Paths', editable: false, type: 'readonly', wide: true },
  { key: 'supplierType', label: 'Supplier Type', editable: true, type: 'select' },
  { key: 'officialBusinessName', label: 'Official Business Name', editable: true, type: 'text' },
  { key: 'parentName', label: 'Parent Supplier', editable: true, type: 'text' },
  { key: 'industry', label: 'Industry', editable: true, type: 'text' },
  { key: 'serviceType', label: 'Service Type', editable: true, type: 'text' },
  { key: 'naicsCode', label: 'NAICS Code', editable: true, type: 'text' },
  { key: 'naicsDescription', label: 'NAICS Description', editable: true, type: 'text', wide: true },
  { key: 'productsServices', label: 'Products & Services', editable: true, type: 'text', wide: true },
  { key: 'description', label: 'Description', editable: true, type: 'text', wide: true },
  { key: 'websiteUrl', label: 'Website', editable: true, type: 'text', wide: true },
  { key: 'sources', label: 'Sources', editable: true, type: 'text', wide: true },
]

/** Only editable fields can be keyboard-navigated */
const NAVIGABLE_FIELDS = DETAIL_FIELDS.filter(f => f.editable)

/* ---------- Editable field ---------- */

interface EditableFieldProps {
  label: string
  value: string
  onSave: (val: string) => void
  type?: 'text' | 'select'
  wide?: boolean
  isFocused?: boolean
  isEditing?: boolean
  onStartEdit?: () => void
  onCommitAndAdvance?: () => void
  onFieldKeyDown?: (e: React.KeyboardEvent) => void
}

function EditableField({
  label,
  value,
  onSave,
  type = 'text',
  wide = false,
  isFocused = false,
  isEditing = false,
  onStartEdit,
  onCommitAndAdvance,
  onFieldKeyDown,
}: EditableFieldProps) {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setDraft(value) }, [value])

  // Auto-focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      if (inputRef.current instanceof HTMLInputElement) inputRef.current.select()
    }
  }, [isEditing])

  // Scroll focused field into view
  useEffect(() => {
    if (isFocused && fieldRef.current) {
      fieldRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [isFocused])

  const commit = useCallback(() => {
    if (draft !== value) onSave(draft)
  }, [draft, value, onSave])

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      // Commit and advance to next field
      onCommitAndAdvance?.()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(value)
      // Exit edit mode but stay on this field (handled by parent)
      onCommitAndAdvance?.()
    }
  }

  const handleBlur = () => {
    commit()
  }

  return (
    <div
      ref={fieldRef}
      className={`detail-field ${wide ? 'detail-field-wide' : ''} ${isFocused && !isEditing ? 'detail-field-focused' : ''}`}
      onKeyDown={!isEditing ? onFieldKeyDown : undefined}
      tabIndex={isFocused && !isEditing ? 0 : -1}
    >
      <label className="detail-field-label">{label}</label>
      {isEditing ? (
        type === 'select' ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className="detail-field-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (e.target.value !== value) onSave(e.target.value)
              onCommitAndAdvance?.()
            }}
            onBlur={handleBlur}
            onKeyDown={handleInputKeyDown}
          >
            <option value="">--</option>
            {SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className="detail-field-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleInputKeyDown}
          />
        )
      ) : (
        <div
          className="detail-field-value"
          onClick={() => onStartEdit?.()}
          title={value || undefined}
        >
          {value || <span className="text-gray-300 italic">—</span>}
        </div>
      )}
    </div>
  )
}

/* ---------- Detail Panel ---------- */

export interface SupplierDetailPanelHandle {
  focusField: (index: number) => void
}

interface SupplierDetailPanelProps {
  supplier: ProjectSupplierView | null
  onSaveField: (supplier: ProjectSupplierView, field: keyof SupplierInfo, value: string) => void
  onSaveParentName: (supplier: ProjectSupplierView, value: string) => void
  onSaveL1L2Path: (supplier: ProjectSupplierView, value: string) => void
  onResearch: (supplier: ProjectSupplierView) => void
  onConfirm: (supplier: ProjectSupplierView) => void
  focusedFieldIndex: number
  onFocusedFieldChange: (index: number) => void
  editingFieldIndex: number | null
  onEditingFieldChange: (index: number | null) => void
  onMoveToList: () => void
  isActive: boolean
}

const SupplierDetailPanel = forwardRef<SupplierDetailPanelHandle, SupplierDetailPanelProps>(function SupplierDetailPanel({
  supplier,
  onSaveField,
  onSaveParentName,
  onSaveL1L2Path,
  onResearch,
  onConfirm,
  focusedFieldIndex,
  onFocusedFieldChange,
  editingFieldIndex,
  onEditingFieldChange,
  onMoveToList,
  isActive,
}, ref) {
  const panelRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focusField: (index: number) => {
      onFocusedFieldChange(index)
      onEditingFieldChange(null)
      // Focus the panel so it receives keyboard events
      setTimeout(() => panelRef.current?.focus(), 0)
    },
  }))

  // Focus the panel div when it becomes active
  useEffect(() => {
    if (isActive && panelRef.current) {
      panelRef.current.focus()
    }
  }, [isActive])

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isActive || !supplier || editingFieldIndex !== null) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.min(focusedFieldIndex + 1, NAVIGABLE_FIELDS.length - 1)
      onFocusedFieldChange(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(focusedFieldIndex - 1, 0)
      onFocusedFieldChange(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onEditingFieldChange(focusedFieldIndex)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onMoveToList()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onMoveToList()
    }
  }, [isActive, supplier, editingFieldIndex, focusedFieldIndex, onFocusedFieldChange, onEditingFieldChange, onMoveToList])

  if (!supplier) {
    return (
      <div className="supplier-detail-panel">
        <div className="flex items-center justify-center h-full text-gray-300 text-sm">
          Select a supplier to view details
        </div>
      </div>
    )
  }

  const info = supplier.supplierInfo ?? {}
  const getVal = (key: keyof SupplierInfo | 'parentName' | 'l1L2Path' | 'mappedTaxonomyPaths'): string => {
    if (key === 'parentName') return supplier.parentName || ''
    if (key === 'l1L2Path') return supplier.l1L2Path || ''
    if (key === 'mappedTaxonomyPaths') {
      const paths = supplier.mappedTaxonomyPaths
      if (!paths || paths.length === 0) return ''
      return paths.join('\n')
    }
    const v = info[key as keyof SupplierInfo]
    if (v == null) return ''
    if (Array.isArray(v)) return v.join(', ')
    return String(v)
  }

  const handleSave = (key: keyof SupplierInfo | 'parentName' | 'l1L2Path' | 'mappedTaxonomyPaths', val: string) => {
    if (key === 'mappedTaxonomyPaths') return // readonly
    if (key === 'parentName') {
      onSaveParentName(supplier, val)
    } else if (key === 'l1L2Path') {
      onSaveL1L2Path(supplier, val)
    } else {
      onSaveField(supplier, key as keyof SupplierInfo, val)
    }
  }

  const handleCommitAndAdvance = (navIndex: number) => {
    onEditingFieldChange(null)
    // Move to next field
    const next = Math.min(navIndex + 1, NAVIGABLE_FIELDS.length - 1)
    onFocusedFieldChange(next)
    // Re-focus the panel for keyboard nav
    setTimeout(() => panelRef.current?.focus(), 0)
  }

  // Map navigable field index to the field config
  let navIdx = 0

  return (
    <div
      ref={panelRef}
      className="supplier-detail-panel"
      tabIndex={0}
      onKeyDown={handlePanelKeyDown}
      style={{ outline: 'none' }}
    >
      {/* Header */}
      <div className="detail-header">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900 leading-tight truncate">{supplier.supplierName}</h2>
          <div className="flex items-center gap-3 text-xs text-gray-500 flex-shrink-0">
            <span><strong className="text-gray-700">{supplier.transactionCount}</strong> transactions</span>
            <span className="text-gray-300">·</span>
            <span><strong className="text-gray-700">{fmtAbbrev(supplier.totalSpend)}</strong> total spend</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="detail-actions">
        {!supplier.isResearched && !supplier.isTailSpend && (
          <button type="button" className="action-btn research" onClick={() => onResearch(supplier)}>
            Research
          </button>
        )}
        {supplier.l1L2Path && supplier.confirmationStatus !== 'confirmed' && (
          <button type="button" className="action-btn confirm" onClick={() => onConfirm(supplier)}>
            Confirm
          </button>
        )}
      </div>

      {/* Info grid */}
      <div className="detail-info-grid">
        {DETAIL_FIELDS.map((field) => {
          // Mapped taxonomy paths: readonly display (no nav index)
          if (field.key === 'mappedTaxonomyPaths') {
            const paths = supplier.mappedTaxonomyPaths ?? []
            return (
              <div key={field.key} className="detail-field detail-field-wide">
                <label className="detail-field-label">{field.label}</label>
                <div className="detail-field-value">
                  {paths.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {paths.map((p, i) => (
                        <span key={i} className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{p}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-gray-300 italic">—</span>
                  )}
                </div>
              </div>
            )
          }

          // Editable field with keyboard nav
          const currentNavIdx = navIdx
          navIdx++

          // Sources: clickable tags in view mode, text input in edit mode
          if (field.key === 'sources') {
            const sourcesArr = (info.sources ?? []) as string[]
            const isFieldEditing = editingFieldIndex === currentNavIdx
            const isFieldFocused = isActive && currentNavIdx === focusedFieldIndex
            return (
              <div
                key={field.key}
                className={`detail-field detail-field-wide ${isFieldFocused && !isFieldEditing ? 'detail-field-focused' : ''}`}
                tabIndex={isFieldFocused && !isFieldEditing ? 0 : -1}
                onKeyDown={!isFieldEditing ? handlePanelKeyDown : undefined}
              >
                <label className="detail-field-label">Sources</label>
                {isFieldEditing ? (
                  <input
                    className="detail-field-input"
                    defaultValue={sourcesArr.join(', ')}
                    autoFocus
                    onBlur={(e) => {
                      const val = e.target.value
                      if (val !== sourcesArr.join(', ')) handleSave('sources', val)
                      handleCommitAndAdvance(currentNavIdx)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const val = (e.target as HTMLInputElement).value
                        if (val !== sourcesArr.join(', ')) handleSave('sources', val)
                        handleCommitAndAdvance(currentNavIdx)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        handleCommitAndAdvance(currentNavIdx)
                      }
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5 min-h-[28px]">
                    {sourcesArr.length > 0 ? sourcesArr.map((src, i) => (
                      <a
                        key={i}
                        className="source-tag source-link"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          const url = src.startsWith('http://') || src.startsWith('https://') ? src : `https://${src}`;
                          ipc.shell.openExternal(url)
                        }}
                        title={src}
                      >
                        {src}
                      </a>
                    )) : (
                      <span className="text-gray-300 italic text-xs">—</span>
                    )}
                    <button
                      type="button"
                      className="text-[10px] text-gray-400 hover:text-blue-500 ml-1"
                      onClick={() => onEditingFieldChange(currentNavIdx)}
                    >
                      edit
                    </button>
                  </div>
                )}
              </div>
            )
          }

          return (
            <EditableField
              key={field.key}
              label={field.label}
              value={getVal(field.key)}
              onSave={(val) => handleSave(field.key, val)}
              type={field.type === 'select' ? 'select' : 'text'}
              wide={field.wide}
              isFocused={isActive && currentNavIdx === focusedFieldIndex}
              isEditing={editingFieldIndex === currentNavIdx}
              onStartEdit={() => onEditingFieldChange(currentNavIdx)}
              onCommitAndAdvance={() => handleCommitAndAdvance(currentNavIdx)}
              onFieldKeyDown={handlePanelKeyDown}
            />
          )
        })}
      </div>

      {/* Footer — aliases only */}
      {supplier.aliases && supplier.aliases.length > 0 && (
        <div className="detail-footer">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">Aliases: </span>
          <span className="text-xs text-gray-600">{supplier.aliases.join(', ')}</span>
        </div>
      )}
    </div>
  )
})

export default SupplierDetailPanel
