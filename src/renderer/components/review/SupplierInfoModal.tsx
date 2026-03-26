import { useState, useEffect } from 'react'
import { X, ExternalLink, ArrowRight } from 'lucide-react'
import type { SupplierInfo } from '../../../shared/types/suppliers'
import { ipc } from '../../lib/ipc'

interface SupplierEntry {
  name: string
  info: SupplierInfo | null
  isResearched: boolean
}

interface Props {
  suppliers: SupplierEntry[]
  onClose: () => void
  onGoToSuppliers: () => void
}

export default function SupplierInfoModal({ suppliers, onClose, onGoToSuppliers }: Props) {
  const multi = suppliers.length > 1

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', handleEsc, true)
    return () => window.removeEventListener('keydown', handleEsc, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={onClose}
    >
      <div
        className={`bg-white rounded-xl shadow-2xl mx-4 overflow-hidden flex flex-col ${multi ? 'max-w-[90vw]' : 'max-w-lg w-full'}`}
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-sm font-bold text-gray-900">
            Supplier Info {multi && <span className="text-gray-400 font-normal">({suppliers.length})</span>}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onGoToSuppliers}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-gray-300 text-[10px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Go to Suppliers <ArrowRight size={10} />
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body — horizontal scroll for multiple */}
        <div className={`overflow-auto flex-1 ${multi ? 'flex gap-0 divide-x divide-gray-200' : ''}`} style={{ scrollbarWidth: 'thin' }}>
          {suppliers.map((s, idx) => (
            <div key={idx} className={`flex-shrink-0 overflow-y-auto ${multi ? 'w-[280px] p-3' : 'p-4'}`} style={{ maxHeight: '60vh', scrollbarWidth: 'thin' }}>
              {/* Supplier name */}
              <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wide truncate mb-2" title={s.name}>
                {s.name}
              </h3>

              {!s.isResearched ? (
                <div className="py-3">
                  <p className="text-[11px] text-gray-500">
                    Supplier not researched. Go to{' '}
                    <button
                      onClick={onGoToSuppliers}
                      className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                    >
                      Supplier Page
                    </button>
                    {' '}and do the research first.
                  </p>
                </div>
              ) : !s.info ? (
                <p className="text-[11px] text-gray-400 py-3">No info available</p>
              ) : (
                <div className="space-y-1.5">
                  {s.info.industry && <Field label="Industry" value={s.info.industry} />}
                  {s.info.description && <Field label="Desc" value={s.info.description} expandable />}
                  {s.info.serviceType && <Field label="Service" value={s.info.serviceType} />}
                  {s.info.productsServices && <Field label="Products" value={s.info.productsServices} expandable />}
                  {s.info.supplierAddress && <Field label="Address" value={s.info.supplierAddress} />}
                  {s.info.naicsCode && <Field label="NAICS" value={`${s.info.naicsCode}${s.info.naicsDescription ? ' — ' + s.info.naicsDescription : ''}`} />}
                  {s.info.confidence && <Field label="Confidence" value={s.info.confidence} />}

                  {s.info.sources && s.info.sources.length > 0 && (
                    <SourcesList sources={s.info.sources} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-md border border-gray-300 text-[11px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, expandable }: { label: string; value: string; expandable?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = expandable && value.length > 80

  return (
    <div className="flex gap-2 items-baseline">
      <span className="text-[9px] font-semibold text-gray-400 uppercase flex-shrink-0 w-[52px]">{label}</span>
      <span className="text-[11px] text-gray-700 leading-tight">
        <span className={!expanded && isLong ? 'line-clamp-2' : ''}>{value}</span>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-blue-500 hover:text-blue-700 ml-1 font-medium"
          >
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </span>
    </div>
  )
}

function SourcesList({ sources }: { sources: string[] }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? sources : sources.slice(0, 3)
  const remaining = sources.length - 3

  return (
    <div>
      <span className="text-[9px] font-semibold text-gray-400 uppercase">Sources</span>
      <div className="mt-0.5 space-y-0.5">
        {visible.map((src, i) => {
          let hostname = src
          try { hostname = new URL(src).hostname } catch { /* use raw */ }
          return (
            <a
              key={i}
              href="#"
              onClick={(e) => {
                e.preventDefault()
                const url = src.startsWith('http://') || src.startsWith('https://') ? src : `https://${src}`;
                ipc.shell.openExternal(url)
              }}
              className="flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-800 hover:underline truncate cursor-pointer"
              title={src}
            >
              <ExternalLink size={8} className="flex-shrink-0" />
              <span className="truncate">{hostname}</span>
            </a>
          )
        })}
        {remaining > 0 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
          >
            {showAll ? 'show less' : `+${remaining} more`}
          </button>
        )}
      </div>
    </div>
  )
}
