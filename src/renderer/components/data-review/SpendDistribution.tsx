import type { ProjectSupplier } from '../../../shared/types/suppliers'

interface Props {
  suppliers: ProjectSupplier[]
}

export default function SpendDistribution({ suppliers }: Props) {
  const sorted = [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 10)
  const maxSpend = sorted[0]?.totalSpend || 1

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-4 text-sm font-medium text-gray-700">Top Suppliers by Spend</h3>
      <div className="space-y-3">
        {sorted.map((s) => {
          const pct = (s.totalSpend / maxSpend) * 100
          return (
            <div key={s.id}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="max-w-xs truncate font-medium text-gray-700">{s.supplierName}</span>
                <span className="text-gray-500">
                  ${s.totalSpend.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-blue-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
        {sorted.length === 0 && (
          <p className="text-center text-sm text-gray-400">No supplier data</p>
        )}
      </div>
    </div>
  )
}
