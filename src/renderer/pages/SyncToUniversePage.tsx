import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ipc } from '../lib/ipc'
import type { ProjectSupplierView } from '../../shared/types/suppliers'
import type { GroupedFilter } from '../../shared/types/transactions'
import type { FieldDefinition } from '../components/FilterConditionBuilder'
import { OPERATOR_LABELS } from '../components/FilterConditionBuilder'
import { groupedToConditions } from '../../shared/filter-utils'
import type { FilterOperator } from '../../shared/types/transactions'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import { Filter, X, Download, ArrowUpCircle } from 'lucide-react'
import { fmtAbbrev } from '../utils/formatSpend'
import ExportCSVPanel from '../components/ExportCSVPanel'

type FilterMode = 'researched' | 'custom'

/** Preset grouped filter that selects only researched suppliers */
const RESEARCHED_FILTER: GroupedFilter = {
  groupConnector: 'AND',
  groups: [{
    connector: 'AND',
    conditions: [{ field: 'is_researched', operator: 'is_true' as FilterOperator, value: '', connector: 'AND' }],
  }],
}

/** Expandable summary row with supplier list dropdown */
function SummarySection({
  label,
  count,
  suppliers,
  bgClass,
  textClass,
  badgeClass,
}: {
  label: string
  count: number
  suppliers: ProjectSupplierView[]
  bgClass: string
  textClass: string
  badgeClass: string
}) {
  if (count === 0) return null

  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden">
      {/* Section header */}
      <div className={`flex items-center justify-between px-4 py-2.5 ${bgClass}`}>
        <span className={`text-sm font-medium ${textClass}`}>{label}</span>
        <span className={`text-sm font-semibold ${badgeClass}`}>{count}</span>
      </div>
      {/* Supplier list — always visible */}
      <div className="divide-y divide-gray-50 bg-white">
        {suppliers.map(s => (
          <div key={s.id} className="flex items-center gap-2 px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-gray-800 truncate">{s.supplierName}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-400">{fmtAbbrev(s.totalSpend)}</span>
                <span className="text-[10px] text-gray-300">&middot;</span>
                <span className="text-[10px] text-gray-400">{s.transactionCount} txns</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

type ViewMode = 'sync' | 'export'

export default function SyncToUniversePage() {
  const [viewMode, setViewMode] = useState<ViewMode>('sync')
  const [filterMode, setFilterMode] = useState<FilterMode>('researched')
  const [customGrouped, setCustomGrouped] = useState<GroupedFilter | null>(null)
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [loading, setLoading] = useState(true)
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: number; errors: string[] } | null>(null)
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load filter fields once
  useEffect(() => {
    ipc.suppliers.getFilterFields()
      .then(fields => setFilterFields(fields as FieldDefinition[]))
      .catch(() => {})
  }, [])

  // Whether the custom filter has valid conditions
  const hasCustomFilter = customGrouped && customGrouped.groups.some(g => g.conditions.some(c => c.field))

  // Build the active filter based on mode
  const activeFilter = useMemo(() => {
    if (filterMode === 'researched') {
      return { groupedConditions: RESEARCHED_FILTER }
    }
    if (filterMode === 'custom' && hasCustomFilter) {
      return { groupedConditions: customGrouped }
    }
    return undefined
  }, [filterMode, customGrouped, hasCustomFilter])

  // Load suppliers when filter changes — skip when custom mode has no filter
  const loadData = useCallback(async () => {
    if (filterMode === 'custom' && !hasCustomFilter) {
      setSuppliers([])
      setLoading(false)
      return
    }
    setLoading(true)
    setSyncResult(null)
    try {
      const data = await ipc.suppliers.list(activeFilter as Parameters<typeof ipc.suppliers.list>[0])
      setSuppliers(data as ProjectSupplierView[])
    } catch {
      setSuppliers([])
    } finally {
      setLoading(false)
    }
  }, [activeFilter, filterMode, hasCustomFilter])

  useEffect(() => { loadData() }, [loadData])

  // Flat conditions for display badges (custom mode)
  const filterConditions = useMemo(() =>
    customGrouped ? groupedToConditions(customGrouped).filter(c => c.field) : [],
    [customGrouped]
  )

  // Summary computed from loaded suppliers
  const syncSummary = useMemo(() => {
    const researched = suppliers.filter(s => s.isResearched)
    const unconfirmed = researched.filter(s => s.confirmationStatus !== 'confirmed')
    const notResearched = suppliers.filter(s => !s.isResearched)
    return { researched, unconfirmed, notResearched, total: suppliers.length }
  }, [suppliers])



  // Handle chip switching
  const handleResearchedChip = useCallback(() => {
    setFilterMode('researched')
  }, [])

  const handleCustomChip = useCallback(() => {
    setFilterMode('custom')
    setShowAdvancedFilter(true)
  }, [])

  // Confirm sync — fires the actual sync
  const handleSyncNow = useCallback(async () => {
    const idsToSync = filterMode === 'researched'
      ? syncSummary.researched.map(s => s.id)
      : suppliers.map(s => s.id)
    if (idsToSync.length === 0) return
    setSyncing(true)
    try {
      const result = await ipc.suppliers.syncToUniverse(idsToSync)
      setSyncResult(result)
      // Auto-close success modal after 3 seconds (only if no failures)
      if (result.failed === 0) {
        autoCloseTimer.current = setTimeout(() => {
          setSyncResult(null)
          loadData()
        }, 3000)
      }
    } catch (e) {
      setSyncResult({ synced: 0, failed: idsToSync.length, errors: [e instanceof Error ? e.message : 'Sync failed'] })
    } finally {
      setSyncing(false)
    }
  }, [syncSummary, filterMode, suppliers])

  const handleResultClose = useCallback(() => {
    if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current)
    setSyncResult(null)
    loadData()
  }, [loadData])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current)
    }
  }, [])

  const chipClass = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer border ${
      active
        ? 'bg-blue-100 text-blue-700 border-blue-300'
        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
    }`

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="px-6 py-5 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">
            {viewMode === 'sync' ? 'Sync to Supplier Universe' : 'Export CSV Data'}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {viewMode === 'sync'
              ? 'Select suppliers to sync to the shared Supplier Universe database.'
              : 'Select and reorder columns for your CSV export.'
            }
          </p>
        </div>
        <button
          type="button"
          onClick={() => setViewMode(viewMode === 'sync' ? 'export' : 'sync')}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          {viewMode === 'sync' ? (
            <>
              <Download size={14} />
              Export CSV Data
            </>
          ) : (
            <>
              <ArrowUpCircle size={14} />
              Sync to Universe
            </>
          )}
        </button>
      </div>

      {viewMode === 'sync' ? (
        <>
      {/* Filter chip bar + Sync button */}
      <div className="px-6 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2">
          <button type="button" className={chipClass(filterMode === 'researched')} onClick={handleResearchedChip}>
            Researched
          </button>
          <button type="button" className={chipClass(filterMode === 'custom')} onClick={handleCustomChip}>
            <span className="flex items-center gap-1.5">
              <Filter size={12} />
              Custom Filter
              {filterMode === 'custom' && filterConditions.length > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] font-bold">
                  {filterConditions.length}
                </span>
              )}
            </span>
          </button>
          <div className="flex-1" />
        </div>

        {/* Active filter condition badges — grouped with parentheses, AND/OR, horizontal scroll */}
        {filterMode === 'custom' && customGrouped && filterConditions.length > 0 && (
          <div
            onClick={() => setShowAdvancedFilter(true)}
            className="cursor-pointer rounded-md border border-gray-200 bg-white px-2.5 py-1.5 hover:border-blue-300 hover:bg-blue-50/30 transition-colors overflow-x-auto scrollbar-hide mt-2"
            style={{ scrollbarWidth: 'none' }}
          >
            <div className="flex items-center gap-0.5 whitespace-nowrap">
              {customGrouped.groups.map((group, gi) => {
                const validConditions = group.conditions.filter(c => c.field)
                if (validConditions.length === 0) return null
                const groupConnector = gi > 0
                  ? ((group as any).groupConnector ?? customGrouped.groupConnector)
                  : null
                return (
                  <span key={gi} className="contents">
                    {groupConnector && (
                      <span className="mx-0.5 text-[9px] font-bold text-blue-600">{groupConnector}</span>
                    )}
                    {validConditions.length > 1 && <span className="text-[10px] text-gray-400">(</span>}
                    {validConditions.map((c, ci) => {
                      const condConnector = ci > 0
                        ? (validConditions[ci - 1].connector ?? group.connector)
                        : null
                      const displayValue = ['is_true', 'is_false', 'is_null'].includes(c.operator)
                        ? ''
                        : ` "${Array.isArray(c.value) ? c.value.join(', ') : c.value}"`
                      return (
                        <span key={ci} className="contents">
                          {condConnector && (
                            <span className="mx-0.5 text-[9px] font-bold text-gray-500">{condConnector}</span>
                          )}
                          <span className="inline-flex items-center rounded bg-gray-100 px-1 py-px text-[10px] text-gray-700">
                            <span className="font-medium">{c.field}</span>
                            <span className="mx-0.5 text-gray-400">{OPERATOR_LABELS[c.operator as keyof typeof OPERATOR_LABELS] ?? c.operator}</span>
                            {displayValue && <span className="text-blue-600">{displayValue}</span>}
                          </span>
                        </span>
                      )
                    })}
                    {validConditions.length > 1 && <span className="text-[10px] text-gray-400">)</span>}
                  </span>
                )
              })}
              <span className="ml-1.5 text-[9px] text-gray-400 shrink-0">click to edit</span>
            </div>
          </div>
        )}
      </div>

      {/* Main area */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
          </div>
        ) : filterMode === 'custom' && filterConditions.length === 0 ? (
          <div className="flex items-center justify-center flex-1">
            <p className="text-sm text-gray-400">Set up a custom filter to select suppliers for sync.</p>
          </div>
        ) : suppliers.length === 0 ? (
          <div className="flex items-center justify-center flex-1">
            <p className="text-sm text-gray-400">No suppliers match the current filter.</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
              {filterMode === 'researched' ? (
                <>
                  <SummarySection
                    label="Researched — will be synced"
                    count={syncSummary.researched.length}
                    suppliers={syncSummary.researched}
                    bgClass="bg-green-50"
                    textClass="text-green-800"
                    badgeClass="text-green-700"
                  />
                  {syncSummary.unconfirmed.length > 0 && (
                    <SummarySection
                      label="Unconfirmed — will still sync"
                      count={syncSummary.unconfirmed.length}
                      suppliers={syncSummary.unconfirmed}
                      bgClass="bg-amber-50"
                      textClass="text-amber-800"
                      badgeClass="text-amber-700"
                    />
                  )}
                  <SummarySection
                    label="Not researched — will be skipped"
                    count={syncSummary.notResearched.length}
                    suppliers={syncSummary.notResearched}
                    bgClass="bg-gray-100"
                    textClass="text-gray-500"
                    badgeClass="text-gray-400"
                  />
                </>
              ) : (
                <SummarySection
                  label="Suppliers to sync"
                  count={suppliers.length}
                  suppliers={suppliers}
                  bgClass="bg-blue-50"
                  textClass="text-blue-800"
                  badgeClass="text-blue-700"
                />
              )}
            </div>

            {/* Bottom bar with Sync Now */}
            <div className="border-t border-gray-200 bg-white px-6 py-3 flex items-center justify-end">
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={syncing || (filterMode === 'researched' ? syncSummary.researched.length === 0 : suppliers.length === 0)}
                className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {syncing ? (
                  <>
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Syncing...
                  </>
                ) : (
                  'Sync Now'
                )}
              </button>
            </div>
          </>
        )}
      </div>
        </>
      ) : (
        /* Export CSV view */
        <div className="flex-1 overflow-hidden p-4">
          <ExportCSVPanel />
        </div>
      )}

      {/* Success/failure modal — auto-closes after 3s on success */}
      {syncResult && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={handleResultClose} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[420px]">
            {syncResult.failed === 0 ? (
              <div className="text-center py-8 px-6">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                  <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <h3 className="text-base font-semibold text-gray-900">Sync Complete</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Successfully synced <span className="font-semibold text-green-700">{syncResult.synced}</span> supplier{syncResult.synced !== 1 ? 's' : ''} to the Supplier Universe.
                </p>
                <p className="text-[10px] text-gray-300 mt-3">Closing automatically...</p>
              </div>
            ) : (
              <div className="py-6 px-6">
                <div className="text-center mb-4">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
                    <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                  </div>
                  <h3 className="text-base font-semibold text-gray-900">Sync Finished</h3>
                </div>
                <div className="space-y-2">
                  {syncResult.synced > 0 && (
                    <div className="flex items-center justify-between rounded-lg bg-green-50 px-4 py-2.5">
                      <span className="text-sm text-green-800">Synced successfully</span>
                      <span className="text-sm font-semibold text-green-700">{syncResult.synced}</span>
                    </div>
                  )}
                  <div className="rounded-lg bg-red-50 px-4 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-red-800">Failed</span>
                      <span className="text-sm font-semibold text-red-700">{syncResult.failed}</span>
                    </div>
                    {syncResult.errors.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {syncResult.errors.slice(0, 5).map((err, i) => (
                          <li key={i} className="text-xs text-red-600 truncate" title={err}>{err}</li>
                        ))}
                        {syncResult.errors.length > 5 && (
                          <li className="text-xs text-red-400">...and {syncResult.errors.length - 5} more</li>
                        )}
                      </ul>
                    )}
                  </div>
                </div>
                <button
                  onClick={handleResultClose}
                  className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Advanced filter modal (custom mode) */}
      <AdvancedFilterModal
        isOpen={showAdvancedFilter}
        onClose={() => setShowAdvancedFilter(false)}
        groupedFilter={customGrouped}
        onApply={setCustomGrouped}
        availableFields={filterFields}
        fetchDistinctValues={(field, limit) => ipc.suppliers.distinctValues(field, limit)}
        title="Custom Supplier Filter"
        subtitle="Build conditions to select suppliers for sync"
      />
    </div>
  )
}
