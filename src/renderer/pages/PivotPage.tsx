import { useMemo, useCallback, useEffect, useState, useRef } from 'react'
import HierarchicalPivotView from '../components/review/HierarchicalPivotView'
import ReclassifyModal from '../components/review/ReclassifyModal'
import DrillDownPanel from '../components/review/DrillDownPanel'
import CreateRuleModal from '../components/review/CreateRuleModal'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import { useServerPivotData } from '../hooks/useServerPivotData'
import { useReclassification } from '../hooks/useReclassification'
import { useIPC } from '../hooks/useIPC'
import { ipc } from '../lib/ipc'
import { usePivotStore } from '../stores/pivotStore'
import type { FlattenedPivotRow } from '../types/pivot'
import type { TransactionFilter, GroupedFilter } from '../../shared/types/transactions'
import type { FieldDefinition } from '../components/FilterConditionBuilder'
import { groupedToConditions } from '../components/FilterConditionBuilder'
import { RefreshCw, ListFilter } from 'lucide-react'

/**
 * Convert dimension pill filters into a TransactionFilter.
 */
function buildTransactionFilter(pillState: Record<string, string[]>): TransactionFilter | undefined {
  const conditions = Object.entries(pillState)
    .filter(([, values]) => values.length > 0)
    .map(([field, values]) => ({ field, operator: 'in_list' as const, value: values }))

  return conditions.length > 0 ? { conditions } : undefined
}

/** Columns that are internal DB plumbing — never shown in the UI. */
const INTERNAL_COLS = new Set([
  'id', 'row_index', 'upload_id', 'taxonomy_node_id',
  'classification_status', 'human_reviewed',
  'original_supplier_name', 'project_supplier_id',
  'applied_rule_id',
  'created_at', 'updated_at',
])

/** Virtual columns resolved via JOIN — excluded from pivot dimension dropdowns (added manually below). */
const VIRTUAL_COLS = new Set(['classification_l1', 'classification_l2', 'classification_l3', 'is_tail_spend', 'is_researched', 'applied_rule_name'])

/** Columns excluded from pivot dropdowns but still available in advanced filters. */
const PIVOT_ONLY_EXCLUDE = new Set(['is_tail_spend', 'is_researched'])

const COLUMN_LABELS: Record<string, string> = {
  classification_l1: 'Classification L1',
  classification_l2: 'Classification L2',
  classification_l3: 'Classification L3',
  classification_path: 'Classification Path (L1 › L2 › L3)',
  supplier_name: 'Supplier',
  applied_rule_name: 'Applied Rule',
  is_tail_spend: 'Tail Spend',
  is_researched: 'Researched',
  gl_description: 'GL Description',
  line_description: 'Line Description',
  company: 'Company',
  spend_amount: 'Spend Amount',
  amount: 'Amount',
  invoice_amount: 'Invoice Amount',
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  country: 'Country',
}

const NUMERIC_COLS = new Set(['spend_amount', 'amount', 'invoice_amount'])

export default function PivotPage() {
  // Persisted state from Zustand store (survives tab switches)
  const {
    rowDimensions, setRowDimensions,
    valueDimension, setValueDimension,
    aggregation, setAggregation,
    filterState, setFilterState,
    spendDisplayMode, setSpendDisplayMode,
    advancedGrouped, setAdvancedGrouped,
    showAdvancedFilter, setShowAdvancedFilter,
    flaggedForReviewOnly, setFlaggedForReviewOnly,
    classificationFilter, cycleClassificationFilter,
    clearAllFilters,
  } = usePivotStore()

  // Transient UI state (OK to lose on tab switch)
  const [drillDownRow, setDrillDownRow] = useState<FlattenedPivotRow | null>(null)
  const [createRuleRows, setCreateRuleRows] = useState<FlattenedPivotRow[] | null>(null)

  // Flat conditions derived from grouped for backward compat (chips, badge count, etc.)
  const advancedConditions = useMemo(() =>
    advancedGrouped ? groupedToConditions(advancedGrouped).filter(c => c.field) : [],
    [advancedGrouped]
  )

  const { data: columns } = useIPC(() => ipc.transactions.getColumns(), [])

  // Load suggestions for string filter fields (supplier names, etc.)
  const [supplierSuggestions, setSupplierSuggestions] = useState<string[]>([])
  useEffect(() => {
    ipc.transactions.distinctValues('supplier_name', 5000)
      .then(vals => setSupplierSuggestions(vals.filter(Boolean)))
      .catch(() => {})
  }, [])

  const filter = useMemo(() => {
    const pillFilter = buildTransactionFilter(filterState)
    const pillConditions = pillFilter?.conditions ?? []
    const flaggedCondition = flaggedForReviewOnly
      ? [{ field: 'flagged_for_review', operator: 'is_true' as const, value: '' }]
      : []
    const classificationCondition = classificationFilter === 'classified'
      ? [{ field: 'classification_status', operator: 'not_equals' as const, value: 'unclassified' }]
      : classificationFilter === 'unclassified'
        ? [{ field: 'classification_status', operator: 'equals' as const, value: 'unclassified' }]
        : []
    const allConditions = [...pillConditions, ...advancedConditions, ...flaggedCondition, ...classificationCondition]
    if (allConditions.length === 0) return undefined

    // If we have a grouped filter, merge pill conditions as an extra group
    if (advancedGrouped && advancedGrouped.groups.some(g => g.conditions.some(c => c.field))) {
      const pillGroup = pillConditions.length > 0
        ? [{ connector: 'AND' as const, conditions: pillConditions }]
        : []
      const merged: GroupedFilter = {
        groupConnector: 'AND',
        groups: [...pillGroup, ...advancedGrouped.groups],
      }
      return { conditions: allConditions, groupedConditions: merged } as TransactionFilter
    }

    // Only pill filters, no grouping needed
    return { conditions: allConditions } as TransactionFilter
  }, [filterState, advancedConditions, advancedGrouped, flaggedForReviewOnly, classificationFilter])

  const { pivotData, totalCount, refetch } = useServerPivotData(
    rowDimensions,
    valueDimension,
    aggregation,
    filter
  )

  const reclassify = useReclassification({
    filterState,
    onSuccess: refetch,
  })

  const availableColumns = useMemo(() => [
    'classification_l1', 'classification_l2', 'classification_l3', 'classification_path',
    'applied_rule_name',
    ...(columns ?? []).filter(c => !INTERNAL_COLS.has(c) && !VIRTUAL_COLS.has(c)),
  ], [columns])

  /** All columns available for advanced filters (includes boolean virtual cols excluded from pivot). */
  const filterableColumns = useMemo(() => [
    ...availableColumns,
    ...(columns ?? []).filter(c => PIVOT_ONLY_EXCLUDE.has(c)),
  ], [availableColumns, columns])

  const BOOLEAN_COLS = new Set(['is_tail_spend', 'is_researched', 'human_reviewed'])

  const advancedFilterFields: FieldDefinition[] = useMemo(() =>
    filterableColumns.map(col => ({
      name: col,
      label: COLUMN_LABELS[col] || col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      type: BOOLEAN_COLS.has(col) ? 'boolean' as const : NUMERIC_COLS.has(col) ? 'number' as const : 'string' as const,
      ...(col === 'supplier_name' && supplierSuggestions.length > 0 ? { suggestions: supplierSuggestions } : {}),
    })),
    [filterableColumns, supplierSuggestions]
  )

  const [generating, setGenerating] = useState(false)
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refreshBtnRef = useRef<HTMLButtonElement>(null)

  const handleGenerateRules = useCallback(async () => {
    setConfirmGenerate(false)
    setGenerating(true)
    try {
      await ipc.transactions.markAllReviewed()
      const result = await ipc.rules.generate()
      alert(`Created ${result.rulesCreated} rules for ${result.suppliersProcessed} suppliers.`)
      refetch()
    } catch (err) {
      alert(`Error generating rules: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setGenerating(false)
    }
  }, [refetch])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setTimeout(() => setRefreshing(false), 400)
    }
  }, [refetch])

  const handleExport = useCallback(async () => {
    await ipc.export.csv(filter)
  }, [filter])

  const handleReclassify = useCallback((rows: FlattenedPivotRow[]) => {
    reclassify.open(rows)
  }, [reclassify])

  const handleCreateRule = useCallback((rows: FlattenedPivotRow[]) => {
    setCreateRuleRows(rows)
  }, [])

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Review</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Navigate with arrow keys, Enter to select rows.
            <span className="text-gray-400 ml-1">⌘F filter | ⌘K reclassify | ⌘L create rule | ⌘S supplier info | Double-click to filter</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={cycleClassificationFilter}
            title={classificationFilter === 'all' ? 'Showing all rows — click for classified only' : classificationFilter === 'classified' ? 'Showing classified — click for unclassified only' : 'Showing unclassified — click to show all'}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors ${
              classificationFilter === 'all'
                ? 'border-gray-300 bg-white text-gray-500 hover:bg-gray-50'
                : classificationFilter === 'classified'
                  ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                  : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
            }`}
          >
            <ListFilter size={12} />
            {classificationFilter === 'all' ? 'All' : classificationFilter === 'classified' ? 'Classified' : 'Unclassified'}
          </button>
          <button
            ref={refreshBtnRef}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh data"
            className="p-1.5 rounded-md border border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setConfirmGenerate(true)}
            disabled={generating}
            className="px-3 py-1 rounded-md border border-gray-300 text-[11px] font-medium text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generating ? 'Generating...' : 'Generate Rules'}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <HierarchicalPivotView
          pivotData={pivotData}
          availableColumns={availableColumns}
          rowDimensions={rowDimensions}
          valueDimension={valueDimension}
          aggregation={aggregation}
          onRowDimensionsChange={setRowDimensions}
          onValueDimensionChange={setValueDimension}
          onAggregationChange={setAggregation}
          filterState={filterState}
          onFilterStateChange={setFilterState}
          onClearAllFilters={clearAllFilters}
          onExport={handleExport}
          exportDisabled={!pivotData}
          totalCount={totalCount}
          spendDisplayMode={spendDisplayMode}
          onSpendDisplayModeChange={setSpendDisplayMode}
          onReclassify={handleReclassify}
          onCreateRule={handleCreateRule}
          onDrillDown={setDrillDownRow}
          modalOpen={reclassify.isOpen || showAdvancedFilter || !!createRuleRows}
          advancedFilterCount={advancedConditions.length}
          onOpenAdvancedFilter={() => setShowAdvancedFilter(true)}
          advancedConditions={advancedConditions}
          advancedGrouped={advancedGrouped}
          onSetAdvancedGrouped={setAdvancedGrouped}
          flaggedForReviewOnly={flaggedForReviewOnly}
          onFlaggedForReviewOnlyChange={setFlaggedForReviewOnly}
        />
      </div>

      {/* Drill-down panel */}
      {drillDownRow && (
        <DrillDownPanel
          row={drillDownRow}
          onClose={() => setDrillDownRow(null)}
        />
      )}

      <ReclassifyModal
        isOpen={reclassify.isOpen}
        onClose={reclassify.close}
        targetRows={reclassify.targetRows}
        filteredNodes={reclassify.filteredNodes}
        allNodes={reclassify.taxonomyNodes}
        search={reclassify.search}
        onSearchChange={reclassify.setSearch}
        focusedIdx={reclassify.focusedIdx}
        onFocusedIdxChange={reclassify.setFocusedIdx}
        searchRef={reclassify.searchRef}
        onApply={reclassify.apply}
        onAddNode={reclassify.addNode}
        applying={reclassify.applying}
        error={reclassify.error}
      />

      <AdvancedFilterModal
        isOpen={showAdvancedFilter}
        onClose={() => setShowAdvancedFilter(false)}
        groupedFilter={advancedGrouped}
        onApply={setAdvancedGrouped}
        availableFields={advancedFilterFields}
        pillFilterState={filterState}
        onClearPillFilters={() => setFilterState({})}
      />

      <CreateRuleModal
        isOpen={!!createRuleRows}
        onClose={() => setCreateRuleRows(null)}
        selectedRows={createRuleRows ?? []}
        onCreated={refetch}
      />

      {/* Generate Rules confirmation modal */}
      {confirmGenerate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmGenerate(false)} />
          <div className="relative rounded-lg bg-white shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-gray-900">Generate Rules</h3>
            <p className="mt-2 text-xs text-gray-600">
              This will mark all current classifications as reviewed and generate override rules for all reviewed suppliers. Continue?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmGenerate(false)}
                className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateRules}
                className="px-3 py-1.5 rounded-md bg-blue-600 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
