import React, { useState } from 'react'
import { Upload, Download } from 'lucide-react'
import type { NormalizeDataSource } from '../../hooks/useNormalizeData'
import SupplierImportModal from './SupplierImportModal'

interface CsvToolbarProps {
  data: NormalizeDataSource
  onIngestComplete?: () => void
}

export default function CsvToolbar({ data, onIngestComplete }: CsvToolbarProps) {
  const [showImportModal, setShowImportModal] = useState(false)

  const handleComplete = async () => {
    setShowImportModal(false)
    await data.refresh()
    onIngestComplete?.()
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Upload button */}
        <button
          onClick={() => setShowImportModal(true)}
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
          onComplete={handleComplete}
        />
      )}
    </>
  )
}
