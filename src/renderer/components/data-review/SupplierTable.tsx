import { useState, useEffect, useMemo } from 'react'
import { ipc } from '../../lib/ipc'
import type { ProjectSupplierView } from '../../../shared/types/suppliers'

interface Props {
  suppliers: ProjectSupplierView[]
  onUpdated: () => void
}

export default function SupplierTable({ suppliers: initialSuppliers, onUpdated }: Props) {
  const [suppliers, setSuppliers] = useState(initialSuppliers)

  // Sync if parent passes new data (e.g. on initial load)
  useEffect(() => {
    setSuppliers(initialSuppliers)
  }, [initialSuppliers])

  const toggleCatA = async (s: ProjectSupplierView) => {
    // Optimistic update — no page refresh
    setSuppliers(prev => prev.map(sup =>
      sup.supplierName === s.supplierName ? { ...sup, categoryA: !sup.categoryA } : sup
    ))
    try {
      await ipc.suppliers.update(s.supplierName, { categoryA: !s.categoryA })
    } catch (e) {
      // Revert on failure
      setSuppliers(prev => prev.map(sup =>
        sup.supplierName === s.supplierName ? { ...sup, categoryA: s.categoryA } : sup
      ))
      console.error('Failed to update supplier:', e)
    }
  }

  const sorted = useMemo(() => [...suppliers].sort((a, b) => b.totalSpend - a.totalSpend), [suppliers])

  return (
    <div className="overflow-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Supplier</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Transactions</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Total Spend</th>
            <th className="px-4 py-3 text-center text-xs font-medium uppercase text-gray-500">Cat. A</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {sorted.map((s) => (
            <tr key={s.supplierName} className="hover:bg-gray-50">
              <td className="whitespace-nowrap px-4 py-2 font-medium text-gray-900">{s.supplierName}</td>
              <td className="px-4 py-2 text-right text-gray-600">{s.transactionCount}</td>
              <td className="px-4 py-2 text-right text-gray-600">
                ${s.totalSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td className="px-4 py-2 text-center">
                <input
                  type="checkbox"
                  checked={s.categoryA}
                  onChange={() => toggleCatA(s)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
              </td>
            </tr>
          ))}
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
