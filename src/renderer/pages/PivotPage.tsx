import { useState, useMemo, useCallback } from 'react'
import HierarchicalPivotView from '../components/review/HierarchicalPivotView'
import ReclassifyModal from '../components/review/ReclassifyModal'
import DrillDownPanel from '../components/review/DrillDownPanel'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import { useServerPivotData } from '../hooks/useServerPivotData'
import { useReclassification } from '../hooks/useReclassification'
import { useIPC } from '../hooks/useIPC'
import { ipc } from '../lib/ipc'
import type { Aggregation, SpendDisplayMode, FlattenedPivotRow } from '../types/pivot'
import type { PivotFilterState } from '../components/review/PivotFilterBar'
import type { TransactionFilter, FilterCondition, GroupedFilter } from '../../shared/types/transactions'
import type { FieldDefinition } from '../components/FilterConditionBuilder'
import { groupedToConditions, makeEmptyGroup } from '../components/FilterConditionBuilder'

const DEFAULT_ROW_DIMENSIONS: string[] = []

/**
 * Convert dimension pill filters into a TransactionFilter.
 */
function buildTransactionFilter(pillState: PivotFilterState): TransactionFilter | undefined {
  const conditions = Object.entries(pillState)
    .filter(([, values]) => values.length > 0)
    .map(([field, values]) => ({ field, operator: 'in_list' as const, value: values }))

  return conditions.length > 0 ? { conditions } : undefined
}

export default function PivotPage() {
  const [rowDimensions, setRowDimensions] = useState<string[]>(DEFAULT_ROW_DIMENSIONS)
  const [valueDimension, setValueDimension] = useState('spend_amount')
  const [aggregation, setAggregation] = useState<Aggregation>('sum')
  const [filterState, setFilterState] = useState<PivotFilterState>({})
  const [spendDisplayMode, setSpendDisplayMode] = useState<SpendDisplayMode>('absolute')
  const [drillDownRow, setDrillDownRow] = useState<FlattenedPivotRow | null>(null)
  const [advancedGrouped, setAdvancedGrouped] = useState<GroupedFilter | null>(null)
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)

  // Flat conditions derived from grouped for backward compat (chips, badge count, etc.)
  const advancedConditions = useMemo(() =>
    advancedGrouped ? groupedToConditions(advancedGrouped).filter(c => c.field) : [],
    [advancedGrouped]
  )

  const { data: columns } = useIPC(() => ipc.transactions.getColumns(), [])

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

  const INTERNAL_COLS = new Set([
    'id', 'row_index', 'upload_id', 'taxonomy_node_id',
    'classification_status', 'human_reviewed',
    'original_supplier_name', 'project_supplier_id',
    'created_at', 'updated_at',
  ])

  const availableColumns = [
    'classification_l1', 'classification_l2', 'classification_l3',
    ...(columns ?? []).filter(c => !INTERNAL_COLS.has(c)),
  ]

  const COLUMN_LABELS: Record<string, string> = {
    classification_l1: 'Classification L1',
    classification_l2: 'Classification L2',
    classification_l3: 'Classification L3',
    supplier_name: 'Supplier',
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

  const advancedFilterFields: FieldDefinition[] = useMemo(() =>
    availableColumns.map(col => ({
      name: col,
      label: COLUMN_LABELS[col] || col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      type: ['spend_amount', 'amount', 'invoice_amount'].includes(col) ? 'number' as const : 'string' as const,
    })),
    [availableColumns]
  )

  const handleExport = useCallback(async () => {
    await ipc.export.csv()
  }, [])

  const handleReclassify = useCallback((rows: FlattenedPivotRow[]) => {
    reclassify.open(rows)
  }, [reclassify])

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Review</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Navigate with arrow keys, Enter to select rows.
            <span className="text-gray-400 ml-1">⌘F filter | ⌘K reclassify | Double-click to filter</span>
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
          onClearAllFilters={() => { setFilterState({}); setAdvancedGrouped(null) }}
          onExport={handleExport}
          exportDisabled={!pivotData}
          totalCount={totalCount}
          spendDisplayMode={spendDisplayMode}
          onSpendDisplayModeChange={setSpendDisplayMode}
          onReclassify={handleReclassify}
          onDrillDown={setDrillDownRow}
          modalOpen={reclassify.isOpen || showAdvancedFilter}
          advancedFilterCount={advancedConditions.length}
          onOpenAdvancedFilter={() => setShowAdvancedFilter(true)}
          advancedConditions={advancedConditions}
          onRemoveAdvancedCondition={(idx) => {
            // Remove condition by flat index from the grouped structure
            if (!advancedGrouped) return
            let flatIdx = 0
            const newGroups = advancedGrouped.groups.map(g => ({
              ...g,
              conditions: g.conditions.filter(c => {
                if (!c.field) return true
                const keep = flatIdx !== idx
                flatIdx++
                return keep
              }),
            })).filter(g => g.conditions.some(c => c.field))
            setAdvancedGrouped(newGroups.length > 0
              ? { ...advancedGrouped, groups: newGroups }
              : null
            )
          }}
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
        search={reclassify.search}
        onSearchChange={reclassify.setSearch}
        focusedIdx={reclassify.focusedIdx}
        onFocusedIdxChange={reclassify.setFocusedIdx}
        searchRef={reclassify.searchRef}
        onApply={reclassify.apply}
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
    </div>
  )
}
