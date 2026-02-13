import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import type { ProjectSupplier, SupplierType, SupplierResearchResult } from '../../shared/types/suppliers'

const SUPPLIER_TYPES: SupplierType[] = ['company', 'individual', 'government']

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<ProjectSupplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editType, setEditType] = useState<SupplierType | ''>('')
  const [editCatA, setEditCatA] = useState(false)
  const [saving, setSaving] = useState(false)

  const [researchingName, setResearchingName] = useState<string | null>(null)
  const [researchResult, setResearchResult] = useState<SupplierResearchResult | null>(null)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await ipc.suppliers.list()
      setSuppliers(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suppliers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

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
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  const handleResearch = async (name: string) => {
    setResearchingName(name)
    setResearchResult(null)
    try {
      const result = await ipc.suppliers.research(name)
      setResearchResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research failed')
    } finally {
      setResearchingName(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Suppliers</h2>
        <p className="mt-1 text-sm text-gray-500">{suppliers.length} suppliers</p>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {researchResult && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-blue-900">Research Result</h3>
            <button onClick={() => setResearchResult(null)} className="text-xs text-blue-600 hover:text-blue-800">Dismiss</button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-blue-800">
            {researchResult.officialBusinessName && <div><span className="font-medium">Name:</span> {researchResult.officialBusinessName}</div>}
            {researchResult.industry && <div><span className="font-medium">Industry:</span> {researchResult.industry}</div>}
            {researchResult.description && <div className="col-span-2"><span className="font-medium">Description:</span> {researchResult.description}</div>}
            {researchResult.websiteUrl && <div><span className="font-medium">Website:</span> {researchResult.websiteUrl}</div>}
            {researchResult.parentCompany && <div><span className="font-medium">Parent:</span> {researchResult.parentCompany}</div>}
          </div>
        </div>
      )}

      <div className="overflow-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Supplier</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Type</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Transactions</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Spend</th>
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
                      <select value={editType} onChange={(e) => setEditType(e.target.value as SupplierType)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                        <option value="">--</option>
                        {SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
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
                      <input type="checkbox" checked={editCatA} onChange={(e) => setEditCatA(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-blue-600" />
                    ) : (
                      <span className={s.categoryA ? 'text-green-600' : 'text-gray-400'}>{s.categoryA ? 'Yes' : '-'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {isEditing ? (
                      <div className="flex justify-end gap-1">
                        <button onClick={() => saveEdit(s.supplierName)} disabled={saving} className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
                        <button onClick={() => setEditingId(null)} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <button onClick={() => handleResearch(s.supplierName)} disabled={researchingName === s.supplierName} className="text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50">
                          {researchingName === s.supplierName ? 'Researching...' : 'Research'}
                        </button>
                        <button onClick={() => startEdit(s)} className="text-xs text-blue-600 hover:text-blue-800">Edit</button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
            {suppliers.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No suppliers found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
