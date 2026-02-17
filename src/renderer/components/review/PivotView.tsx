import { usePivotData } from '../../hooks/usePivotData'

interface PivotViewProps {
  transactions: Record<string, unknown>[]
  availableColumns: string[]
  rowDimension: string
  colDimension: string
  onRowDimensionChange: (dim: string) => void
  onColDimensionChange: (dim: string) => void
}

export default function PivotView({
  transactions,
  availableColumns,
  rowDimension,
  colDimension,
  onRowDimensionChange,
  onColDimensionChange,
}: PivotViewProps) {
  const pivotData = usePivotData(transactions, rowDimension, colDimension)

  const fmt = (n: number) =>
    n === 0
      ? '–'
      : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  if (!transactions.length) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        No transaction data available for pivot analysis.
      </div>
    )
  }

  if (!pivotData) return null

  const { matrix, sortedCols, sortedRows, colTotals, rowTotals, grandTotal } = pivotData

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Dimension selectors */}
      <div className="flex items-center gap-4 flex-shrink-0">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          Rows:
          <select
            value={rowDimension}
            onChange={(e) => onRowDimensionChange(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm bg-white shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          >
            {availableColumns.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          Columns:
          <select
            value={colDimension}
            onChange={(e) => onColDimensionChange(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm bg-white shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          >
            {availableColumns.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-gray-500 ml-auto">
          {sortedRows.length} rows × {sortedCols.length} columns
        </span>
      </div>

      {/* Pivot table */}
      <div className="overflow-auto flex-1 border border-gray-200 rounded-lg">
        <table className="min-w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr>
              <th className="sticky left-0 z-20 bg-gray-100 px-3 py-2 text-left font-semibold text-gray-700 border-b border-r border-gray-200 min-w-[200px]">
                {rowDimension}
              </th>
              {sortedCols.map((col) => (
                <th
                  key={col}
                  className="px-3 py-2 text-right font-semibold text-gray-700 border-b border-gray-200 min-w-[120px] truncate max-w-[160px]"
                  title={col}
                >
                  {col}
                </th>
              ))}
              <th className="sticky right-0 z-20 px-3 py-2 text-right font-bold text-gray-900 border-b border-l border-gray-300 bg-gray-100 min-w-[120px]">
                Row Total
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((rowKey, i) => {
              const row = matrix.get(rowKey)!
              return (
                <tr
                  key={rowKey}
                  className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}
                >
                  <td
                    className="sticky left-0 z-[5] px-3 py-1.5 font-medium text-gray-800 border-r border-gray-200 truncate max-w-[200px] bg-inherit"
                    title={rowKey}
                  >
                    {rowKey}
                  </td>
                  {sortedCols.map((colKey) => {
                    const val = row.get(colKey) || 0
                    return (
                      <td
                        key={colKey}
                        className="px-3 py-1.5 text-right text-gray-600 tabular-nums"
                      >
                        {fmt(val)}
                      </td>
                    )
                  })}
                  <td className="sticky right-0 z-[5] px-3 py-1.5 text-right font-semibold text-gray-900 border-l border-gray-300 tabular-nums"
                      style={{ background: i % 2 === 0 ? '#eff6ff' : '#eef2ff' }}>
                    {fmt(rowTotals.get(rowKey) || 0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="sticky bottom-0 bg-gray-100 border-t-2 border-gray-300">
            <tr>
              <td className="sticky left-0 z-20 bg-gray-100 px-3 py-2 font-bold text-gray-900 border-r border-gray-200">
                Column Total
              </td>
              {sortedCols.map((colKey) => (
                <td
                  key={colKey}
                  className="px-3 py-2 text-right font-semibold text-gray-900 tabular-nums"
                >
                  {fmt(colTotals.get(colKey) || 0)}
                </td>
              ))}
              <td className="sticky right-0 z-20 px-3 py-2 text-right font-bold text-blue-700 border-l border-gray-300 bg-gray-100 tabular-nums">
                {fmt(grandTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
