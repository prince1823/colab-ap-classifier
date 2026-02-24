import * as XLSX from 'xlsx'
import type { HierarchicalPivotData, PivotTreeNode } from '../hooks/useHierarchicalPivotData'

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
 * Export hierarchical pivot data as Excel with indented rows and outline levels.
 */
export function exportHierarchicalPivotExcel(opts: {
  data: HierarchicalPivotData
}): void {
  const { data } = opts
  const { root, grandTotal, rowDimensions } = data

  const aoa: (string | number)[][] = []
  const rowOutlineLevels: number[] = []

  // Header row — single label column + Total
  const headerLabel = rowDimensions
    .map(d => d.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    .join(' > ')
  aoa.push([headerLabel, 'Total'])
  rowOutlineLevels.push(0)

  // DFS to flatten all nodes (fully expanded) — indented single column
  const walkForExport = (node: PivotTreeNode) => {
    const indent = '  '.repeat(node.depth)
    aoa.push([indent + node.label, node.total])
    rowOutlineLevels.push(node.depth + 1) // Excel outline level (1-based)

    for (const child of node.children) {
      walkForExport(child)
    }
  }

  for (const child of root.children) {
    walkForExport(child)
  }

  // Grand total row
  aoa.push(['Grand Total', grandTotal])
  rowOutlineLevels.push(0)

  // Build worksheet
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Set column widths
  const colWidths = aoa[0].map((header, i) => {
    let maxLen = String(header).length
    for (const row of aoa) {
      const cellLen = String(row[i] ?? '').length
      if (cellLen > maxLen) maxLen = cellLen
    }
    return { wch: Math.max(Math.min(maxLen + 2, 40), 12) }
  })
  ws['!cols'] = colWidths

  // Set row outline levels for Excel grouping
  ws['!rows'] = rowOutlineLevels.map(level => ({
    level: Math.min(level, 7), // Excel max outline level is 7
  }))

  // Apply currency format to Total column
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  for (let r = 1; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 1 })
    if (ws[addr] && typeof ws[addr].v === 'number') {
      ws[addr].z = '$#,##0'
    }
    // Bold parent rows (outline level <= 2)
    if (rowOutlineLevels[r] <= 2) {
      const firstCellAddr = XLSX.utils.encode_cell({ r, c: 0 })
      if (ws[firstCellAddr]) {
        ws[firstCellAddr].s = { font: { bold: true } }
      }
    }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Pivot Data')

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  triggerDownload(buffer, `PivotExport_Hierarchical_${formatDate()}.xlsx`)
}
