import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ipc } from '../lib/ipc'
import type { ProjectSupplierView, SupplierType, SupplierInfo } from '../../shared/types/suppliers'
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
              // Auto-commit on select change
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


export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [catAFilter, setCatAFilter] = useState<'all' | 'catA' | 'nonCatA'>('all')
  const [classificationMap, setClassificationMap] = useState<Record<string, { l1: string; l2: string; l3: string }>>({})

  /** Build supplier->{l1,l2,l3} map from transactions (top classification by spend per supplier) */
  const buildClassificationMap = (transactions: { classificationPath?: string | null; canonicalFields?: Record<string, unknown> }[]): Record<string, { l1: string; l2: string; l3: string }> => {
    // Accumulate spend per supplier+path combo
    const spendBySupplierPath = new Map<string, Map<string, number>>()
    for (const t of transactions) {
      const supplier = t.canonicalFields?.supplier_name
      if (!supplier || !t.classificationPath) continue
      const name = String(supplier)
      if (!spendBySupplierPath.has(name)) spendBySupplierPath.set(name, new Map())
      const pathMap = spendBySupplierPath.get(name)!
      const spend = Number(t.canonicalFields?.spend_amount ?? 0) || 0
      pathMap.set(t.classificationPath, (pathMap.get(t.classificationPath) || 0) + Math.abs(spend))
    }

    // Pick top path per supplier
    const result: Record<string, { l1: string; l2: string; l3: string }> = {}
    for (const [supplier, pathMap] of spendBySupplierPath) {
      let topPath = ''
      let topSpend = -1
      for (const [path, spend] of pathMap) {
        if (spend > topSpend) { topPath = path; topSpend = spend }
      }
      if (topPath) {
        const parts = topPath.split('|').map(p => p.trim())
        result[supplier] = { l1: parts[0] || '', l2: parts[1] || '', l3: parts[2] || '' }
      }
    }
    return result
  }

  const loadData = async () => {
    // Only show spinner if no cached data
    if (suppliers.length === 0) setLoading(true)
    setError(null)
    try {
      const [data, paginatedResult] = await Promise.all([
        ipc.suppliers.list(),
        ipc.transactions.query(),
      ])
      setSuppliers(data as ProjectSupplierView[])
      setClassificationMap(buildClassificationMap(paginatedResult.rows))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suppliers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

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
        [field]: newValue || undefined, // clear empty strings
      }
      await ipc.suppliers.update(supplier.supplierName, { supplierInfo: updatedInfo })

      // Update local state immediately
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

  /** Save categoryA toggle */
  const saveCategoryA = useCallback(async (supplier: ProjectSupplierView, checked: boolean) => {
    setSaving(true)
    try {
      await ipc.suppliers.update(supplier.supplierName, { categoryA: checked })
      updateSuppliers(prev => prev.map(s =>
        s.id === supplier.id ? { ...s, categoryA: checked } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }, [updateSuppliers])

  /** Get display value for a supplierInfo field */
  const getFieldValue = (supplier: ProjectSupplierView, field: keyof SupplierInfo): string => {
    const info = supplier.supplierInfo
    if (!info) return ''
    const val = info[field]
    if (val == null) return ''
    if (Array.isArray(val)) return val.join(', ')
    return String(val)
  }

  /** Sort by spend descending, then filter by catA and search */
  const filteredSuppliers = useMemo(() => {
    let result = [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend)

    // Category A filter
    if (catAFilter === 'catA') result = result.filter(s => s.categoryA)
    else if (catAFilter === 'nonCatA') result = result.filter(s => !s.categoryA)

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
  }, [suppliers, search, catAFilter])

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

      <div className="flex items-center justify-end gap-2 mb-2">
        <select
          className="rounded border border-gray-300 px-2 py-0.5 text-[11px] bg-white shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          value={catAFilter}
          onChange={(e) => setCatAFilter(e.target.value as 'all' | 'catA' | 'nonCatA')}
        >
          <option value="all">All</option>
          <option value="catA">Cat. A</option>
          <option value="nonCatA">Non Cat. A</option>
        </select>
        <div className="relative">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search suppliers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); searchRef.current?.blur() } }}
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] bg-white shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none w-40"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); searchRef.current?.focus() }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="suppliers-table-wrap">
        <table className="suppliers-table">
          <thead>
            <tr>
              <th className="col-supplier">Supplier</th>
              <th className="col-right">Txns</th>
              <th className="col-right">Spend</th>
              <th className="col-center">Cat. A</th>
              <th>L1</th>
              <th>L2</th>
              <th>L3</th>
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
              <tr key={s.id}>
                <td className="col-supplier" title={s.supplierName}>{s.supplierName}</td>
                <td className="col-right">{s.transactionCount}</td>
                <td className="col-right">
                  {fmtAbbrev(s.totalSpend)}
                </td>
                <td className="col-center">
                  <input
                    type="checkbox"
                    className="supplier-cata-check"
                    checked={s.categoryA}
                    onChange={(e) => saveCategoryA(s, e.target.checked)}
                  />
                </td>
                <td title={classificationMap[s.supplierName]?.l1 || ''}>
                  {classificationMap[s.supplierName]?.l1 || <span className="cell-placeholder">-</span>}
                </td>
                <td title={classificationMap[s.supplierName]?.l2 || ''}>
                  {classificationMap[s.supplierName]?.l2 || <span className="cell-placeholder">-</span>}
                </td>
                <td title={classificationMap[s.supplierName]?.l3 || ''}>
                  {classificationMap[s.supplierName]?.l3 || <span className="cell-placeholder">-</span>}
                </td>

                {INFO_COLUMNS.map(col => {
                  const val = getFieldValue(s, col.key)
                  const parentCell = col.key === 'officialBusinessName' ? (
                    <td>
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
                  {search ? `No suppliers matching "${search}"` : 'No suppliers found. Upload a CSV and run classification to populate suppliers.'}
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
