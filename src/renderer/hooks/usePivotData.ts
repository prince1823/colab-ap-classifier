import { useMemo } from 'react'

export interface PivotData {
  matrix: Map<string, Map<string, number>>
  sortedCols: string[]
  sortedRows: string[]
  colTotals: Map<string, number>
  rowTotals: Map<string, number>
  grandTotal: number
}

export function usePivotData(
  transactions: Record<string, unknown>[],
  rowDimension: string,
  colDimension: string
): PivotData | null {
  return useMemo(() => {
    if (!transactions.length) return null

    const matrix = new Map<string, Map<string, number>>()
    const colTotals = new Map<string, number>()
    const rowTotals = new Map<string, number>()
    let grandTotal = 0

    for (const t of transactions) {
      const rawRow = t[rowDimension]
      const rawCol = t[colDimension]
      const amount = Number(t.spend_amount || t.amount || t.invoice_amount || 0)

      // Skip rows with no amount or blank/null/undefined dimension values
      if (amount === 0 || isNaN(amount)) continue
      const rowStr = rawRow == null ? '' : String(rawRow).trim()
      const colStr = rawCol == null ? '' : String(rawCol).trim()
      if (!rowStr || rowStr === 'null' || rowStr === 'undefined' || rowStr === 'N/A') continue
      if (!colStr || colStr === 'null' || colStr === 'undefined' || colStr === 'N/A') continue

      const rowKey = rowStr
      const colKey = colStr

      if (!matrix.has(rowKey)) matrix.set(rowKey, new Map())
      const row = matrix.get(rowKey)!
      row.set(colKey, (row.get(colKey) || 0) + amount)

      colTotals.set(colKey, (colTotals.get(colKey) || 0) + amount)
      rowTotals.set(rowKey, (rowTotals.get(rowKey) || 0) + amount)
      grandTotal += amount
    }

    // Sort columns by total spend, take top 15 (only non-zero)
    const sortedCols = [...colTotals.entries()]
      .filter(([, v]) => v !== 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([k]) => k)

    // Sort rows by total spend (only non-zero)
    const sortedRows = [...rowTotals.entries()]
      .filter(([, v]) => v !== 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)

    return { matrix, sortedCols, sortedRows, colTotals, rowTotals, grandTotal }
  }, [transactions, rowDimension, colDimension])
}
