// @ts-expect-error papaparse has no type declarations
import Papa from 'papaparse'
import type { ProjectSupplierView, SupplierParent } from '../../shared/types/suppliers'

export interface AliasData {
  rawName: string
  spend: number
  txnCount: number
}

export interface ParsedCsvResult {
  suppliers: ProjectSupplierView[]
  parents: SupplierParent[]
  aliasCache: Map<string, AliasData[]>
}

// ── Header mapping ────────────────────────────────────────────────────

const HEADER_MAP: Record<string, string> = {
  parent_name: 'parent_name',
  parent: 'parent_name',
  parentname: 'parent_name',
  parent_company: 'parent_name',

  supplier_name: 'supplier_name',
  supplier: 'supplier_name',
  suppliername: 'supplier_name',
  normalized_name: 'supplier_name',
  normalizedname: 'supplier_name',
  name: 'supplier_name',

  aliases: 'aliases',
  alias: 'aliases',

  total_spend: 'total_spend',
  totalspend: 'total_spend',
  spend: 'total_spend',

  transaction_count: 'transaction_count',
  transactioncount: 'transaction_count',
  txns: 'transaction_count',
  txn_count: 'transaction_count',
  transactions: 'transaction_count',
}

function mapHeader(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return HEADER_MAP[key] ?? null
}

// ── Parse CSV → supplier data ─────────────────────────────────────────

export function parseCsvToSuppliers(csvText: string): ParsedCsvResult {
  const { data, errors } = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  })

  if (errors.length > 0 && data.length === 0) {
    throw new Error(`CSV parse error: ${errors[0].message}`)
  }

  if (data.length === 0) {
    throw new Error('CSV is empty — no data rows found')
  }

  // Map headers
  const rawHeaders = Object.keys(data[0])
  const headerMapping: Record<string, string> = {}
  for (const h of rawHeaders) {
    const mapped = mapHeader(h)
    if (mapped) headerMapping[h] = mapped
  }

  if (!headerMapping || !Object.values(headerMapping).includes('supplier_name')) {
    throw new Error('CSV must have a "supplier_name" (or "supplier", "normalized_name") column')
  }

  const getField = (row: Record<string, string>, canonical: string): string => {
    for (const [raw, mapped] of Object.entries(headerMapping)) {
      if (mapped === canonical) return (row[raw] ?? '').trim()
    }
    return ''
  }

  // Collect unique parents
  const parentMap = new Map<string, SupplierParent>()
  const suppliers: ProjectSupplierView[] = []
  const aliasCache = new Map<string, AliasData[]>()

  for (const row of data) {
    const supplierName = getField(row, 'supplier_name')
    if (!supplierName) continue

    const parentName = getField(row, 'parent_name') || null
    const aliasesStr = getField(row, 'aliases')
    const spend = parseFloat(getField(row, 'total_spend')) || 0
    const txnCount = parseInt(getField(row, 'transaction_count'), 10) || 0

    // Parent
    let parentSupplierId: string | null = null
    if (parentName) {
      if (!parentMap.has(parentName)) {
        parentMap.set(parentName, {
          id: crypto.randomUUID(),
          name: parentName,
          createdAt: new Date().toISOString(),
        })
      }
      parentSupplierId = parentMap.get(parentName)!.id
    }

    const supplierId = crypto.randomUUID()

    // Aliases
    const aliases = aliasesStr
      ? aliasesStr.split('|').map(a => a.trim()).filter(Boolean)
      : []

    aliasCache.set(
      supplierId,
      aliases.map(rawName => ({ rawName, spend: 0, txnCount: 0 })),
    )

    suppliers.push({
      id: supplierId,
      supplierName,
      confirmationStatus: 'pending',
      isTailSpend: false,
      parentSupplierId,
      parentName,
      supplierInfo: null,
      mappedTaxonomyPaths: null,
      universeMatch: false,
      isResearched: false,
      createdAt: new Date().toISOString(),
      transactionCount: txnCount,
      totalSpend: spend,
      aliases,
    })
  }

  return {
    suppliers,
    parents: Array.from(parentMap.values()),
    aliasCache,
  }
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
