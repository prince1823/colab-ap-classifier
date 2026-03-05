import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import HierarchicalPivotView from '../components/review/HierarchicalPivotView'
import { useServerPivotData } from '../hooks/useServerPivotData'
import { useIPC } from '../hooks/useIPC'
import { ipc } from '../lib/ipc'
import type { Aggregation } from '../types/pivot'
import type { PivotFilterState } from '../components/review/PivotFilterBar'
import type { TransactionFilter, FilterCondition } from '../../shared/types/transactions'
import { exportHierarchicalPivotExcel } from '../utils/exportPivotToExcel'

const DEFAULT_ROW_DIMENSIONS = ['classification_l1', 'classification_l2', 'supplier_name']

function filterStateToTransactionFilter(filterState: PivotFilterState): TransactionFilter | undefined {
  const conditions: FilterCondition[] = []
  for (const [field, values] of Object.entries(filterState)) {
    if (values.length > 0) {
      conditions.push({ field, operator: 'in_list', value: values })
    }
  }
  return conditions.length > 0 ? { conditions } : undefined
}

export default function PivotPage() {
  const navigate = useNavigate()

  const [rowDimensions, setRowDimensions] = useState<string[]>(DEFAULT_ROW_DIMENSIONS)
  const [valueDimension, setValueDimension] = useState('spend_amount')
  const [aggregation, setAggregation] = useState<Aggregation>('sum')
  const [filterState, setFilterState] = useState<PivotFilterState>({})

  const { data: columns } = useIPC(() => ipc.transactions.getColumns(), [])

  const filter = useMemo(() => filterStateToTransactionFilter(filterState), [filterState])

  const { pivotData, totalCount } = useServerPivotData(
    rowDimensions,
    valueDimension,
    aggregation,
    filter
  )

  const INTERNAL_COLS = new Set([
    'id', 'row_index', 'upload_id', 'taxonomy_node_id',
    'classification_status', 'human_reviewed', 'classification_reasoning',
    'original_supplier_name', 'project_supplier_id',
    'created_at', 'updated_at',
  ])

  const availableColumns = [
    'classification_l1', 'classification_l2', 'classification_l3',
    ...(columns ?? []).filter(c => !INTERNAL_COLS.has(c)),
  ]

  const handleExport = () => {
    if (!pivotData) return
    exportHierarchicalPivotExcel({ data: pivotData })
  }

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <div className="flex-shrink-0">
        <h2 className="text-lg font-semibold text-gray-900">Pivot View</h2>
        <p className="text-sm text-gray-500 mt-0.5">Explore spend by dimension. Double-click a row to filter.</p>
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
          onClearAllFilters={() => setFilterState({})}
          onExport={handleExport}
          exportDisabled={!pivotData}
          onOpenInReview={() => navigate('/workflow/review')}
          openInReviewDisabled={false}
          totalCount={totalCount}
        />
      </div>
    </div>
  )
}
