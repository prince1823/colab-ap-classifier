import React, { useState, useRef } from 'react'
import { Upload, Download, X, DatabaseZap } from 'lucide-react'
import type { NormalizeDataSource } from '../../hooks/useNormalizeData'
import type { CsvApplyRow } from '../../../shared/types/suppliers'
import SupplierImportModal from './SupplierImportModal'
import CsvApplyModal from './CsvApplyModal'
import { parseNormalizeCsv, csvHasApplyColumns, parseCsvToNormalizeData, suppliersToCSV } from '../../lib/csv-normalize'

interface CsvToolbarProps {
  data: NormalizeDataSource
  onIngestComplete?: () => void
}

export default function CsvToolbar({ data, onIngestComplete }: CsvToolbarProps) {
  const [showImportModal, setShowImportModal] = useState(false)
  const [applyRows, setApplyRows] = useState<CsvApplyRow[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

        {/* Download current data */}
        {data.suppliers.length > 0 && (
          <button
            onClick={data.exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 transition-colors"
            title="Download as CSV"
          >
            <Download size={13} />
            Download
          </button>
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
