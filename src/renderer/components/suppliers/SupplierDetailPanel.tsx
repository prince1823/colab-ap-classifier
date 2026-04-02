import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react'
import type { ProjectSupplierView, SupplierInfo, SupplierType } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'
import { ipc } from '../../lib/ipc'

const SUPPLIER_TYPES: SupplierType[] = ['company', 'individual', 'government']

/** Info fields config — order and layout */
const DETAIL_FIELDS: {
  key: keyof SupplierInfo | 'parentName' | 'l1L2Path' | 'mappedTaxonomyPaths'
  label: string
  editable: boolean
  type: 'text' | 'select' | 'readonly' | 'l1l2-dropdown'
  wide?: boolean
}[] = [
  { key: 'l1L2Path', label: 'L1|L2 Category', editable: true, type: 'l1l2-dropdown', wide: true },
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

/* ---------- L1|L2 Searchable Dropdown ---------- */

function L1L2Dropdown({
  value,
  options,
  onSelect,
  autoFocus,
}: {
  value: string
  options: string[]
  onSelect: (val: string) => void
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => {
    if (!search) return options
    const q = search.toLowerCase()
    return options.filter(o => o.toLowerCase().includes(q))
  }, [options, search])

  // Auto-open on mount if autoFocus
  useEffect(() => {
    if (autoFocus) {
      setOpen(true)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIdx] as HTMLElement
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightIdx])

  const selectItem = (val: string) => {
    onSelect(val)
    setOpen(false)
    setSearch('')
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx(prev => Math.min(prev + 1, filtered.length)) // +1 for blank option
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightIdx === 0) selectItem('')
      else if (highlightIdx > 0 && filtered[highlightIdx - 1]) selectItem(filtered[highlightIdx - 1])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setSearch('')
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open)
          if (!open) requestAnimationFrame(() => searchRef.current?.focus())
        }}
        className="flex w-full items-center justify-between rounded border border-gray-300 bg-white px-2 py-1 text-left text-xs hover:border-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
      >
        <span className={value ? 'text-gray-900 truncate' : 'text-gray-400'}>
          {value || '(blank)'}
        </span>
        <svg className={`ml-1 h-3 w-3 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg" style={{ minWidth: 280 }}>
          <div className="border-b border-gray-100 p-1.5">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setHighlightIdx(0) }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search..."
              className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <ul ref={listRef} className="max-h-48 overflow-y-auto py-0.5">
            <li
              onMouseDown={(e) => { e.preventDefault(); selectItem('') }}
              onMouseEnter={() => setHighlightIdx(0)}
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                highlightIdx === 0 ? 'bg-blue-50 text-blue-700' : !value ? 'bg-blue-50/50 text-blue-600 font-medium' : 'text-gray-400 italic hover:bg-gray-50'
              }`}
            >
              (blank)
            </li>
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-400">No matches</li>
            )}
            {filtered.map((opt, idx) => (
              <li
                key={opt}
                onMouseDown={(e) => { e.preventDefault(); selectItem(opt) }}
                onMouseEnter={() => setHighlightIdx(idx + 1)}
                className={`cursor-pointer px-3 py-1.5 text-xs leading-snug ${
                  idx + 1 === highlightIdx
                    ? 'bg-blue-50 text-blue-700'
                    : opt === value
                      ? 'bg-blue-50/50 font-medium text-blue-700'
                      : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {opt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

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
  onSaveL1L2Path: (supplier: ProjectSupplierView, value: string[]) => void
  taxonomyL1L2Options: string[]
  onResearch: (supplier: ProjectSupplierView) => void
  onCategorize: (supplier: ProjectSupplierView) => void
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
  taxonomyL1L2Options,
  onResearch,
  onCategorize,
  onConfirm,
  focusedFieldIndex,
  onFocusedFieldChange,
  editingFieldIndex,
  onEditingFieldChange,
  onMoveToList,
  isActive,
}, ref) {
  const panelRef = useRef<HTMLDivElement>(null)

  // If taxonomy changes and a supplier's l1L2Path contains paths no longer in the taxonomy, clear them
  useEffect(() => {
    if (!supplier || taxonomyL1L2Options.length === 0) return
    const currentPaths = supplier.l1L2Path ?? []
    if (currentPaths.length === 0) return
    const validPaths = currentPaths.filter(p => taxonomyL1L2Options.includes(p))
    if (validPaths.length !== currentPaths.length) {
      onSaveL1L2Path(supplier, validPaths)
    }
  }, [supplier?.id, taxonomyL1L2Options]) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (key === 'l1L2Path') return supplier.l1L2Path?.join(', ') || ''
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
    if (key === 'mappedTaxonomyPaths' || key === 'l1L2Path') return // readonly / handled by dropdown
    if (key === 'parentName') {
      onSaveParentName(supplier, val)
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
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 leading-tight truncate">{supplier.supplierName}</h2>
            {supplier.categoryASupplier && (
              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-600 flex-shrink-0">
                Cat A
              </span>
            )}
          </div>
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
        {!supplier.l1L2Path && (supplier.isResearched || supplier.isTailSpend) && (
          <button type="button" className="action-btn categorize" onClick={() => onCategorize(supplier)}>
            Categorize
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

          // L1|L2 Category: dropdown-based selection
          if (field.key === 'l1L2Path') {
            const currentPaths = supplier.l1L2Path ?? []
            const validPaths = currentPaths.filter(p => taxonomyL1L2Options.includes(p))
            const isFieldFocused = isActive && currentNavIdx === focusedFieldIndex
            const isFieldEditing = editingFieldIndex === currentNavIdx

            const handleDropdownChange = (index: number, newValue: string) => {
              const updated = [...validPaths]
              if (newValue === '') {
                // Remove this dropdown slot
                updated.splice(index, 1)
              } else {
                updated[index] = newValue
              }
              onSaveL1L2Path(supplier, updated.filter(Boolean))
              // Stay in edit mode
            }

            return (
              <div
                key={field.key}
                className={`detail-field detail-field-wide ${isFieldFocused && !isFieldEditing ? 'detail-field-focused' : ''}`}
                tabIndex={isFieldFocused && !isFieldEditing ? 0 : -1}
                onKeyDown={!isFieldEditing ? handlePanelKeyDown : undefined}
              >
                <label className="detail-field-label">{field.label}</label>
                {isFieldEditing ? (
                  <div className="flex flex-col gap-1.5">
                    {(validPaths.length === 0 ? [''] : validPaths).map((path, i) => (
                      <L1L2Dropdown
                        key={i}
                        value={validPaths.includes(path) ? path : ''}
                        options={taxonomyL1L2Options}
                        autoFocus={i === 0}
                        onSelect={(val) => {
                          if (validPaths.length === 0 && val) {
                            onSaveL1L2Path(supplier, [val])
                          } else {
                            handleDropdownChange(i, val)
                          }
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    className="detail-field-value"
                    onClick={() => onEditingFieldChange(currentNavIdx)}
                  >
                    {validPaths.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {validPaths.map((p, i) => (
                          <span key={i} className="inline-block rounded bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-800">{p}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-300 italic">—</span>
                    )}
                  </div>
                )}
              </div>
            )
          }

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
