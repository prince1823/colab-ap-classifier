// @ts-expect-error papaparse has no type declarations
import Papa from 'papaparse'
import type { ProjectSupplierView, SupplierParent, CsvApplyRow } from '../../shared/types/suppliers'

export interface AliasData {
  rawName: string
  spend: number
  txnCount: number
}

// ── Supplier data → CSV string (one row per alias) ──────────────────────

export function suppliersToCSV(
  suppliers: ProjectSupplierView[],
  _parents: SupplierParent[],
  aliasCache: Map<string, AliasData[]>,
): string {
  const rows: Record<string, string | number>[] = []

  for (const s of suppliers) {
    const aliasDataList = aliasCache.get(s.id) ?? []
    if (aliasDataList.length === 0) {
      // Supplier with no aliases — still emit one row
      rows.push({
        parent_name: s.parentName ?? '',
        supplier_name: s.supplierName,
        alias: '',
        total_spend: s.totalSpend,
        transaction_count: s.transactionCount,
      })
    } else {
      for (const ad of aliasDataList) {
        rows.push({
          parent_name: s.parentName ?? '',
          supplier_name: s.supplierName,
          alias: ad.rawName,
          total_spend: ad.spend,
          transaction_count: ad.txnCount,
        })
      }
    }
  }

  return Papa.unparse(rows, {
    columns: ['parent_name', 'supplier_name', 'alias', 'total_spend', 'transaction_count'],
  })
}

// ── CSV string → CsvApplyRow[] (groups rows by supplier_name) ───────────

export function parseNormalizeCsv(csvString: string): CsvApplyRow[] {
  const parsed = Papa.parse(csvString, { header: true, skipEmptyLines: true })
  const rawRows = parsed.data as Record<string, string>[]
  const cols = (parsed.meta?.fields ?? []).map((f: string) => f.toLowerCase())

  // Detect format: "alias" (one per row) vs "aliases" (pipe-separated)
  const isExpandedFormat = cols.includes('alias') && !cols.includes('aliases')

  if (!isExpandedFormat) {
    // Legacy pipe-separated format
    return rawRows
      .filter(row => row.supplier_name?.trim())
      .map(row => ({
        parentName: row.parent_name?.trim() || null,
        supplierName: row.supplier_name.trim(),
        aliases: [...new Set((row.aliases || '').split('|').map((a: string) => a.trim()).filter(Boolean))],
      }))
  }

  // Expanded format: group rows by supplier_name
  const supplierMap = new Map<string, CsvApplyRow>() // key = lowercase supplier_name

  for (const row of rawRows) {
    const supplierName = row.supplier_name?.trim()
    if (!supplierName) continue

    const key = supplierName.toLowerCase()
    const alias = row.alias?.trim()

    if (!supplierMap.has(key)) {
      supplierMap.set(key, {
        parentName: row.parent_name?.trim() || null,
        supplierName,
        aliases: [],
      })
    }

    const entry = supplierMap.get(key)!
    if (alias && !entry.aliases.includes(alias)) {
      entry.aliases.push(alias)
    }
    // Update parent if set on any row for this supplier
    if (row.parent_name?.trim() && !entry.parentName) {
      entry.parentName = row.parent_name.trim()
    }
  }

  return [...supplierMap.values()]
}

export function csvHasApplyColumns(csvString: string): boolean {
  const parsed = Papa.parse(csvString, { header: true, preview: 1 })
  const cols = (parsed.meta?.fields ?? []).map((f: string) => f.toLowerCase())
  return cols.includes('supplier_name') && (cols.includes('aliases') || cols.includes('alias'))
}

// ── CSV string → full in-memory data set for CSV editing mode ──────────

export interface CsvModeData {
  suppliers: ProjectSupplierView[]
  parents: SupplierParent[]
  aliasCache: Map<string, AliasData[]>
}

let csvIdCounter = 0
function csvId(): string { return `csv-${++csvIdCounter}` }

export function parseCsvToNormalizeData(csvString: string): CsvModeData {
  // First parse into CsvApplyRows (handles both formats)
  const applyRows = parseNormalizeCsv(csvString)

  // Also extract spend/txn data from raw CSV
  const parsed = Papa.parse(csvString, { header: true, skipEmptyLines: true })
  const rawRows = parsed.data as Record<string, string>[]
  const spendMap = new Map<string, { spend: number; txns: number }>()
  for (const row of rawRows) {
    const name = row.supplier_name?.trim()?.toLowerCase()
    if (name && !spendMap.has(name)) {
      spendMap.set(name, {
        spend: parseFloat(row.total_spend || '0') || 0,
        txns: parseInt(row.transaction_count || '0', 10) || 0,
      })
    }
  }

  const parents: SupplierParent[] = []
  const parentMap = new Map<string, string>()
  const suppliers: ProjectSupplierView[] = []
  const aliasCache = new Map<string, AliasData[]>()

  for (const row of applyRows) {
    let parentId: string | null = null

    if (row.parentName) {
      const key = row.parentName.toLowerCase()
      if (!parentMap.has(key)) {
        const id = csvId()
        parentMap.set(key, id)
        parents.push({ id, name: row.parentName, createdAt: new Date().toISOString() })
      }
      parentId = parentMap.get(key)!
    }

    const info = spendMap.get(row.supplierName.toLowerCase())
    const supplierId = csvId()

    suppliers.push({
      id: supplierId,
      supplierName: row.supplierName,
      confirmationStatus: 'pending',
      isTailSpend: false,
      parentSupplierId: parentId,
      parentName: row.parentName,
      supplierInfo: null,
      mappedTaxonomyPaths: null,
      universeMatch: false,
      isResearched: false,
      createdAt: new Date().toISOString(),
      transactionCount: info?.txns ?? 0,
      totalSpend: info?.spend ?? 0,
      aliases: row.aliases,
    })

    aliasCache.set(supplierId, row.aliases.map(a => ({ rawName: a, spend: 0, txnCount: 0 })))
  }

  return { suppliers, parents, aliasCache }
}
