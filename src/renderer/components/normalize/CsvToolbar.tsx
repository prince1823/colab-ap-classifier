import React, { useRef } from 'react'
import { Upload, Download, X, FileSpreadsheet } from 'lucide-react'
import type { NormalizeDataSource } from '../../hooks/useNormalizeData'

interface CsvToolbarProps {
  data: NormalizeDataSource
}

export default function CsvToolbar({ data }: CsvToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      await data.loadCsv(file)
    }
    // Reset so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileSelect}
        className="hidden"
      />

      {data.mode === 'csv' ? (
        <>
          {/* CSV mode indicator */}
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 px-2.5 py-1.5 text-xs font-medium">
            <FileSpreadsheet size={13} />
            <span className="max-w-[120px] truncate" title={data.csvFileName ?? undefined}>
              {data.csvFileName}
            </span>
            <button
              onClick={data.exitCsvMode}
              className="ml-0.5 text-blue-400 hover:text-blue-700 transition-colors"
              title="Exit CSV mode"
            >
              <X size={12} />
            </button>
          </div>

          {/* Download */}
          <button
            onClick={data.exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 transition-colors"
            title="Download CSV"
          >
            <Download size={13} />
            Download
          </button>
        </>
      ) : (
        <>
          {/* Upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 transition-colors"
            title="Upload CSV to edit"
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
        </>
      )}
    </div>
  )
}
