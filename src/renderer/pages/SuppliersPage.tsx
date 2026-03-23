import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ipc } from '../lib/ipc'
import type { ProjectSupplierView, SupplierInfo } from '../../shared/types/suppliers'
import type { ResearchProgress } from '../../shared/types/classification'
import type { FieldDefinition } from '../components/FilterConditionBuilder'
import { groupedToConditions, OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import type { FilterOperator } from '../../shared/types/transactions'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import SupplierListPanel from '../components/suppliers/SupplierListPanel'
import SupplierDetailPanel from '../components/suppliers/SupplierDetailPanel'
import type { SupplierDetailPanelHandle } from '../components/suppliers/SupplierDetailPanel'
import { useSupplierListKeyboard } from '../hooks/useSupplierListKeyboard'
import { Filter, X, GitMerge } from 'lucide-react'
import NormalizeView from '../components/normalize/NormalizeView'
import '../styles/SuppliersPage.css'
import { fmtAbbrev } from '../utils/formatSpend'
import { useSupplierFilterStore } from '../stores/supplierFilterStore'

type QuickFilter = 'all' | 'unresearched' | 'unconfirmed'
type ViewMode = 'suppliers' | 'normalize'

export default function SuppliersPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('suppliers')
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const { advancedGrouped, setAdvancedGrouped } = useSupplierFilterStore()
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | null>(null)
  const [tailSpendThreshold, setTailSpendThreshold] = useState<string>('10000')
  const [tailSpendSet, setTailSpendSet] = useState(false)
  const [tailSpendActive, setTailSpendActive] = useState(false)
  const [editingThreshold, setEditingThreshold] = useState(false)

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
        const [threshold, fields] = await Promise.all([
          ipc.project.getSetting('tail_spend_threshold'),
          ipc.suppliers.getFilterFields(),
        ])
        if (threshold && Number(threshold) > 0) {
          setTailSpendThreshold(String(threshold))
          setTailSpendSet(true)
        }
        setFilterFields(fields as FieldDefinition[])
      } catch {
        // settings load failure is non-fatal
      }
    }
    loadSettings()
    // Sync tailSpendActive from Zustand store (persists across navigations)
    const hasTailFilter = advancedGrouped?.groups.some(g =>
      g.conditions.some(c => c.field === 'is_tail_spend')
    )
    if (hasTailFilter) setTailSpendActive(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Reload supplier data when switching back from normalize tab
  useEffect(() => {
    if (viewMode === 'suppliers') loadData()
  }, [viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to research progress
  useEffect(() => {
    const unsub = ipc.suppliers.onResearchProgress((progress: ResearchProgress) => {
      setResearchProgress(progress)
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
        setTimeout(() => {
          setResearchProgress(null)
        }, 1500)
      }
    })
    return unsub
  }, [])

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
      await ipc.suppliers.update(supplier.id, { supplierInfo: updatedInfo })
      updateSuppliers(prev => prev.map(s =>
        s.id === supplier.id ? { ...s, supplierInfo: updatedInfo } : s
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }, [updateSuppliers])

  /** Save parentName — find or create the parent by name, then assign the FK */
  const saveParentName = useCallback(async (supplier: ProjectSupplierView, newValue: string) => {
    setSaving(true)
    try {
      if (!newValue) {
        await ipc.suppliers.assignParent([supplier.id], null)
        updateSuppliers(prev => prev.map(s =>
          s.id === supplier.id ? { ...s, parentSupplierId: null, parentName: null } : s
        ))
      } else {
        const parents = await ipc.suppliers.listParents()
        const existing = parents.find(p => p.name.toLowerCase() === newValue.toLowerCase())
        const parent = existing ?? await ipc.suppliers.addParent(newValue)
        await ipc.suppliers.assignParent([supplier.id], parent.id)
        updateSuppliers(prev => prev.map(s =>
          s.id === supplier.id ? { ...s, parentSupplierId: parent.id, parentName: parent.name } : s
        ))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }, [updateSuppliers])

  /** Research a single supplier */
  const researchSupplier = useCallback(async (supplier: ProjectSupplierView) => {
    setResearchProgress({
      status: 'running',
      totalSuppliers: 1,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: supplier.supplierName,
      currentStep: 'Researching',
    })
    try {
      const info = await ipc.suppliers.researchSingle(supplier.id)
      // Update just this supplier in local state instead of full reload
      updateSuppliers(prev => prev.map(s =>
        s.id === supplier.id ? { ...s, isResearched: true, supplierInfo: info } : s
      ))
      setResearchProgress({
        status: 'completed',
        totalSuppliers: 1,
        processedSuppliers: 1,
        percentage: 100,
        currentSupplier: supplier.supplierName,
        currentStep: 'Done',
      })
      setTimeout(() => setResearchProgress(null), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research failed')
      setResearchProgress(null)
    }
  }, [updateSuppliers])

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
    const total = selected.length
    for (let i = 0; i < total; i++) {
      const s = selected[i]
      setResearchProgress({
        status: 'running',
        totalSuppliers: total,
        processedSuppliers: i,
        percentage: Math.round((i / total) * 100),
        currentSupplier: s.supplierName,
        currentStep: `Researching ${i + 1} of ${total}`,
      })
      try {
        const info = await ipc.suppliers.researchSingle(s.id)
        updateSuppliers(prev => prev.map(existing =>
          existing.id === s.id ? { ...existing, isResearched: true, supplierInfo: info } : existing
        ))
      } catch { /* continue */ }
    }
    setResearchProgress({
      status: 'completed',
      totalSuppliers: total,
      processedSuppliers: total,
      percentage: 100,
      currentSupplier: null,
      currentStep: 'Done',
    })
    setTimeout(() => setResearchProgress(null), 3000)
    setSelectedIds(new Set())
  }, [suppliers, selectedIds, updateSuppliers])

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

  /** Toggle tail spend filter on/off */
  const toggleTailSpendFilter = useCallback(async (enable: boolean) => {
    if (enable) {
      const val = Number(tailSpendThreshold)
      if (!val || val <= 0) return
      setSaving(true)
      try {
        await ipc.project.setSetting('tail_spend_threshold', val)
        await ipc.suppliers.filterTailSpend(val)
        setTailSpendSet(true)
        // Inject is_tail_spend filter to hide tail-spend suppliers
        const tailCondition = { field: 'is_tail_spend', operator: 'is_true' as FilterOperator, value: '' }
        const current = advancedGrouped ?? { groupConnector: 'AND' as const, groups: [] }
        setAdvancedGrouped({
          groupConnector: current.groupConnector,
          groups: [...current.groups, { connector: 'AND' as const, conditions: [tailCondition] }],
        })
        setTailSpendActive(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to apply threshold')
      } finally {
        setSaving(false)
      }
    } else {
      // Remove is_tail_spend conditions from all groups
      if (advancedGrouped) {
        const cleaned = {
          ...advancedGrouped,
          groups: advancedGrouped.groups.map(g => ({
            ...g,
            conditions: g.conditions.filter(c => c.field !== 'is_tail_spend'),
          })).filter(g => g.conditions.length > 0),
        }
        setAdvancedGrouped(cleaned.groups.length > 0 ? cleaned : null)
      }
      setTailSpendActive(false)
    }
  }, [tailSpendThreshold, advancedGrouped, setAdvancedGrouped])

  // Sync tailSpendActive if user removes is_tail_spend from Advanced Filters
  useEffect(() => {
    if (!tailSpendActive) return
    const hasTailFilter = advancedGrouped?.groups.some(g =>
      g.conditions.some(c => c.field === 'is_tail_spend')
    )
    if (!hasTailFilter) setTailSpendActive(false)
  }, [advancedGrouped, tailSpendActive])

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

      {/* Row 1: Active filters (left) + Filters button (right) */}
      <div className="suppliers-top-bar">
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {viewMode !== 'normalize' && advancedGrouped && filterConditions.length > 0 && (
            <>
              <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mr-0.5 flex-shrink-0">Active:</span>
              {advancedGrouped.groups.map((group, gi) => {
                const validConds = group.conditions.filter(c => c.field)
                if (validConds.length === 0) return null
                return (
                  <React.Fragment key={gi}>
                    {gi > 0 && (
                      <span className="text-[8px] font-bold text-blue-500 uppercase px-0.5 flex-shrink-0">
                        {group.groupConnector ?? advancedGrouped.groupConnector}
                      </span>
                    )}
                    {validConds.length > 1 && <span className="text-gray-800 text-[11px] font-bold flex-shrink-0">(</span>}
                    {validConds.map((c, ci) => {
                      const opLabel = OPERATOR_LABELS[c.operator as FilterOperator] ?? c.operator
                      const displayValue = Array.isArray(c.value) ? c.value.join(', ') : String(c.value)
                      return (
                        <React.Fragment key={`${gi}-${ci}`}>
                          {ci > 0 && (
                            <span className="text-[8px] font-bold text-gray-400 uppercase px-0.5 flex-shrink-0">{validConds[ci - 1].connector ?? group.connector}</span>
                          )}
                          <span className="inline-flex items-center gap-0.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[9px] text-blue-800 whitespace-nowrap flex-shrink-0">
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
                    {validConds.length > 1 && <span className="text-gray-800 text-[11px] font-bold flex-shrink-0">)</span>}
                  </React.Fragment>
                )
              })}
              <button
                onClick={() => setAdvancedGrouped(null)}
                className="text-[9px] text-red-500 hover:text-red-600 font-medium ml-0.5 flex-shrink-0"
              >
                Clear
              </button>
            </>
          )}
        </div>

        <button
          onClick={() => setViewMode(viewMode === 'normalize' ? 'suppliers' : 'normalize')}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors flex-shrink-0 ${
            viewMode === 'normalize'
              ? 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <GitMerge size={13} />
          {viewMode === 'normalize' ? 'Supplier Research' : 'Normalize'}
        </button>

        {viewMode !== 'normalize' && (
          <button
            onClick={() => setShowAdvancedFilter(true)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors flex-shrink-0 ${
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
        )}

        {/* Tail Spend toggle button */}
        {viewMode !== 'normalize' && (
          <button
            onClick={() => !editingThreshold && toggleTailSpendFilter(!tailSpendActive)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors flex-shrink-0 ${
              tailSpendActive
                ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            Tail Spend:
            {editingThreshold ? (
              <input
                type="number"
                className="w-[80px] px-1 py-0 border border-amber-300 rounded text-xs bg-white outline-none"
                defaultValue={tailSpendThreshold}
                autoFocus
                onBlur={async (e) => {
                  const newVal = e.target.value
                  setEditingThreshold(false)
                  if (Number(newVal) > 0) {
                    setTailSpendThreshold(newVal)
                    try {
                      await ipc.project.setSetting('tail_spend_threshold', Number(newVal))
                      await ipc.suppliers.filterTailSpend(Number(newVal))
                      if (tailSpendActive) await loadData()
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to save threshold')
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingThreshold(false)
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                onClick={(e) => { e.stopPropagation(); setEditingThreshold(true) }}
                className="cursor-pointer hover:underline font-semibold"
              >
                {fmtAbbrev(Number(tailSpendThreshold) || 10000)}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Normalize view */}
      {viewMode === 'normalize' && <NormalizeView />}

      {/* Row 2: Research progress bar */}
      {viewMode === 'suppliers' && researchProgress && researchProgress.status === 'running' && (
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
      {viewMode === 'suppliers' && researchProgress && researchProgress.status === 'completed' && (
        <div className="suppliers-progress">
          <div className="flex items-center gap-2 py-1">
            <span className="text-green-600 font-semibold text-sm">✓ Research completed</span>
            <span className="text-gray-500 text-xs">({researchProgress.totalSuppliers} supplier{researchProgress.totalSuppliers > 1 ? 's' : ''} researched)</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill bg-green-500" style={{ width: '100%' }} />
          </div>
        </div>
      )}

      {/* Two-panel layout */}
      {viewMode === 'suppliers' && <div className="suppliers-content">
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
          onResearchSelected={researchSelected}
          onConfirmSelected={confirmSelected}
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
      </div>}

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
