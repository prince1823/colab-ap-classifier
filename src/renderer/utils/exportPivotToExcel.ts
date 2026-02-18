import * as XLSX from 'xlsx'
import type { PivotData } from '../hooks/usePivotData'

interface PivotExportOptions {
  pivotData: PivotData
  rowDimension: string
  colDimension: string
}

interface PivotTemplateOptions extends PivotExportOptions {
  filterSummary: string
  totalTransactions: number
  filteredTransactions: number
}

function buildPivotAoa(opts: PivotExportOptions): (string | number)[][] {
  const { pivotData, rowDimension } = opts
  const { matrix, sortedCols, sortedRows, colTotals, rowTotals, grandTotal } = pivotData

  const aoa: (string | number)[][] = []

  // Header row
  aoa.push([rowDimension, ...sortedCols, 'Row Total'])

  // Data rows
  for (const rowKey of sortedRows) {
    const rowMap = matrix.get(rowKey) || new Map<string, number>()
    const cells = sortedCols.map((col) => rowMap.get(col) || 0)
    aoa.push([rowKey, ...cells, rowTotals.get(rowKey) || 0])
  }

  // Total row
  const totalCells = sortedCols.map((col) => colTotals.get(col) || 0)
  aoa.push(['Column Total', ...totalCells, grandTotal])

  return aoa
}

function buildPivotSheet(aoa: (string | number)[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Set column widths
  const colWidths = aoa[0].map((header, i) => {
    // Check max content width in this column
    let maxLen = String(header).length
    for (const row of aoa) {
      const cellLen = String(row[i] ?? '').length
      if (cellLen > maxLen) maxLen = cellLen
    }
    return { wch: Math.max(Math.min(maxLen + 2, 30), 12) }
  })
  ws['!cols'] = colWidths

  return ws
}

function triggerDownload(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function formatDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Export the current pivot matrix as a basic Excel file.
 */
export function exportPivotExcel(opts: PivotExportOptions): void {
  const aoa = buildPivotAoa(opts)
  const ws = buildPivotSheet(aoa)

  // Apply currency number format to all spend cells (skip header row and first column)
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  for (let r = 1; r <= range.e.r; r++) {
    for (let c = 1; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      if (ws[addr] && typeof ws[addr].v === 'number') {
        ws[addr].z = '$#,##0'
      }
    }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Pivot Data')

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  triggerDownload(buffer, `PivotExport_${formatDate()}.xlsx`)
}

/**
 * Export a formatted "Standard Template" workbook with a Summary sheet + Pivot Data sheet.
 */
export function exportPivotTemplate(opts: PivotTemplateOptions): void {
  const { pivotData, rowDimension, colDimension, filterSummary, totalTransactions, filteredTransactions } = opts

  const wb = XLSX.utils.book_new()

  // --- Summary sheet ---
  const fmtCurrency = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  const summaryAoa: (string | number)[][] = [
    ['Spend Analysis — Pivot Report'],
    [],
    ['Generated', formatDate()],
    ['Row Dimension', rowDimension],
    ['Column Dimension', colDimension],
    [],
    ['Total Transactions', totalTransactions],
    ['Filtered Transactions', filteredTransactions],
    ['Active Filters', filterSummary || 'None'],
    [],
    ['Grand Total Spend', fmtCurrency(pivotData.grandTotal)],
    ['Unique Row Values', pivotData.sortedRows.length],
    ['Unique Column Values', pivotData.sortedCols.length],
  ]

  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa)
  summaryWs['!cols'] = [{ wch: 24 }, { wch: 40 }]
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary')

  // --- Pivot Data sheet ---
  const aoa = buildPivotAoa(opts)
  const pivotWs = buildPivotSheet(aoa)

  // Apply currency format
  const range = XLSX.utils.decode_range(pivotWs['!ref'] || 'A1')
  for (let r = 1; r <= range.e.r; r++) {
    for (let c = 1; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      if (pivotWs[addr] && typeof pivotWs[addr].v === 'number') {
        pivotWs[addr].z = '$#,##0'
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, pivotWs, 'Pivot Data')

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  triggerDownload(buffer, `PivotReport_${formatDate()}.xlsx`)
}
