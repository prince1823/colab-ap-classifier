import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FunnelIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { ipc } from '../lib/ipc'
import type { ProjectSupplierView, SupplierType, SupplierInfo } from '../../shared/types/suppliers'
import type { ResearchProgress } from '../../shared/types/classification'
import type { FilterCondition } from '../../shared/types/transactions'
import type { FieldDefinition } from '../components/FilterConditionBuilder'
import FilterConditionBuilder, { OPERATOR_LABELS, NO_VALUE_OPERATORS } from '../components/FilterConditionBuilder'
import '../styles/SuppliersPage.css'
import { fmtAbbrev } from '../utils/formatSpend'

const SUPPLIER_TYPES: SupplierType[] = ['company', 'individual', 'government']

/** Which supplierInfo fields to show as columns, in order */
const INFO_COLUMNS: { key: keyof SupplierInfo; label: string; editable: boolean; type: 'text' | 'select' | 'readonly'; wide?: boolean }[] = [
  { key: 'supplierType', label: 'Type', editable: true, type: 'select' },
  { key: 'officialBusinessName', label: 'Official Name', editable: true, type: 'text' },
  { key: 'industry', label: 'Industry', editable: true, type: 'text' },
  { key: 'productsServices', label: 'Products/Services', editable: true, type: 'text', wide: true },
  { key: 'description', label: 'Description', editable: true, type: 'text', wide: true },
  { key: 'naicsCode', label: 'NAICS', editable: true, type: 'text' },
  { key: 'naicsDescription', label: 'NAICS Desc', editable: true, type: 'text', wide: true },
  { key: 'serviceType', label: 'Service Type', editable: true, type: 'text' },
  { key: 'confidence', label: 'Confidence', editable: false, type: 'readonly' },
  { key: 'websiteUrl', label: 'Website', editable: true, type: 'text' },
  { key: 'sources', label: 'Sources', editable: false, type: 'readonly' },
]

/** Editable cell — click to edit, blur/Enter to save, Escape to cancel */
function EditableCell({
  value,
  onSave,
  type = 'text',
}: {
  value: string
  onSave: (val: string) => void
  type?: 'text' | 'select'
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      if (inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select()
      }
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    if (draft !== value) {
      onSave(draft)
    }
  }, [draft, value, onSave])

  const cancel = useCallback(() => {
    setDraft(value)
    setEditing(false)
  }, [value])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }, [commit, cancel])

  if (editing) {
    if (type === 'select') {
      return (
        <div className="supplier-cell-editing">
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className="supplier-cell-select"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setEditing(false)
              if (e.target.value !== value) {
                onSave(e.target.value)
              }
            }}
            onBlur={commit}
            onKeyDown={handleKeyDown}
          >
            <option value="">--</option>
            {SUPPLIER_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      )
    }

    return (
      <div className="supplier-cell-editing">
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          className="supplier-cell-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
        />
      </div>
    )
  }

  return (
    <div className="supplier-cell" onClick={() => { setDraft(value); setEditing(true) }} title={value || undefined}>
      {value ? <span className="cell-text">{value}</span> : <span className="cell-placeholder">-</span>}
    </div>
  )
}

/** Status badge component */
function StatusBadge({ status }: { status: string }) {
  const cls = status === 'confirmed' ? 'status-badge confirmed'
    : status === 'rejected' ? 'status-badge rejected'
    : 'status-badge pending'
  return <span className={cls}>{status}</span>
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [allSuppliers, setAllSuppliers] = useState<ProjectSupplierView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([])
  const [debouncedConditions, setDebouncedConditions] = useState<FilterCondition[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filterDialogOpen, setFilterDialogOpen] = useState(false)
  // Draft conditions inside dialog — committed on Apply
  const [draftConditions, setDraftConditions] = useState<FilterCondition[]>([{ field: '', operator: 'equals', value: '', connector: 'AND' }])

  // Debounce filter conditions — 300ms delay before triggering backend call
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedConditions(filterConditions), 300)
    return () => clearTimeout(timer)
  }, [filterConditions])
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | null>(null)
  const [tailSpendThreshold, setTailSpendThreshold] = useState<string>('')
  const [tailSpendSet, setTailSpendSet] = useState(false)
  const [supplierUniversePath, setSupplierUniversePath] = useState<string | null>(null)

  // Build backend filter from FilterConditionBuilder conditions
  const NO_VALUE_OPS = new Set(['is_null', 'is_true', 'is_false'])
  const buildFilter = useCallback(() => {
    // Only send conditions that have a field and a value (or a no-value operator)
    const valid = debouncedConditions.filter(c => c.field && (NO_VALUE_OPS.has(c.operator) || c.value !== ''))
    return valid.length > 0 ? { conditions: valid } : undefined
  }, [debouncedConditions])

  // Active (valid) filter conditions for display chips
  const activeFilters = useMemo(() => {
    return filterConditions.filter(c => c.field && (NO_VALUE_OPS.has(c.operator) || c.value !== ''))
  }, [filterConditions])

  // Get the label for a field name
  const getFieldLabel = useCallback((fieldName: string) => {
    const f = filterFields.find(fd => fd.name === fieldName)
    return f ? f.label : fieldName
  }, [filterFields])

  // Group consecutive same-field filters for collapsed chip display
  type FilterGroup = { field: string; items: { filter: FilterCondition; activeIndex: number }[]; connectorBefore?: string }
  const filterGroups = useMemo((): FilterGroup[] => {
    const groups: FilterGroup[] = []
    for (let i = 0; i < activeFilters.length; i++) {
      const c = activeFilters[i]
      const connectorBefore = i > 0 ? (activeFilters[i - 1]?.connector || 'AND') : undefined
      const lastGroup = groups[groups.length - 1]
      // Merge into previous group if same field AND connected by OR (same-field = match any)
      if (lastGroup && lastGroup.field === c.field && connectorBefore === 'OR') {
        lastGroup.items.push({ filter: c, activeIndex: i })
      } else {
        groups.push({ field: c.field, items: [{ filter: c, activeIndex: i }], connectorBefore })
      }
    }
    return groups
  }, [activeFilters])

  // Track which group's value dropdown is open
  const [openValueDropdown, setOpenValueDropdown] = useState<number | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (openValueDropdown === null) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenValueDropdown(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openValueDropdown])

  // Build logic expression string like (A AND B) OR C
  const logicExpression = useMemo(() => {
    if (activeFilters.length < 2) return ''
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    // Build tokens with grouping based on filterGroups
    const parts: string[] = []
    let letterIdx = 0
    for (let gi = 0; gi < filterGroups.length; gi++) {
      const group = filterGroups[gi]
      if (gi > 0 && group.connectorBefore) {
        parts.push(group.connectorBefore)
      }
      if (group.items.length === 1) {
        parts.push(letters[letterIdx] || `F${letterIdx + 1}`)
        letterIdx++
      } else {
        // Multiple items in group — wrap in parens with OR (same-field = match any)
        const inner = group.items.map(() => {
          const l = letters[letterIdx] || `F${letterIdx + 1}`
          letterIdx++
          return l
        }).join(' OR ')
        parts.push(`(${inner})`)
      }
    }
    return parts.join(' ')
  }, [filterGroups, activeFilters.length])

  // Open filter dialog — seed draft from current conditions
  const openFilterDialog = useCallback(() => {
    setDraftConditions(
      filterConditions.length > 0
        ? filterConditions
        : [{ field: '', operator: 'equals', value: '', connector: 'AND' }]
    )
    setFilterDialogOpen(true)
  }, [filterConditions])

  // Apply filters from dialog
  const applyFilters = useCallback(() => {
    setFilterConditions(draftConditions)
    setFilterDialogOpen(false)
  }, [draftConditions])

  // Clear all filters
  const clearFilters = useCallback(() => {
    setFilterConditions([])
    setDraftConditions([{ field: '', operator: 'equals', value: '', connector: 'AND' }])
    setFilterDialogOpen(false)
  }, [])

  // Remove a single active filter chip
  const removeFilterChip = useCallback((index: number) => {
    // Find the actual index in filterConditions for this active filter
    let activeIdx = -1
    const newConditions = filterConditions.filter(c => {
      if (c.field && (NO_VALUE_OPS.has(c.operator) || c.value !== '')) {
        activeIdx++
        return activeIdx !== index
      }
      return false // also drop empty conditions
    })
    setFilterConditions(newConditions)
  }, [filterConditions])

  // Autocomplete suggestions from ALL suppliers (unfiltered) so dropdown always shows full list
  const fetchFilterSuggestions = useCallback(async (field: string, query: string): Promise<string[]> => {
    const q = query.toLowerCase()
    let values: string[] = []

    if (field === 'supplier_name') {
      values = allSuppliers.map(s => s.supplierName).filter(Boolean)
    } else if (field === 'parent_supplier_name') {
      values = allSuppliers.map(s => s.parentName).filter((v): v is string => !!v)
    } else if (field === 'data_source') {
      values = allSuppliers.map(s => (s as Record<string, unknown>).dataSource).filter((v): v is string => typeof v === 'string' && !!v)
    } else {
      return []
    }

    // Deduplicate
    const unique = [...new Set(values)]
    // Filter by query
    const filtered = q ? unique.filter(v => v.toLowerCase().includes(q)) : unique
    // Sort alphabetically and limit
    return filtered.sort((a, b) => a.localeCompare(b)).slice(0, 30)
  }, [allSuppliers])

  // Load settings and filter fields once on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        const [threshold, suPath, fields] = await Promise.all([
          ipc.project.getSetting('tail_spend_threshold'),
          ipc.supplierUniverse.getPath(),
          ipc.suppliers.getFilterFields(),
        ])
        if (threshold && Number(threshold) > 0) {
          setTailSpendThreshold(String(threshold))
          setTailSpendSet(true)
        }
        setSupplierUniversePath(suPath)
        setFilterFields(fields as FieldDefinition[])
      } catch {
        // settings load failure is non-fatal
      }
    }
    loadSettings()
  }, [])

  // Load all suppliers (unfiltered) for autocomplete suggestions
  const loadAllSuppliers = useCallback(async () => {
    try {
      const data = await ipc.suppliers.list(undefined as unknown as Parameters<typeof ipc.suppliers.list>[0])
      setAllSuppliers(data as ProjectSupplierView[])
    } catch {
      // non-fatal — autocomplete just won't have full list
    }
  }, [])

  useEffect(() => { loadAllSuppliers() }, [loadAllSuppliers])

  const loadData = useCallback(async () => {
    if (suppliers.length === 0) setLoading(true)
    setError(null)
    try {
      const filter = buildFilter()
      const data = await ipc.suppliers.list(filter as Parameters<typeof ipc.suppliers.list>[0])
      setSuppliers(data as ProjectSupplierView[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suppliers')
    } finally {
      setLoading(false)
    }
  }, [buildFilter])

  useEffect(() => { loadData() }, [loadData])

  // Subscribe to research progress
  useEffect(() => {
    const unsub = ipc.suppliers.onResearchProgress((progress: ResearchProgress) => {
      setResearchProgress(progress)
      if (progress.status === 'complete' || progress.status === 'error') {
        setTimeout(() => {
          setResearchProgress(null)
          loadData()
        }, 1500)
      }
    })
    return unsub
  }, [loadData])

  /** Update local state */
  const updateSuppliers = useCallback((updater: (prev: ProjectSupplierView[]) => ProjectSupplierView[]) => {
    setSuppliers(prev => updater(prev))
  }, [])

  /** Save a single supplierInfo field for a supplier */
  const saveField = useCallback(async (supplier: ProjectSupplierView, field: keyof SupplierInfo, newValue: string) => {
    setSaving(true)
    try {
      const existingInfo = supplier.supplierInfo ?? {}
      const updatedInfo: SupplierInfo = {
        ...existingInfo,
        [field]: newValue || undefined,
      }
      await ipc.suppliers.update(supplier.supplierName, { supplierInfo: updatedInfo })
      updateSuppliers(prev => prev.map(s =>
        s.id === supplier.id ? { ...s, supplierInfo: updatedInfo } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }, [updateSuppliers])

  /** Save parentName for a supplier */
  const saveParentName = useCallback(async (supplier: ProjectSupplierView, newValue: string) => {
    setSaving(true)
    try {
      const parentName = newValue || null
      await ipc.suppliers.update(supplier.supplierName, { parentName })
      updateSuppliers(prev => prev.map(s =>
        s.id === supplier.id ? { ...s, parentName } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }, [updateSuppliers])

  /** Research a single supplier */
  const researchSupplier = useCallback(async (supplier: ProjectSupplierView) => {
    setSaving(true)
    try {
      await ipc.suppliers.researchSingle(supplier.supplierName)
      await loadData()
      loadAllSuppliers()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research failed')
    } finally {
      setSaving(false)
    }
  }, [loadData, loadAllSuppliers])

  /** Confirm a single supplier */
  const confirmSupplier = useCallback(async (supplier: ProjectSupplierView) => {
    setSaving(true)
    try {
      await ipc.suppliers.confirm(supplier.id, 'confirmed')
      updateSuppliers(prev => prev.map(s =>
        s.id === supplier.id ? { ...s, confirmationStatus: 'confirmed' } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to confirm')
    } finally {
      setSaving(false)
    }
  }, [updateSuppliers])

  /** Batch research selected suppliers */
  const researchSelected = useCallback(async () => {
    const selected = suppliers.filter(s => selectedIds.has(s.id) && !s.isResearched)
    if (selected.length === 0) return
    for (const s of selected) {
      try {
        await ipc.suppliers.researchSingle(s.supplierName)
      } catch {
        // Continue with next supplier
      }
    }
    setSelectedIds(new Set())
    await loadData()
    loadAllSuppliers()
  }, [suppliers, selectedIds, loadData, loadAllSuppliers])

  /** Batch confirm selected suppliers */
  const confirmSelected = useCallback(async () => {
    const selected = suppliers.filter(s => selectedIds.has(s.id) && s.confirmationStatus !== 'confirmed')
    if (selected.length === 0) return
    for (const s of selected) {
      try {
        await ipc.suppliers.confirm(s.id, 'confirmed')
      } catch {
        // Continue with next
      }
    }
    updateSuppliers(prev => prev.map(s =>
      selectedIds.has(s.id) ? { ...s, confirmationStatus: 'confirmed' } : s
    ))
    setSelectedIds(new Set())
  }, [suppliers, selectedIds, updateSuppliers])

  /** Apply tail spend threshold */
  const applyTailSpend = useCallback(async () => {
    const val = Number(tailSpendThreshold)
    if (!val || val <= 0) return
    setSaving(true)
    try {
      await ipc.project.setSetting('tail_spend_threshold', val)
      await ipc.suppliers.filterTailSpend(val)
      setTailSpendSet(true)
      await loadData()
      loadAllSuppliers()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply threshold')
    } finally {
      setSaving(false)
    }
  }, [tailSpendThreshold, loadData])

  /** Change supplier universe DB via file picker */
  const changeSupplierUniverse = useCallback(async () => {
    try {
      const selected = await ipc.supplierUniverse.selectFile()
      if (!selected) return
      setSupplierUniversePath(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set supplier universe path')
    }
  }, [])

  /** Get display value for a supplierInfo field */
  const getFieldValue = (supplier: ProjectSupplierView, field: keyof SupplierInfo): string => {
    const info = supplier.supplierInfo
    if (!info) return ''
    const val = info[field]
    if (val == null) return ''
    if (Array.isArray(val)) return val.join(', ')
    return String(val)
  }

  /** Sort by spend descending — filtering is handled by backend */
  const filteredSuppliers = useMemo(() => {
    return [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend)
  }, [suppliers])

  // Select all logic
  const allSelected = filteredSuppliers.length > 0 && filteredSuppliers.every(s => selectedIds.has(s.id))
  const someSelected = selectedIds.size > 0

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredSuppliers.map(s => s.id)))
    }
  }, [allSelected, filteredSuppliers])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (loading) {
    return (
      <div className="suppliers-loading">
        <svg viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="suppliers-page">
      {error && <div className="suppliers-error">{error}</div>}

      {/* Supplier universe status */}
      <div className="suppliers-banner" style={{ background: '#f0f4f8', borderColor: '#d0d7de' }}>
        <span className="text-xs text-gray-500" title={supplierUniversePath || 'Default location'}>
          Supplier DB: <strong>{supplierUniversePath ? supplierUniversePath.split('/').slice(-2).join('/') : 'Default'}</strong>
        </span>
        <button onClick={changeSupplierUniverse} className="banner-btn" style={{ fontSize: '0.7rem', padding: '2px 8px' }}>
          Change
        </button>
      </div>

      {/* Tail spend threshold banner */}
      {!tailSpendSet && (
        <div className="suppliers-banner">
          <span>Tail spend threshold not set.</span>
          <input
            type="number"
            placeholder="$ amount"
            value={tailSpendThreshold}
            onChange={(e) => setTailSpendThreshold(e.target.value)}
            className="banner-input"
          />
          <button onClick={applyTailSpend} className="banner-btn" disabled={!tailSpendThreshold}>
            Apply
          </button>
        </div>
      )}

      {/* Research progress bar */}
      {researchProgress && researchProgress.status === 'researching' && (
        <div className="suppliers-progress">
          Researching: {researchProgress.currentSupplier}
          ({researchProgress.processedSuppliers}/{researchProgress.totalSuppliers})
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${(researchProgress.processedSuppliers / researchProgress.totalSuppliers) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Batch actions */}
      {someSelected && (
        <div className="suppliers-actions-bar">
          <div className="batch-actions">
            <button onClick={researchSelected} className="action-btn research">
              Research Selected
            </button>
            <button onClick={confirmSelected} className="action-btn confirm">
              Confirm Selected
            </button>
            <span className="selected-count">{selectedIds.size} selected</span>
          </div>
        </div>
      )}

      {/* Filter bar — button + active filter chips */}
      {filterFields.length > 0 && (
        <div className="suppliers-filter-bar">
          <button onClick={openFilterDialog} className={`filter-trigger-btn ${activeFilters.length > 0 ? 'has-filters' : ''}`}>
            <FunnelIcon className="filter-trigger-icon" />
            Filter
            {activeFilters.length > 0 && <span className="filter-count-badge">{activeFilters.length}</span>}
          </button>

          {activeFilters.length > 0 && (
            <div className="filter-chips">
              {filterGroups.map((group, gi) => {
                const first = group.items[0].filter

                return (
                  <React.Fragment key={gi}>
                    {gi > 0 && group.connectorBefore && (
                      <span className="filter-chip-connector">{group.connectorBefore}</span>
                    )}

                    {/* Single chip: field name once, values as clickable tags */}
                    <div className="filter-chip-wrap" ref={openValueDropdown === gi ? dropdownRef : undefined}>
                      <span className="filter-chip">
                        <span className="filter-chip-field">{getFieldLabel(group.field)}</span>
                        <span className="filter-chip-op">{OPERATOR_LABELS[first.operator]}</span>
                        {!NO_VALUE_OPERATORS.has(first.operator) && (
                          group.items.length > 1 ? (
                            <button
                              className="filter-chip-values-btn"
                              onClick={() => setOpenValueDropdown(openValueDropdown === gi ? null : gi)}
                            >
                              {group.items.map((item, ii) => (
                                <React.Fragment key={item.activeIndex}>
                                  {ii > 0 && <span className="filter-chip-separator">|</span>}
                                  <span>{String(item.filter.value)}</span>
                                </React.Fragment>
                              ))}
                            </button>
                          ) : (
                            <span className="filter-chip-value">{String(first.value)}</span>
                          )
                        )}
                        <button className="filter-chip-remove" onClick={() => removeFilterChip(group.items[0].activeIndex)} title="Remove filter">
                          <XMarkIcon className="filter-chip-x" />
                        </button>
                      </span>

                      {/* Dropdown for individual value removal */}
                      {openValueDropdown === gi && group.items.length > 1 && (
                        <div className="filter-chip-dropdown">
                          {group.items.map((item) => (
                            <div key={item.activeIndex} className="filter-chip-dropdown-item">
                              <span className="filter-chip-dropdown-value">{String(item.filter.value)}</span>
                              <button
                                className="filter-chip-dropdown-remove"
                                onClick={() => {
                                  removeFilterChip(item.activeIndex)
                                  if (group.items.length <= 2) setOpenValueDropdown(null)
                                }}
                                title="Remove this value"
                              >
                                <XMarkIcon className="filter-chip-x" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                )
              })}
              {logicExpression && (
                <span className="filter-logic-expr" title="Filter logic">{logicExpression}</span>
              )}
              <button className="filter-clear-all" onClick={clearFilters}>Clear all</button>
            </div>
          )}

          {/* Filter dialog */}
          <Dialog.Root open={filterDialogOpen} onOpenChange={setFilterDialogOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="filter-dialog-overlay" />
              <Dialog.Content className="filter-dialog-content">
                <div className="filter-dialog-header">
                  <Dialog.Title className="filter-dialog-title">Filter Suppliers</Dialog.Title>
                  <Dialog.Close asChild>
                    <button className="filter-dialog-close" aria-label="Close">
                      <XMarkIcon className="filter-dialog-close-icon" />
                    </button>
                  </Dialog.Close>
                </div>

                <div className="filter-dialog-body">
                  <FilterConditionBuilder
                    conditions={draftConditions}
                    onChange={setDraftConditions}
                    availableFields={filterFields}
                    onFetchSuggestions={fetchFilterSuggestions}
                  />
                </div>

                <div className="filter-dialog-footer">
                  <button className="filter-dialog-btn secondary" onClick={clearFilters}>
                    Clear All
                  </button>
                  <div className="filter-dialog-footer-right">
                    <Dialog.Close asChild>
                      <button className="filter-dialog-btn secondary">Cancel</button>
                    </Dialog.Close>
                    <button className="filter-dialog-btn primary" onClick={applyFilters}>
                      Apply Filters
                    </button>
                  </div>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      )}

      <div className="suppliers-table-wrap">
        <table className="suppliers-table">
          <thead>
            <tr>
              <th className="col-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="supplier-checkbox"
                />
              </th>
              <th className="col-supplier">Supplier</th>
              <th className="col-right">Txns</th>
              <th className="col-right">Spend</th>
              <th>Status</th>
              <th>Actions</th>
              {INFO_COLUMNS.map(col => (
                <React.Fragment key={col.key}>
                  <th>{col.label}</th>
                  {col.key === 'officialBusinessName' && <th>Parent</th>}
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredSuppliers.map((s) => (
              <tr key={s.id} className={selectedIds.has(s.id) ? 'row-selected' : ''}>
                <td className="col-check">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggleSelect(s.id)}
                    className="supplier-checkbox"
                  />
                </td>
                <td className="col-supplier" title={s.supplierName}>{s.supplierName}</td>
                <td className="col-right">{s.transactionCount}</td>
                <td className="col-right">{fmtAbbrev(s.totalSpend)}</td>
                <td><StatusBadge status={s.confirmationStatus} /></td>
                <td className="col-actions">
                  {!s.isResearched ? (
                    <button
                      className="row-action-btn research"
                      onClick={() => researchSupplier(s)}
                      title="Research this supplier"
                    >
                      Research
                    </button>
                  ) : s.confirmationStatus === 'pending' ? (
                    <button
                      className="row-action-btn confirm"
                      onClick={() => confirmSupplier(s)}
                      title="Confirm this supplier"
                    >
                      Confirm
                    </button>
                  ) : null}
                </td>

                {INFO_COLUMNS.map(col => {
                  const val = getFieldValue(s, col.key)
                  const parentCell = col.key === 'officialBusinessName' ? (
                    <td key={`parent-${s.id}`}>
                      <EditableCell
                        value={s.parentName || ''}
                        onSave={(newVal) => saveParentName(s, newVal)}
                      />
                    </td>
                  ) : null

                  // Read-only columns
                  if (!col.editable) {
                    if (col.key === 'confidence') {
                      return (
                        <React.Fragment key={col.key}>
                          <td>
                            {val ? (
                              <span className={`confidence-badge ${val}`}>{val}</span>
                            ) : (
                              <span className="cell-placeholder">-</span>
                            )}
                          </td>
                          {parentCell}
                        </React.Fragment>
                      )
                    }
                    if (col.key === 'sources') {
                      const sources = s.supplierInfo?.sources
                      return (
                        <React.Fragment key={col.key}>
                          <td>
                            {sources && sources.length > 0 ? (
                              <div className="sources-list">
                                {sources.map((src: string, i: number) => (
                                  <a
                                    key={i}
                                    className="source-tag source-link"
                                    href={`https://www.google.com/search?q=${encodeURIComponent(src)}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={`Search Google for "${src}"`}
                                    onClick={(e) => {
                                      e.preventDefault()
                                      window.open(`https://www.google.com/search?q=${encodeURIComponent(src)}`, '_blank')
                                    }}
                                  >
                                    {src}
                                  </a>
                                ))}
                              </div>
                            ) : (
                              <span className="cell-placeholder">-</span>
                            )}
                          </td>
                          {parentCell}
                        </React.Fragment>
                      )
                    }
                    return (
                      <React.Fragment key={col.key}>
                        <td><span className="cell-placeholder">{val || '-'}</span></td>
                        {parentCell}
                      </React.Fragment>
                    )
                  }

                  // Editable columns
                  return (
                    <React.Fragment key={col.key}>
                      <td className={col.wide ? 'supplier-col-wide' : ''}>
                        <EditableCell
                          value={val}
                          type={col.type === 'select' ? 'select' : 'text'}
                          onSave={(newVal) => saveField(s, col.key, newVal)}
                        />
                      </td>
                      {parentCell}
                    </React.Fragment>
                  )
                })}
              </tr>
            ))}
            {filteredSuppliers.length === 0 && (
              <tr>
                <td colSpan={7 + INFO_COLUMNS.length + 1} className="suppliers-empty">
                  {filterConditions.some(c => c.field) ? 'No suppliers match the current filters.' : 'No suppliers found. Upload a CSV to populate suppliers.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {saving && <div className="supplier-saving">Saving...</div>}
    </div>
  )
}
