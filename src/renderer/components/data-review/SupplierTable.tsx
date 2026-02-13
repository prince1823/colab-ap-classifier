import { useState } from 'react'
import { ipc } from '../../lib/ipc'
import type { ProjectSupplier, SupplierType } from '../../../shared/types/suppliers'

interface Props {
  suppliers: ProjectSupplier[]
  onUpdated: () => void
}

const SUPPLIER_TYPES: SupplierType[] = ['company', 'individual', 'government']

export default function SupplierTable({ suppliers, onUpdated }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editType, setEditType] = useState<SupplierType | ''>('')
  const [editCatA, setEditCatA] = useState(false)
  const [saving, setSaving] = useState(false)

  const startEdit = (s: ProjectSupplier) => {
    setEditingId(s.id)
    setEditType(s.supplierType || '')
    setEditCatA(s.categoryA)
  }

  const saveEdit = async (supplierName: string) => {
    setSaving(true)
    try {
      await ipc.suppliers.update(supplierName, {
        supplierType: editType || null,
        categoryA: editCatA,
      })
      setEditingId(null)
      onUpdated()
    } catch (e) {
      console.error('Failed to update supplier:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overflow-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Supplier</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Type</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Transactions</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Total Spend</th>
            <th className="px-4 py-3 text-center text-xs font-medium uppercase text-gray-500">Cat. A</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {suppliers.map((s) => {
            const isEditing = editingId === s.id
            return (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-4 py-2 font-medium text-gray-900">{s.supplierName}</td>
                <td className="px-4 py-2">
                  {isEditing ? (
                    <select
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as SupplierType)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      <option value="">--</option>
                      {SUPPLIER_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-gray-600">{s.supplierType || '-'}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right text-gray-600">{s.transactionCount}</td>
                <td className="px-4 py-2 text-right text-gray-600">
                  ${s.totalSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-center">
                  {isEditing ? (
                    <input
                      type="checkbox"
                      checked={editCatA}
                      onChange={(e) => setEditCatA(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    />
                  ) : (
                    <span className={s.categoryA ? 'text-green-600' : 'text-gray-400'}>
                      {s.categoryA ? 'Yes' : '-'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {isEditing ? (
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => saveEdit(s.supplierName)}
                        disabled={saving}
                        className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => startEdit(s)}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {suppliers.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-gray-500">No suppliers found</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
