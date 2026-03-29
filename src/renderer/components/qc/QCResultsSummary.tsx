interface ConsolidatedEntry {
  supplier: string
  toPath: string
}

interface FlaggedEntry {
  supplier: string
}

interface OutcomeCounts {
  clean: number
  consolidated: number
  flagged: number
  skipped: number
}

interface Props {
  totalSuppliers: number
  outcomes: OutcomeCounts
  consolidated: ConsolidatedEntry[]
  flagged: FlaggedEntry[]
}

export default function QCResultsSummary({ totalSuppliers, outcomes, consolidated, flagged }: Props) {
  const tracked = outcomes.clean + outcomes.consolidated + outcomes.flagged + outcomes.skipped

  return (
    <div className="space-y-4">
      {/* Summary badges */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-gray-700">
          Results ({totalSuppliers} supplier{totalSuppliers !== 1 ? 's' : ''}):
        </span>
        {tracked > 0 ? (
          <>
            {outcomes.clean > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {outcomes.clean} clean
              </span>
            )}
            {outcomes.consolidated > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 border border-blue-200 px-2.5 py-1 text-xs font-medium text-blue-700">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                {outcomes.consolidated} consolidated
              </span>
            )}
            {outcomes.flagged > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {outcomes.flagged} flagged
              </span>
            )}
            {outcomes.skipped > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                {outcomes.skipped} skipped
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-gray-500">
            QC completed. {totalSuppliers} supplier{totalSuppliers !== 1 ? 's' : ''} processed.
          </span>
        )}
      </div>

      {/* Consolidated suppliers list */}
      {consolidated.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-white">
          <div className="border-b border-blue-100 px-4 py-2.5">
            <h4 className="text-xs font-semibold text-blue-800 uppercase tracking-wider">
              Consolidated Suppliers ({consolidated.length})
            </h4>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-blue-50/50 sticky top-0">
                <tr>
                  <th className="px-4 py-1.5 text-left font-medium text-gray-500">Supplier</th>
                  <th className="px-4 py-1.5 text-left font-medium text-gray-500">Consolidated To</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {consolidated.map((entry, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-1.5 font-medium text-gray-800">{entry.supplier}</td>
                    <td className="px-4 py-1.5 text-gray-600">{entry.toPath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Flagged suppliers list */}
      {flagged.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-white">
          <div className="border-b border-amber-100 px-4 py-2.5 flex items-center justify-between">
            <h4 className="text-xs font-semibold text-amber-800 uppercase tracking-wider">
              Flagged for Review ({flagged.length})
            </h4>
            <span className="text-[10px] text-amber-600">
              View in Review tab for details
            </span>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            <div className="divide-y divide-gray-100">
              {flagged.map((entry, i) => (
                <div key={i} className="px-4 py-1.5 text-xs text-gray-800 hover:bg-gray-50">
                  {entry.supplier}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Hint to review */}
      {(consolidated.length > 0 || flagged.length > 0) && (
        <p className="text-xs text-gray-500">
          Go to the <strong>Review</strong> tab to examine flagged and consolidated transactions.
        </p>
      )}
    </div>
  )
}
