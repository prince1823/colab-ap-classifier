import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ipc } from '../lib/ipc'
import type { ProjectSupplierView, SupplierType, SupplierInfo } from '../../shared/types/suppliers'
import type { ResearchProgress } from '../../shared/types/classification'
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<'all' | 'unconfirmed' | 'unresearched'>('all')
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | null>(null)
  const [tailSpendThreshold, setTailSpendThreshold] = useState<string>('')
  const [tailSpendSet, setTailSpendSet] = useState(false)
  const [supplierUniversePath, setSupplierUniversePath] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (suppliers.length === 0) setLoading(true)
    setError(null)
    try {
      const data = await ipc.suppliers.list()
      setSuppliers(data as ProjectSupplierView[])

      // Check tail spend threshold
      const threshold = await ipc.project.getSetting('tail_spend_threshold')
      if (threshold && Number(threshold) > 0) {
        setTailSpendThreshold(String(threshold))
        setTailSpendSet(true)
      }

      // Load supplier universe path
      const suPath = await ipc.settings.getSupplierUniversePath()
      setSupplierUniversePath(suPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suppliers')
    } finally {
      setLoading(false)
    }
  }, [])

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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research failed')
    } finally {
      setSaving(false)
    }
  }, [loadData])

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
  }, [suppliers, selectedIds, loadData])

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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply threshold')
    } finally {
      setSaving(false)
    }
  }, [tailSpendThreshold, loadData])

  /** Change supplier universe DB via file picker */
  const changeSupplierUniverse = useCallback(async () => {
    try {
      const selected = await ipc.settings.selectSupplierUniverseFile()
      if (!selected) return
      await ipc.settings.setSupplierUniversePath(selected)
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

  // Computed counts
  const unconfirmedCount = useMemo(() =>
    suppliers.filter(s => s.confirmationStatus !== 'confirmed').length
  , [suppliers])

  const unresearchedCount = useMemo(() =>
    suppliers.filter(s => !s.isResearched).length
  , [suppliers])

  /** Sort by spend descending, then filter */
  const filteredSuppliers = useMemo(() => {
    let result = [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend)

    // Status filter
    if (statusFilter === 'unconfirmed') {
      result = result.filter(s => s.confirmationStatus !== 'confirmed')
    } else if (statusFilter === 'unresearched') {
      result = result.filter(s => !s.isResearched)
    }

    // Search filter
    const q = search.trim().toLowerCase()
    if (q) {
      result = result.filter(s => {
        if (s.supplierName.toLowerCase().includes(q)) return true
        if (s.parentName && s.parentName.toLowerCase().includes(q)) return true
        const info = s.supplierInfo
        if (!info) return false
        return INFO_COLUMNS.some(col => {
          if (col.key === 'websiteUrl' || col.key === 'sources') return false
          const val = info[col.key]
          if (val == null) return false
          const str = Array.isArray(val) ? val.join(' ') : String(val)
          return str.toLowerCase().includes(q)
        })
      })
    }

    return result
  }, [suppliers, search, statusFilter])

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

      {/* Batch actions + warning buttons */}
      <div className="suppliers-actions-bar">
        {someSelected && (
          <div className="batch-actions">
            <button onClick={researchSelected} className="action-btn research">
              Research Selected
            </button>
            <button onClick={confirmSelected} className="action-btn confirm">
              Confirm Selected
            </button>
            <span className="selected-count">{selectedIds.size} selected</span>
          </div>
        )}
        <div className="warning-buttons">
          {unconfirmedCount > 0 && (
            <button
              className={`warning-btn ${statusFilter === 'unconfirmed' ? 'active' : ''}`}
              onClick={() => setStatusFilter(statusFilter === 'unconfirmed' ? 'all' : 'unconfirmed')}
            >
              {unconfirmedCount} unconfirmed
            </button>
          )}
          {unresearchedCount > 0 && (
            <button
              className={`warning-btn ${statusFilter === 'unresearched' ? 'active' : ''}`}
              onClick={() => setStatusFilter(statusFilter === 'unresearched' ? 'all' : 'unresearched')}
            >
              {unresearchedCount} unresearched
            </button>
          )}
        </div>
        <div className="suppliers-search-area">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search suppliers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); searchRef.current?.blur() } }}
            className="suppliers-search-input"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); searchRef.current?.focus() }}
              className="suppliers-search-clear"
            >
              <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
            </button>
          )}
        </div>
      </div>

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
                  {search ? `No suppliers matching "${search}"` : 'No suppliers found. Upload a CSV to populate suppliers.'}
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
