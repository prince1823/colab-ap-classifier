import { useMemo, useCallback, useEffect, useState } from 'react'
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
    const allConditions = [...pillConditions, ...advancedConditions]
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
  }, [filterState, advancedConditions, advancedGrouped])

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
    </div>
  )
}
