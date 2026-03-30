import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ArrowDownTrayIcon, TableCellsIcon } from '@heroicons/react/24/outline'

interface ExportModalProps {
  isOpen: boolean
  onClose: () => void
  onFullExport: () => void
  onPivotExport: () => void
}

export default function ExportModal({ isOpen, onClose, onFullExport, onPivotExport }: ExportModalProps) {
  if (!isOpen) return null

  const handleFullExport = () => {
    onClose()
    onFullExport()
  }

  const handlePivotExport = () => {
    onClose()
    onPivotExport()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl w-[360px] p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-800">Export CSV</h3>
          <button
            onClick={onClose}
            className="rounded-full p-0.5 hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <X size={14} />
          </button>
        </div>

        {/* Options */}
        <div className="flex flex-col gap-2">
          <button
            onClick={handleFullExport}
            className="flex items-start gap-3 rounded-md border border-gray-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
          >
            <ArrowDownTrayIcon className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs font-medium text-gray-800">Full CSV Export</div>
              <div className="text-[10px] text-gray-500 mt-0.5">
                All source columns, supplier name, parent name, and classification columns
              </div>
            </div>
          </button>

          <button
            onClick={handlePivotExport}
            className="flex items-start gap-3 rounded-md border border-gray-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
          >
            <TableCellsIcon className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs font-medium text-gray-800">Pivot View Export</div>
              <div className="text-[10px] text-gray-500 mt-0.5">
                Export the current pivot table view as shown on screen
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
