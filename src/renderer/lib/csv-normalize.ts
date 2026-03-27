// @ts-expect-error papaparse has no type declarations
import Papa from 'papaparse'
import type { ProjectSupplierView, SupplierParent } from '../../shared/types/suppliers'

export interface AliasData {
  rawName: string
  spend: number
  txnCount: number
}

// ── Supplier data → CSV string ────────────────────────────────────────

export function suppliersToCSV(
  suppliers: ProjectSupplierView[],
  _parents: SupplierParent[],
  aliasCache: Map<string, AliasData[]>,
): string {
  const rows = suppliers.map(s => ({
    parent_name: s.parentName ?? '',
    supplier_name: s.supplierName,
    aliases: (aliasCache.get(s.id) ?? []).map(a => a.rawName).join('|'),
    total_spend: s.totalSpend,
    transaction_count: s.transactionCount,
  }))

  return Papa.unparse(rows, {
    columns: ['parent_name', 'supplier_name', 'aliases', 'total_spend', 'transaction_count'],
  })
}
