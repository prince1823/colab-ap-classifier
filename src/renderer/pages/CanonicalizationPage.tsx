import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import ColumnMappingEditor from '../components/upload/ColumnMappingEditor'
import { ipc } from '../lib/ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { CanonicalColumnMapping, CanonicalizationResult } from '../../shared/types/canonicalization'

export default function CanonicalizationPage() {
  const navigate = useNavigate()
  const refreshMetadata = useWorkflowStore((s) => s.refreshMetadata)
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)

  // Upload draft from global store (set during upload flow)
  const uploadDraft = useWorkflowStore((s) => s.uploadDraft)
  const setUploadDraft = useWorkflowStore((s) => s.setUploadDraft)
  const clearUploadDraft = useWorkflowStore((s) => s.clearUploadDraft)

  // Local state for editing existing mappings (when no draft is active)
  const [columns, setColumns] = useState<string[]>([])
  const [mapping, setMapping] = useState<CanonicalColumnMapping>({})
  const [groupingColumns, setGroupingColumns] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Determine if we're in "fresh upload" mode (draft has preview) vs "edit existing" mode
  const hasDraftPreview = uploadDraft.preview !== null

  // Load existing mappings from backend (only when there's no draft preview)
  useEffect(() => {
    if (hasDraftPreview) {
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        const metadata = await ipc.project.getMetadata()

        if (metadata?.columnMappings) {
          setMapping(metadata.columnMappings)

          const csvColumnNames = Object.values(metadata.columnMappings)

          try {
            const dbCols = await ipc.transactions.getColumns()
            const BASE_COLS = ['id', 'row_index', 'invoice_group_key', 'taxonomy_node_id',
              'review_score', 'classification_reasoning', 'created_at', 'updated_at']
            const canonicalNames = Object.keys(metadata.columnMappings)
            const extraCols = dbCols.filter(c => !BASE_COLS.includes(c) && !canonicalNames.includes(c))
            const allCsvColumns = [...new Set([...csvColumnNames, ...extraCols])]
            setColumns(allCsvColumns)
          } catch {
            setColumns(csvColumnNames)
          }
        } else {
          try {
            const cols = await ipc.transactions.getColumns()
            setColumns(cols)
          } catch {
            setColumns([])
          }
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
  }, [hasDraftPreview])

  // Build a pseudo CanonicalizationResult from existing mappings (for edit-existing mode)
  const mappingKey = JSON.stringify(mapping)
  const columnsKey = JSON.stringify(columns)
  const existingSuggestion: CanonicalizationResult = useMemo(() => ({
    mappings: mapping,
    confidence: 'high' as const,
    unmappedClientColumns: columns.filter((c) => !Object.values(mapping).includes(c)),
    importantUnmappedColumns: [],
    unmappedCanonicalColumns: [],
    reasoning: 'Loaded from current project settings.',
  }), [mappingKey, columnsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Save existing mappings (edit mode)
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

  // Confirm & Import (fresh upload mode)
  const handleImport = async () => {
    if (!uploadDraft.filePath) return
    setImporting(true)
    setError(null)
    try {
      await ipc.canonicalization.save(uploadDraft.mapping, uploadDraft.groupingColumns)
      await ipc.upload.csv(uploadDraft.filePath)
      await refreshMetadata()
      clearUploadDraft()
      navigate('/workflow/data-review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import data')
    } finally {
      setImporting(false)
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

  // Fresh upload mode — show draft mapping editor + Confirm & Import
  if (hasDraftPreview) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Column Mappings</h2>
          <p className="mt-1 text-sm text-gray-500">
            Review and adjust how your CSV columns map to canonical fields, then import.
          </p>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        <ColumnMappingEditor
          suggestion={uploadDraft.preview!.mappingSuggestion}
          csvColumns={uploadDraft.preview!.columns}
          onMappingChange={(m) => setUploadDraft({ mapping: m })}
          groupingColumns={uploadDraft.groupingColumns}
          onGroupingChange={(g) => setUploadDraft({ groupingColumns: g })}
        />

        <div className="flex items-center justify-between border-t border-gray-200 pt-4">
          <button
            onClick={() => navigate('/workflow/upload')}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            ← Back to Upload
          </button>
          <button
            onClick={handleImport}
            disabled={importing}
            className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? 'Importing...' : 'Confirm & Import'}
          </button>
        </div>
      </div>
    )
  }

  // No data at all
  if (columns.length === 0 && Object.keys(mapping).length === 0 && !error) {
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

  // Edit existing mappings mode
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
        suggestion={existingSuggestion}
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
