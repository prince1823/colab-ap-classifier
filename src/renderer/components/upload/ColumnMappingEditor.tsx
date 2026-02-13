import { useState, useEffect } from 'react'
import type { CanonicalColumnMapping, CanonicalizationResult } from '../../../shared/types/canonicalization'

interface Props {
  suggestion: CanonicalizationResult
  csvColumns: string[]
  onMappingChange: (mapping: CanonicalColumnMapping) => void
  groupingColumns: string[]
  onGroupingChange: (columns: string[]) => void
}

const UNMAPPED = '__unmapped__'

// Common aliases: canonical name → possible CSV column names (lowercase)
const ALIASES: Record<string, string[]> = {
  spend_amount: ['amount', 'invoice_amount', 'total_amount', 'net_amount', 'gross_amount', 'value', 'spend', 'total'],
  supplier_name: ['supplier', 'vendor', 'vendor_name', 'payee', 'supplier name'],
  line_description: ['line_item_description', 'line item description', 'description', 'item_description', 'line_desc'],
  gl_description: ['gl_account_name', 'gl account name', 'gl_account', 'account_name', 'account name', 'gl account'],
  gl_code: ['gl_account_code', 'gl account code', 'account_code', 'gl_number', 'account_number', 'gl code'],
  invoice_date: ['invoice date', 'inv_date', 'date', 'doc_date', 'document_date'],
  creation_date: ['creation date', 'created_date', 'created_at', 'entry_date'],
  department: ['dept', 'department_name', 'dept_name', 'business_unit'],
  company: ['company_name', 'entity', 'legal_entity', 'company code'],
  cost_center: ['cost_center_name', 'cost center', 'cost center name', 'cc'],
  po_number: ['purchase_order', 'po', 'po_num', 'po number', 'purchase order'],
  supplier_address: ['vendor_address', 'supplier address', 'address'],
  currency: ['currency_code', 'curr', 'ccy'],
  memo: ['notes', 'comment', 'remarks', 'line_memo'],
}

function autoMap(llmMappings: CanonicalColumnMapping, unmappedCanonical: string[], csvColumns: string[]): CanonicalColumnMapping {
  const result = { ...llmMappings }
  const usedCsvCols = new Set(Object.values(result).map((v) => v.toLowerCase()))

  for (const canonical of unmappedCanonical) {
    if (result[canonical]) continue
    const aliases = ALIASES[canonical] || []
    const candidates = [canonical, ...aliases]

    for (const candidate of candidates) {
      const match = csvColumns.find(
        (csv) => csv.toLowerCase() === candidate.toLowerCase() && !usedCsvCols.has(csv.toLowerCase())
      )
      if (match) {
        result[canonical] = match
        usedCsvCols.add(match.toLowerCase())
        break
      }
    }
  }

  return result
}

export default function ColumnMappingEditor({
  suggestion,
  csvColumns,
  onMappingChange,
  groupingColumns,
  onGroupingChange,
}: Props) {
  const [mapping, setMapping] = useState<CanonicalColumnMapping>(() =>
    autoMap(suggestion.mappings, suggestion.unmappedCanonicalColumns, csvColumns)
  )

  useEffect(() => {
    const enhanced = autoMap(suggestion.mappings, suggestion.unmappedCanonicalColumns, csvColumns)
    setMapping(enhanced)
    onMappingChange(enhanced)
  }, [suggestion])

  const handleChange = (canonicalName: string, csvColumn: string) => {
    const updated = { ...mapping }
    if (csvColumn === UNMAPPED) {
      delete updated[canonicalName]
    } else {
      updated[canonicalName] = csvColumn
    }
    setMapping(updated)
    onMappingChange(updated)
  }

  const toggleGroupingColumn = (col: string) => {
    if (groupingColumns.includes(col)) {
      onGroupingChange(groupingColumns.filter((c) => c !== col))
    } else {
      onGroupingChange([...groupingColumns, col])
    }
  }

  const canonicalNames = Object.keys(suggestion.mappings)
  const allCanonical = [
    ...canonicalNames,
    ...suggestion.unmappedCanonicalColumns.filter((c) => !canonicalNames.includes(c)),
  ]

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-700">Column Mappings</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              suggestion.confidence === 'high'
                ? 'bg-green-100 text-green-700'
                : suggestion.confidence === 'medium'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-red-100 text-red-700'
            }`}
          >
            {suggestion.confidence} confidence
          </span>
        </div>
        {suggestion.reasoning && (
          <p className="mb-3 text-xs text-gray-500">{suggestion.reasoning}</p>
        )}
        <div className="space-y-2">
          {allCanonical.map((canonicalName) => (
            <div key={canonicalName} className="flex items-center gap-3">
              <span className="w-48 text-sm font-medium text-gray-700">{canonicalName}</span>
              <span className="text-gray-400">&rarr;</span>
              <select
                value={mapping[canonicalName] ?? UNMAPPED}
                onChange={(e) => handleChange(canonicalName, e.target.value)}
                className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value={UNMAPPED}>-- Not mapped --</option>
                {csvColumns.map((col) => (
                  <option key={col} value={col}>
                    {col}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {suggestion.unmappedClientColumns.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-amber-700">Unmapped CSV columns</h4>
          <div className="flex flex-wrap gap-1">
            {suggestion.unmappedClientColumns.map((col) => (
              <span key={col} className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-600">
                {col}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700">Invoice Grouping Columns</h3>
        <p className="mb-2 text-xs text-gray-500">
          Select columns that together identify a unique invoice for grouping.
        </p>
        <div className="flex flex-wrap gap-2">
          {csvColumns.map((col) => (
            <button
              key={col}
              onClick={() => toggleGroupingColumn(col)}
              className={`rounded-md border px-3 py-1 text-xs transition-colors ${
                groupingColumns.includes(col)
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {col}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
