import type { CSVPreview } from '../../../shared/types/column-mapping'

interface Props {
  preview: CSVPreview
}

export default function CSVPreviewTable({ preview }: Props) {
  const { columns, sampleRows, totalRows } = preview

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">Data Preview</h3>
        <span className="text-xs text-gray-500">
          Showing {sampleRows.length} of ~{totalRows.toLocaleString()} rows
        </span>
      </div>
      <div className="max-h-[480px] overflow-auto rounded-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {sampleRows.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-400">
                  {i + 1}
                </td>
                {columns.map((col) => (
                  <td key={col} className="max-w-xs truncate whitespace-nowrap px-3 py-2 text-gray-700">
                    {String(row[col] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sampleRows.length < totalRows && (
        <p className="mt-1 text-center text-xs text-gray-400">
          Preview limited to first {sampleRows.length} rows. All {totalRows.toLocaleString()} rows will be imported.
        </p>
      )}
    </div>
  )
}
