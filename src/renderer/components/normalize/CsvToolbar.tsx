import React, { useState, useRef, useEffect } from 'react'
import { Upload, Download, X, DatabaseZap, ChevronDown, Eye, Database } from 'lucide-react'
import type { NormalizeDataSource } from '../../hooks/useNormalizeData'
import type { CsvApplyRow } from '../../../shared/types/suppliers'
import SupplierImportModal from './SupplierImportModal'
import CsvApplyModal from './CsvApplyModal'
import { csvHasApplyColumns, parseCsvToNormalizeData } from '../../lib/csv-normalize'

interface CsvToolbarProps {
  data: NormalizeDataSource
  onIngestComplete?: () => void
  /** Export what's currently visible (filtered + sorted + current page in project mode). */
  onExportCurrentView: () => Promise<void> | void
  /** Export the entire dataset — delegates to transactions export (all columns) in project mode. */
  onExportFullDataset: () => Promise<void> | void
  /** Count of rows in the current view (shown in the dropdown menu). */
  currentViewCount: number
  /** Whether an export is in progress (shows spinner + disables menu). */
  exporting: boolean
}

export default function CsvToolbar({
  data,
  onIngestComplete,
  onExportCurrentView,
  onExportFullDataset,
  currentViewCount,
  exporting,
}: CsvToolbarProps) {
  const [showImportModal, setShowImportModal] = useState(false)
  const [applyRows, setApplyRows] = useState<CsvApplyRow[] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleImportComplete = async () => {
    setShowImportModal(false)
    await data.refresh()
    onIngestComplete?.()
  }

  const handleApplyComplete = async () => {
    setApplyRows(null)
    data.exitCsvMode()
    await data.refresh()
    onIngestComplete?.()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const fileName = file.name
    e.target.value = ''

    const reader = new FileReader()
    reader.onload = () => {
      const csvString = reader.result as string
      if (csvHasApplyColumns(csvString)) {
        // Has supplier_name + aliases columns → enter CSV editing mode
        const csvData = parseCsvToNormalizeData(csvString)
        data.enterCsvMode(csvData, fileName)
      } else {
        // Simple supplier list → existing import flow
        setShowImportModal(true)
      }
    }
    reader.readAsText(file)
  }

  const handleApplyToProject = () => {
    // Convert current in-memory CSV state to CsvApplyRows for the diff engine
    const rows: CsvApplyRow[] = data.suppliers.map(s => ({
      parentName: s.parentName ?? null,
      supplierName: s.supplierName,
      aliases: (data.aliasCache.get(s.id) ?? []).map(a => a.rawName),
    }))
    setApplyRows(rows)
  }

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // Close dropdown once an export finishes
  useEffect(() => {
    if (!exporting && menuOpen) setMenuOpen(false)
    // Only close automatically when exporting flips false → true → false.
    // No deps issue: we only read menuOpen for the "keep open while idle" case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporting])

  const runCurrentView = async () => {
    setMenuOpen(false)
    await onExportCurrentView()
  }

  const runFullDataset = async () => {
    setMenuOpen(false)
    await onExportFullDataset()
  }

  const canExport = data.suppliers.length > 0 || data.csvMode

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* CSV mode badge */}
        {data.csvMode && (
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 px-2.5 py-1.5 text-xs font-medium">
            <span className="truncate max-w-[120px]" title={data.csvFileName ?? undefined}>
              {data.csvFileName ?? 'CSV'}
            </span>
            <button
              onClick={data.exitCsvMode}
              className="text-blue-400 hover:text-blue-600 transition-colors ml-0.5"
              title="Exit CSV mode"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Apply to Project button (CSV mode only) */}
        {data.csvMode && (
          <button
            onClick={handleApplyToProject}
            className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-green-50 text-green-700 px-2.5 py-1.5 text-xs font-medium hover:bg-green-100 transition-colors"
            title="Apply CSV changes to the project database"
          >
            <DatabaseZap size={13} />
            Apply to Project
          </button>
        )}

        {/* Upload button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 transition-colors"
          title="Upload supplier list CSV"
        >
          <Upload size={13} />
          Upload CSV
        </button>

        {/* Download dropdown — split into current view vs full dataset */}
        {canExport && (
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setMenuOpen(v => !v)}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              title="Download CSV"
            >
              {exporting ? (
                <svg className="h-3 w-3 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <Download size={13} />
              )}
              {exporting ? 'Exporting…' : 'Download'}
              <ChevronDown size={11} className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
            </button>

            {menuOpen && !exporting && (
              <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-20 py-1">
                <button
                  onClick={runCurrentView}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
                >
                  <Eye size={13} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-800">Current View</div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      {currentViewCount.toLocaleString()} supplier{currentViewCount === 1 ? '' : 's'} shown (filtered/sorted)
                    </div>
                  </div>
                </button>
                <div className="border-t border-gray-100 my-0.5" />
                <button
                  onClick={runFullDataset}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
                >
                  <Database size={13} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-800">Full Dataset</div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      {data.csvMode
                        ? 'All rows from the loaded CSV (ignores filter)'
                        : 'All transactions, all columns (same as Sync & Export)'}
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showImportModal && (
        <SupplierImportModal
          onClose={() => setShowImportModal(false)}
          onComplete={handleImportComplete}
        />
      )}

      {applyRows && (
        <CsvApplyModal
          rows={applyRows}
          onClose={() => setApplyRows(null)}
          onComplete={handleApplyComplete}
        />
      )}
    </>
  )
}
