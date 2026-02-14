import { useState, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { CompanyContext } from '../../shared/types/project'

const FIELDS: { key: keyof CompanyContext; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: 'companyName', label: 'Company Name', placeholder: 'e.g. Acme Corp, Global Industries' },
  { key: 'industry', label: 'Industry', placeholder: 'e.g. Manufacturing, Technology, Healthcare' },
  { key: 'sector', label: 'Sector', placeholder: 'e.g. Automotive, SaaS, Pharmaceuticals' },
  { key: 'description', label: 'Company Description', placeholder: 'Brief description of the company', multiline: true },
  { key: 'businessFocus', label: 'Business Focus', placeholder: 'Core business activities and focus areas', multiline: true },
  { key: 'procurementNuances', label: 'Procurement Nuances', placeholder: 'Special procurement patterns or considerations', multiline: true },
]

export default function CompanyContextPage() {
  const metadata = useWorkflowStore((s) => s.projectMetadata)
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  const [form, setForm] = useState<CompanyContext>({
    companyName: '',
    industry: '',
    sector: '',
    description: '',
    businessFocus: '',
    procurementNuances: '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (metadata?.companyContext) {
      setForm({
        companyName: metadata.companyContext.companyName || '',
        industry: metadata.companyContext.industry || '',
        sector: metadata.companyContext.sector || '',
        description: metadata.companyContext.description || '',
        businessFocus: metadata.companyContext.businessFocus || '',
        procurementNuances: metadata.companyContext.procurementNuances || '',
      })
    }
  }, [metadata])

  const handleChange = (key: keyof CompanyContext, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await ipc.project.updateMetadata({ companyContext: form })
      await refreshMetadata()
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Company Context</h2>
        <p className="mt-1 text-sm text-gray-500">
          Provide context about the company to help the AI make better classification decisions.
        </p>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {saved && <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">Company context saved.</div>}

      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
        {FIELDS.map((field) => (
          <div key={field.key}>
            <label className="mb-1 block text-sm font-medium text-gray-700">{field.label}</label>
            {field.multiline ? (
              <textarea
                value={form[field.key] || ''}
                onChange={(e) => handleChange(field.key, e.target.value)}
                placeholder={field.placeholder}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            ) : (
              <input
                value={form[field.key] || ''}
                onChange={(e) => handleChange(field.key, e.target.value)}
                placeholder={field.placeholder}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
