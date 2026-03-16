import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ipc } from '../lib/ipc'
import type { ProjectSupplierView, SupplierInfo } from '../../shared/types/suppliers'
import type { ResearchProgress } from '../../shared/types/classification'
import type { GroupedFilter } from '../../shared/types/transactions'
import type { FieldDefinition } from '../components/FilterConditionBuilder'
import { groupedToConditions, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import type { FilterOperator } from '../../shared/types/transactions'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import SupplierListPanel from '../components/suppliers/SupplierListPanel'
import SupplierDetailPanel from '../components/suppliers/SupplierDetailPanel'
import type { SupplierDetailPanelHandle } from '../components/suppliers/SupplierDetailPanel'
import { useSupplierListKeyboard } from '../hooks/useSupplierListKeyboard'
import { Filter, X } from 'lucide-react'
import '../styles/SuppliersPage.css'
import { fmtAbbrev } from '../utils/formatSpend'

type QuickFilter = 'all' | 'unresearched' | 'unconfirmed'

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const [advancedGrouped, setAdvancedGrouped] = useState<GroupedFilter | null>(null)
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | null>(null)
  const [tailSpendThreshold, setTailSpendThreshold] = useState<string>('')
  const [tailSpendSet, setTailSpendSet] = useState(false)
  const [supplierUniversePath, setSupplierUniversePath] = useState<string | null>(null)

  // New state for master-detail
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')

  // Cross-panel keyboard navigation
  const [activePanel, setActivePanel] = useState<'list' | 'detail'>('list')
  const [detailFieldIndex, setDetailFieldIndex] = useState(0)
  const [editingFieldIndex, setEditingFieldIndex] = useState<number | null>(null)
  const detailPanelRef = useRef<SupplierDetailPanelHandle>(null)

  // Derive flat conditions for display (badge count, empty state check)
  const filterConditions = useMemo(() =>
    advancedGrouped ? groupedToConditions(advancedGrouped).filter(c => c.field) : [],
    [advancedGrouped]
  )

  // Build backend filter from grouped conditions
  const buildFilter = useCallback(() => {
    if (advancedGrouped && advancedGrouped.groups.some(g => g.conditions.some(c => c.field))) {
      return { groupedConditions: advancedGrouped }
    }
    return undefined
  }, [advancedGrouped])

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
      if (progress.status === 'running' && progress.processedSuppliers > 0) {
        // Incrementally refresh to show newly-researched suppliers without disturbing the current view
        loadData()
      }
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
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

  /** Save a single supplierInfo field */
  const saveField = useCallback(async (supplier: ProjectSupplierView, field: keyof SupplierInfo, newValue: string) => {
    setSaving(true)
    try {
      const existingInfo = supplier.supplierInfo ?? {}
      const parsedValue = field === 'sources'
        ? (newValue ? newValue.split(',').map(s => s.trim()).filter(Boolean) : undefined)
        : (newValue || undefined)
      const updatedInfo: SupplierInfo = { ...existingInfo, [field]: parsedValue }
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

  /** Save parentName */
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

  /** Batch research selected */
  const researchSelected = useCallback(async () => {
    const selected = suppliers.filter(s => selectedIds.has(s.id) && !s.isResearched)
    if (selected.length === 0) return
    for (const s of selected) {
      try { await ipc.suppliers.researchSingle(s.supplierName) } catch { /* continue */ }
    }
    setSelectedIds(new Set())
    await loadData()
  }, [suppliers, selectedIds, loadData])

  /** Batch confirm selected */
  const confirmSelected = useCallback(async () => {
    const selected = suppliers.filter(s => selectedIds.has(s.id) && s.isResearched && s.confirmationStatus !== 'confirmed')
    if (selected.length === 0) return
    const confirmedIds = new Set(selected.map(s => s.id))
    for (const s of selected) {
      try { await ipc.suppliers.confirm(s.id, 'confirmed') } catch { /* continue */ }
    }
    updateSuppliers(prev => prev.map(s =>
      confirmedIds.has(s.id) ? { ...s, confirmationStatus: 'confirmed' } : s
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

  /** Change supplier universe DB */
  const changeSupplierUniverse = useCallback(async () => {
    try {
      const selected = await ipc.supplierUniverse.selectFile()
      if (!selected) return
      setSupplierUniversePath(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set supplier universe path')
    }
  }, [])

  // --- Derived data for the two-panel layout ---

  /** Sort by spend descending */
  const sortedSuppliers = useMemo(() =>
    [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend),
    [suppliers]
  )

  /** Apply quick filter */
  const quickFiltered = useMemo(() => {
    if (quickFilter === 'unresearched') return sortedSuppliers.filter(s => !s.isResearched)
    if (quickFilter === 'unconfirmed') return sortedSuppliers.filter(s => s.confirmationStatus !== 'confirmed')
    return sortedSuppliers
  }, [sortedSuppliers, quickFilter])

  /** Apply search */
  const displayedSuppliers = useMemo(() => {
    if (!searchQuery) return quickFiltered
    const q = searchQuery.toLowerCase()
    return quickFiltered.filter(s => s.supplierName.toLowerCase().includes(q))
  }, [quickFiltered, searchQuery])

  /** Counts for quick filter chips (from backend-filtered, pre-search) */
  const unresearchedCount = useMemo(() => sortedSuppliers.filter(s => !s.isResearched).length, [sortedSuppliers])
  const unconfirmedCount = useMemo(() => sortedSuppliers.filter(s => s.confirmationStatus !== 'confirmed').length, [sortedSuppliers])

  /** Selected supplier for detail panel */
  const selectedSupplier = useMemo(() =>
    selectedSupplierId ? suppliers.find(s => s.id === selectedSupplierId) ?? null : null,
    [suppliers, selectedSupplierId]
  )

  // Keyboard navigation
  const handleSupplierSelect = useCallback((index: number) => {
    const s = displayedSuppliers[index]
    if (s) setSelectedSupplierId(s.id)
  }, [displayedSuppliers])

  const handleToggleCheck = useCallback((index: number) => {
    const s = displayedSuppliers[index]
    if (!s) return
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(s.id)) next.delete(s.id)
      else next.add(s.id)
      return next
    })
  }, [displayedSuppliers])

  const handleMoveToDetail = useCallback(() => {
    if (!selectedSupplier) return
    setActivePanel('detail')
    setDetailFieldIndex(0)
    setEditingFieldIndex(null)
    setTimeout(() => detailPanelRef.current?.focusField(0), 0)
  }, [selectedSupplier])

  const handleMoveToList = useCallback(() => {
    setActivePanel('list')
    setEditingFieldIndex(null)
  }, [])

  const handleClearSelections = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const { focusedIndex, setFocusedIndex, handleKeyDown } = useSupplierListKeyboard({
    itemCount: displayedSuppliers.length,
    onSelect: handleSupplierSelect,
    onToggleCheck: handleToggleCheck,
    onMoveToDetail: handleMoveToDetail,
    onClearSelections: handleClearSelections,
    disabled: activePanel !== 'list',
  })

  // Click handler for list items
  const handleSupplierClick = useCallback((index: number) => {
    setActivePanel('list')
    setFocusedIndex(index)
    const s = displayedSuppliers[index]
    if (s) setSelectedSupplierId(s.id)
  }, [displayedSuppliers, setFocusedIndex])

  // Toggle checkbox by ID (from list panel)
  const toggleCheckById = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Select-all for displayed suppliers
  const allChecked = displayedSuppliers.length > 0 && displayedSuppliers.every(s => selectedIds.has(s.id))
  const someSelected = selectedIds.size > 0

  const toggleSelectAll = useCallback(() => {
    if (allChecked) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(displayedSuppliers.map(s => s.id)))
    }
  }, [allChecked, displayedSuppliers])

  // Auto-select first supplier when data loads
  useEffect(() => {
    if (!selectedSupplierId && displayedSuppliers.length > 0) {
      setSelectedSupplierId(displayedSuppliers[0].id)
    }
  }, [displayedSuppliers, selectedSupplierId])

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
      {researchProgress && researchProgress.status === 'running' && (
        <div className="suppliers-progress">
          <div className="flex items-center justify-between mb-1">
            <span>Researching: <strong>{researchProgress.currentSupplier}</strong></span>
            <span className="text-xs">{researchProgress.processedSuppliers}/{researchProgress.totalSuppliers}</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${(researchProgress.processedSuppliers / researchProgress.totalSuppliers) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Top bar: batch actions + filter button */}
      <div className="suppliers-top-bar">
        {/* Batch actions */}
        {someSelected && (
          <div className="batch-actions">
            <button onClick={researchSelected} className="action-btn research">Research Selected</button>
            <button onClick={confirmSelected} className="action-btn confirm">Confirm Selected</button>
            <span className="selected-count">{selectedIds.size} checked</span>
          </div>
        )}

        <div className="flex-1" />

        {/* Filter controls */}
        {filterConditions.length > 0 && (
          <button
            onClick={() => setAdvancedGrouped(null)}
            className="text-xs text-red-500 hover:text-red-600 font-medium"
          >
            Clear filters
          </button>
        )}
        <button
          onClick={() => setShowAdvancedFilter(true)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            filterConditions.length > 0
              ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Filter size={13} />
          Filters
          {filterConditions.length > 0 && (
            <span className="ml-1 rounded-full bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 leading-none">
              {filterConditions.length}
            </span>
          )}
        </button>
      </div>

      {/* Active filter chips */}
      {advancedGrouped && filterConditions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-0 pb-2">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mr-1">Active:</span>
          {advancedGrouped.groups.map((group, gi) => {
            const validConds = group.conditions.filter(c => c.field)
            if (validConds.length === 0) return null
            return (
              <React.Fragment key={gi}>
                {gi > 0 && (
                  <span className="text-[10px] font-bold text-blue-500 uppercase px-1">
                    {group.groupConnector ?? advancedGrouped.groupConnector}
                  </span>
                )}
                {validConds.length > 1 && <span className="text-gray-300 text-xs font-light">(</span>}
                {validConds.map((c, ci) => {
                  const opLabel = OPERATOR_LABELS[c.operator as FilterOperator] ?? c.operator
                  const displayValue = Array.isArray(c.value) ? c.value.join(', ') : String(c.value)
                  return (
                    <React.Fragment key={`${gi}-${ci}`}>
                      {ci > 0 && (
                        <span className="text-[10px] font-bold text-gray-400 uppercase px-0.5">{group.connector}</span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[11px] text-blue-800">
                        <span className="font-medium">{c.field}</span>
                        <span className="text-blue-500">{opLabel}</span>
                        {displayValue && <span className="font-semibold max-w-[150px] truncate" title={displayValue}>{displayValue}</span>}
                        <button
                          type="button"
                          onClick={() => {
                            const newGroups = advancedGrouped.groups.map((g, gIdx) => {
                              if (gIdx !== gi) return g
                              const newConds = g.conditions.filter((_, cIdx) => cIdx !== ci)
                              return { ...g, conditions: newConds.length > 0 ? newConds : [] }
                            }).filter(g => g.conditions.length > 0)
                            if (newGroups.length === 0) setAdvancedGrouped(null)
                            else setAdvancedGrouped({ ...advancedGrouped, groups: newGroups })
                          }}
                          className="ml-0.5 rounded-full p-0.5 text-blue-400 hover:bg-blue-200 hover:text-blue-700 transition-colors"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    </React.Fragment>
                  )
                })}
                {validConds.length > 1 && <span className="text-gray-300 text-xs font-light">)</span>}
              </React.Fragment>
            )
          })}
        </div>
      )}

      {/* Two-panel layout */}
      <div className="suppliers-content">
        <SupplierListPanel
          suppliers={displayedSuppliers}
          focusedIndex={focusedIndex}
          selectedIds={selectedIds}
          selectedSupplierId={selectedSupplierId}
          searchQuery={searchQuery}
          quickFilter={quickFilter}
          unresearchedCount={unresearchedCount}
          unconfirmedCount={unconfirmedCount}
          onSearchChange={setSearchQuery}
          onQuickFilterChange={setQuickFilter}
          onSupplierClick={handleSupplierClick}
          onToggleCheck={toggleCheckById}
          onToggleSelectAll={toggleSelectAll}
          onKeyDown={handleKeyDown}
          allChecked={allChecked}
          isActive={activePanel === 'list'}
          onResearch={researchSupplier}
          onConfirm={confirmSupplier}
        />
        <SupplierDetailPanel
          ref={detailPanelRef}
          supplier={selectedSupplier}
          onSaveField={saveField}
          onSaveParentName={saveParentName}
          onResearch={researchSupplier}
          onConfirm={confirmSupplier}
          focusedFieldIndex={detailFieldIndex}
          onFocusedFieldChange={setDetailFieldIndex}
          editingFieldIndex={editingFieldIndex}
          onEditingFieldChange={setEditingFieldIndex}
          onMoveToList={handleMoveToList}
          isActive={activePanel === 'detail'}
        />
      </div>

      {saving && <div className="supplier-saving">Saving...</div>}

      <AdvancedFilterModal
        isOpen={showAdvancedFilter}
        onClose={() => setShowAdvancedFilter(false)}
        groupedFilter={advancedGrouped}
        onApply={setAdvancedGrouped}
        availableFields={filterFields}
        fetchDistinctValues={(field, limit) => ipc.suppliers.distinctValues(field, limit)}
        title="Supplier Filters"
        subtitle="Build conditions to filter suppliers"
      />
    </div>
  )
}
