import { useState, useEffect } from 'react'
import ColumnMappingEditor from '../components/upload/ColumnMappingEditor'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { CanonicalColumnMapping, CanonicalizationResult } from '../../shared/types/canonicalization'

export default function CanonicalizationPage() {
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)

  const [columns, setColumns] = useState<string[]>([])
  const [mapping, setMapping] = useState<CanonicalColumnMapping>({})
  const [groupingColumns, setGroupingColumns] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Load fresh data from backend on mount
  useEffect(() => {
    const load = async () => {
      try {
        // Always get fresh metadata from backend
        const metadata = await ipc.project.getMetadata()
        const cols = await ipc.transactions.getColumns()
        setColumns(cols)
        if (metadata?.columnMappings) {
          setMapping(metadata.columnMappings)
        }
        if (metadata?.invoiceGroupingColumns) {
          setGroupingColumns(metadata.invoiceGroupingColumns)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load column data')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, []) // Only run on mount — no stale metadata dependency

  // Build a pseudo CanonicalizationResult from existing mappings
  const suggestion: CanonicalizationResult = {
    mappings: mapping,
    confidence: 'high',
    unmappedClientColumns: columns.filter((c) => !Object.values(mapping).includes(c)),
    importantUnmappedColumns: [],
    unmappedCanonicalColumns: [],
    reasoning: 'Loaded from current project settings.',
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await ipc.canonicalization.save(mapping, groupingColumns)
      await refreshMetadata()
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save mappings')
    } finally {
      setSaving(false)
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

  if (columns.length === 0 && !error) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900">Column Mappings</h2>
        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          <p className="text-sm">No data uploaded yet.</p>
          <p className="mt-1 text-xs">Upload a CSV file first to configure column mappings.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Column Mappings</h2>
        <p className="mt-1 text-sm text-gray-500">
          Review and edit how your CSV columns map to canonical fields.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}
      {saved && (
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">Mappings saved successfully.</div>
      )}

      <ColumnMappingEditor
        suggestion={suggestion}
        csvColumns={columns}
        onMappingChange={setMapping}
        groupingColumns={groupingColumns}
        onGroupingChange={setGroupingColumns}
      />

      <div className="flex justify-end border-t border-gray-200 pt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Mappings'}
        </button>
      </div>
    </div>
  )
}
