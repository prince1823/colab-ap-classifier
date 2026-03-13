import { useMemo } from 'react'
import type { ProjectSupplierView } from '../../../shared/types/suppliers'
import { fmtAbbrev } from '../../utils/formatSpend'

interface Props {
  suppliers: ProjectSupplierView[]
  onUpdated: () => void
}

export default function SupplierTable({ suppliers, onUpdated }: Props) {
  const sorted = useMemo(() => [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend), [suppliers])
  const grandTotal = useMemo(() => suppliers.reduce((sum, s) => sum + s.totalSpend, 0), [suppliers])

  return (
    <div className="overflow-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Supplier</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Transactions</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Total Spend</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">% of Spend</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {sorted.map((s) => {
            const pct = grandTotal > 0 ? (s.totalSpend / grandTotal) * 100 : 0
            return (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-4 py-2 font-medium text-gray-900">{s.supplierName}</td>
                <td className="px-4 py-2 text-right text-gray-600">{s.transactionCount}</td>
                <td className="px-4 py-2 text-right text-gray-600">
                  {fmtAbbrev(s.totalSpend)}
                </td>
                <td className="px-4 py-2 text-right text-gray-600">
                  {pct.toFixed(1)}%
                </td>
              </tr>
            )
          })}
          {suppliers.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-gray-500">No suppliers found</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
