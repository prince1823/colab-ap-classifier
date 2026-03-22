import { useState, useEffect, useMemo } from 'react'
import { ipc } from '../../lib/ipc'
import type { CSVPreview, MappingRow } from '../../../shared/types/column-mapping'

const EXISTING_ROWS_LIMIT = 5
const NEW_ROWS_LIMIT = 5

interface Props {
  preview: CSVPreview
  mappingRows: MappingRow[]
  onConfirm: () => void
  onBack: () => void
  importing: boolean
  isFirstUpload: boolean
}

interface FlatRow {
  [canonical: string]: string
}

export default function DataMergePreviewStep({
  preview,
  mappingRows,
  onConfirm,
  onBack,
  importing,
  isFirstUpload,
}: Props) {
  const [existingRows, setExistingRows] = useState<FlatRow[]>([])
  const [existingTotalCount, setExistingTotalCount] = useState(0)
  const [loading, setLoading] = useState(!isFirstUpload)

  // Column headers = canonical names from the current mapping
  const canonicalColumns = useMemo(
    () => mappingRows.map((m) => m.canonical),
    [mappingRows]
  )

  // Build new rows from CSV preview using the mapping (canonical → csvColumn)
  const newRows = useMemo(() => {
    return preview.sampleRows.slice(0, NEW_ROWS_LIMIT).map((csvRow) => {
      const flat: FlatRow = {}
      for (const m of mappingRows) {
        flat[m.canonical] = String(csvRow[m.csvColumn] ?? '\u2014')
      }
      return flat
    })
  }, [preview.sampleRows, mappingRows])

  // Fetch last N existing rows from DB
  useEffect(() => {
    if (isFirstUpload) {
      setLoading(false)
      return
    }
    setLoading(true)
    ipc.transactions
      .query()
      .then((result) => {
        setExistingTotalCount(result.totalCount)
        // Take the last N rows and flatten canonicalFields
        const tail = result.rows.slice(-EXISTING_ROWS_LIMIT)
        const flattened: FlatRow[] = tail.map((tx) => {
          const flat: FlatRow = {}
          for (const col of canonicalColumns) {
            // canonicalFields holds dynamic columns; also check top-level fields
            const val = (tx.canonicalFields as Record<string, unknown>)?.[col]
            flat[col] = val !== undefined && val !== null ? String(val) : '\u2014'
          }
          return flat
        })
        setExistingRows(flattened)
      })
      .catch(() => {
        // If query fails (e.g. no transactions table yet), treat as first upload
        setExistingRows([])
        setExistingTotalCount(0)
      })
      .finally(() => setLoading(false))
  }, [isFirstUpload, canonicalColumns])

  const totalAfterImport = existingTotalCount + preview.totalRows

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex-shrink-0">
        <h3 className="text-sm font-medium text-gray-700">Merge Preview</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Review how the new data will look alongside existing data. Go back to adjust mappings if needed.
        </p>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading existing data...
          </div>
        </div>
      ) : (
        <>
          {/* First upload notice */}
          {isFirstUpload && (
            <div className="flex-shrink-0 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700">
              This will be the first dataset imported into this project.
            </div>
          )}

          {/* Merge table */}
          <div className="flex-1 min-h-0 overflow-auto rounded-md border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="w-16 px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    Source
                  </th>
                  {canonicalColumns.map((col) => (
                    <th
                      key={col}
                      className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {/* Existing rows (white bg) */}
                {existingRows.map((row, i) => (
                  <tr key={`existing-${i}`} className="bg-white">
                    {i === 0 ? (
                      <td
                        rowSpan={existingRows.length}
                        className="px-3 py-2 text-[10px] font-medium text-gray-400 uppercase tracking-wider align-top border-r border-gray-100"
                      >
                        Existing
                      </td>
                    ) : null}
                    {canonicalColumns.map((col) => (
                      <td key={col} className="px-3 py-2 text-xs text-gray-600 truncate max-w-[150px]" title={row[col]}>
                        {row[col]}
                      </td>
                    ))}
                  </tr>
                ))}

                {/* Divider row */}
                {existingRows.length > 0 && newRows.length > 0 && (
                  <tr>
                    <td
                      colSpan={canonicalColumns.length + 1}
                      className="px-3 py-1.5 bg-gray-100 text-center"
                    >
                      <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                        &#x2500;&#x2500;&#x2500; New data below &#x2500;&#x2500;&#x2500;
                      </span>
                    </td>
                  </tr>
                )}

                {/* New rows (yellow bg) */}
                {newRows.map((row, i) => (
                  <tr key={`new-${i}`} className="bg-yellow-50">
                    {i === 0 ? (
                      <td
                        rowSpan={newRows.length}
                        className="px-3 py-2 text-[10px] font-medium text-yellow-700 uppercase tracking-wider align-top border-r border-yellow-100"
                      >
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block w-2 h-2 rounded-full bg-yellow-400"></span>
                          New
                        </span>
                      </td>
                    ) : null}
                    {canonicalColumns.map((col) => (
                      <td
                        key={col}
                        className="px-3 py-2 text-xs text-gray-700 truncate max-w-[150px]"
                        title={row[col]}
                      >
                        {row[col]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Row count summary */}
          <div className="flex-shrink-0 flex items-center gap-4 text-xs text-gray-500">
            {!isFirstUpload && (
              <>
                <span>Existing: <strong className="text-gray-700">{existingTotalCount.toLocaleString()}</strong> rows</span>
                <span className="text-gray-300">|</span>
              </>
            )}
            <span>New: <strong className="text-gray-700">{preview.totalRows.toLocaleString()}</strong> rows</span>
            {!isFirstUpload && (
              <>
                <span className="text-gray-300">|</span>
                <span>Total after import: <strong className="text-gray-700">{totalAfterImport.toLocaleString()}</strong> rows</span>
              </>
            )}
          </div>
        </>
      )}

      {/* Bottom bar */}
      <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-gray-200">
        <button
          onClick={onBack}
          disabled={importing}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          &larr; Back to Mapping
        </button>
        <button
          onClick={onConfirm}
          disabled={importing}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
        >
          {importing ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Importing...
            </>
          ) : (
            'Import & Continue \u2192'
          )}
        </button>
      </div>
    </div>
  )
}
