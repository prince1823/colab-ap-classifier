import { useState, useEffect } from 'react'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import type { CsvApplyDiff, CsvApplyRow } from '../../../shared/types/suppliers'

interface Props {
  rows: CsvApplyRow[]
  onClose: () => void
  onComplete: () => void
}

type Step = 'computing' | 'review' | 'applying' | 'done' | 'error'

export default function CsvApplyModal({ rows, onClose, onComplete }: Props) {
  const [step, setStep] = useState<Step>('computing')
  const [diff, setDiff] = useState<CsvApplyDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noChanges, setNoChanges] = useState(false)

  // Collapsible sections
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    merges: true, renames: true, aliases: true,
    parentCreations: true, parentRenames: true, parentMerges: true, parentChanges: true,
    warnings: true,
  })

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  // Phase 1: Compute diff on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await ipc.suppliers.computeCsvDiff(rows)
        if (cancelled) return
        setDiff(result)

        const hasOps =
          result.renames.length > 0 ||
          result.merges.length > 0 ||
          result.aliasReassignments.length > 0 ||
          result.parentCreations.length > 0 ||
          result.parentRenames.length > 0 ||
          result.parentMerges.length > 0 ||
          result.parentChanges.length > 0

        if (!hasOps) setNoChanges(true)
        setStep('review')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to compute diff')
        setStep('error')
      }
    })()
    return () => { cancelled = true }
  }, [rows])

  const handleApply = async () => {
    if (!diff) return
    setStep('applying')
    try {
      await ipc.suppliers.applyCsvDiff(diff)
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply changes')
      setStep('error')
    }
  }

  const totalOps = diff
    ? diff.renames.length + diff.merges.length + diff.aliasReassignments.length +
      diff.parentCreations.length + diff.parentRenames.length + diff.parentMerges.length +
      diff.parentChanges.length
    : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative flex flex-col bg-white rounded-xl shadow-xl w-[600px] max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {step === 'computing' ? 'Analyzing Changes...' :
             step === 'review' ? (noChanges ? 'No Changes Detected' : 'Review Changes') :
             step === 'applying' ? 'Applying Changes...' :
             step === 'done' ? 'Changes Applied' :
             'Error'}
          </h2>
          <button
            onClick={onClose}
            disabled={step === 'applying'}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-auto p-6">
          {/* Computing spinner */}
          {step === 'computing' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner />
              <p className="text-sm text-gray-600">Comparing CSV against project data...</p>
            </div>
          )}

          {/* Applying spinner */}
          {step === 'applying' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner />
              <p className="text-sm text-gray-600">Applying {totalOps} operation{totalOps !== 1 ? 's' : ''}...</p>
            </div>
          )}

          {/* Error */}
          {step === 'error' && error && (
            <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
              <p className="font-medium mb-1">Error</p>
              <p>{error}</p>
            </div>
          )}

          {/* No changes */}
          {step === 'review' && noChanges && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-600 text-center">
                The CSV matches the current project data. No changes to apply.
              </p>
              {diff && diff.warnings.unknownAliases.length > 0 && (
                <WarningsSection diff={diff} expanded={expanded.warnings} onToggle={() => toggle('warnings')} />
              )}
            </div>
          )}

          {/* Review diff */}
          {step === 'review' && !noChanges && diff && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 mb-4">
                {totalOps} operation{totalOps !== 1 ? 's' : ''} will be applied to the project database:
              </p>

              {diff.merges.length > 0 && (
                <DiffSection
                  title={`${diff.merges.length} supplier merge${diff.merges.length !== 1 ? 's' : ''}`}
                  color="purple"
                  expanded={expanded.merges}
                  onToggle={() => toggle('merges')}
                >
                  {diff.merges.map((m, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="text-red-600 line-through">{m.loserNames.join(', ')}</span>
                      {' '}&rarr;{' '}
                      <span className="font-medium">{m.survivorName}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {diff.renames.length > 0 && (
                <DiffSection
                  title={`${diff.renames.length} supplier rename${diff.renames.length !== 1 ? 's' : ''}`}
                  color="blue"
                  expanded={expanded.renames}
                  onToggle={() => toggle('renames')}
                >
                  {diff.renames.map((r, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="text-gray-500">{r.oldName}</span>
                      {' '}&rarr;{' '}
                      <span className="font-medium">{r.newName}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {diff.aliasReassignments.length > 0 && (
                <DiffSection
                  title={`${diff.aliasReassignments.length} alias reassignment${diff.aliasReassignments.length !== 1 ? 's' : ''}`}
                  color="amber"
                  expanded={expanded.aliases}
                  onToggle={() => toggle('aliases')}
                >
                  {diff.aliasReassignments.map((a, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="font-mono bg-gray-100 px-1 rounded">{a.alias}</span>
                      {' '}<span className="text-gray-400">from</span>{' '}
                      <span className="text-red-600">{a.fromName}</span>
                      {' '}&rarr;{' '}
                      <span className="text-green-700 font-medium">{a.toName}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {diff.parentCreations.length > 0 && (
                <DiffSection
                  title={`${diff.parentCreations.length} new parent${diff.parentCreations.length !== 1 ? 's' : ''}`}
                  color="green"
                  expanded={expanded.parentCreations}
                  onToggle={() => toggle('parentCreations')}
                >
                  {diff.parentCreations.map((p, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="font-medium text-green-700">+ {p.name}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {diff.parentRenames.length > 0 && (
                <DiffSection
                  title={`${diff.parentRenames.length} parent rename${diff.parentRenames.length !== 1 ? 's' : ''}`}
                  color="blue"
                  expanded={expanded.parentRenames}
                  onToggle={() => toggle('parentRenames')}
                >
                  {diff.parentRenames.map((r, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="text-gray-500">{r.oldName}</span>
                      {' '}&rarr;{' '}
                      <span className="font-medium">{r.newName}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {diff.parentMerges.length > 0 && (
                <DiffSection
                  title={`${diff.parentMerges.length} parent merge${diff.parentMerges.length !== 1 ? 's' : ''}`}
                  color="purple"
                  expanded={expanded.parentMerges}
                  onToggle={() => toggle('parentMerges')}
                >
                  {diff.parentMerges.map((m, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="text-red-600 line-through">{m.loserNames.join(', ')}</span>
                      {' '}&rarr;{' '}
                      <span className="font-medium">{m.survivorName}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {diff.parentChanges.length > 0 && (
                <DiffSection
                  title={`${diff.parentChanges.length} parent assignment change${diff.parentChanges.length !== 1 ? 's' : ''}`}
                  color="teal"
                  expanded={expanded.parentChanges}
                  onToggle={() => toggle('parentChanges')}
                >
                  {diff.parentChanges.map((c, i) => (
                    <div key={i} className="text-xs text-gray-700 py-1">
                      <span className="font-medium">{c.supplierName}</span>:{' '}
                      <span className="text-gray-500">{c.oldParentName ?? '(none)'}</span>
                      {' '}&rarr;{' '}
                      <span className="font-medium text-teal-700">{c.newParentName ?? '(none)'}</span>
                    </div>
                  ))}
                </DiffSection>
              )}

              {(diff.warnings.unknownAliases.length > 0 || diff.warnings.unmatchableRows.length > 0) && (
                <WarningsSection diff={diff} expanded={expanded.warnings} onToggle={() => toggle('warnings')} />
              )}
            </div>
          )}

          {/* Done */}
          {step === 'done' && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="text-center text-sm text-gray-700">
                <p className="font-medium">Successfully applied {totalOps} operation{totalOps !== 1 ? 's' : ''}</p>
                {diff && (
                  <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                    {diff.merges.length > 0 && <p>{diff.merges.length} merge{diff.merges.length !== 1 ? 's' : ''}</p>}
                    {diff.renames.length > 0 && <p>{diff.renames.length} rename{diff.renames.length !== 1 ? 's' : ''}</p>}
                    {diff.aliasReassignments.length > 0 && <p>{diff.aliasReassignments.length} alias reassignment{diff.aliasReassignments.length !== 1 ? 's' : ''}</p>}
                    {diff.parentChanges.length > 0 && <p>{diff.parentChanges.length} parent change{diff.parentChanges.length !== 1 ? 's' : ''}</p>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
          {step === 'review' && !noChanges && (
            <>
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Apply {totalOps} Change{totalOps !== 1 ? 's' : ''}
              </button>
            </>
          )}
          {(step === 'done' || (step === 'review' && noChanges)) && (
            <button
              onClick={step === 'done' ? onComplete : onClose}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Done
            </button>
          )}
          {step === 'error' && (
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="h-10 w-10 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

const colorMap: Record<string, string> = {
  blue: 'border-blue-200 bg-blue-50',
  purple: 'border-purple-200 bg-purple-50',
  amber: 'border-amber-200 bg-amber-50',
  green: 'border-green-200 bg-green-50',
  teal: 'border-teal-200 bg-teal-50',
  yellow: 'border-yellow-200 bg-yellow-50',
}

function DiffSection({ title, color, expanded, onToggle, children }: {
  title: string; color: string; expanded: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border ${colorMap[color] ?? 'border-gray-200 bg-gray-50'}`}>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm font-medium text-gray-800"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {expanded && (
        <div className="px-3 pb-2 max-h-40 overflow-auto">{children}</div>
      )}
    </div>
  )
}

function WarningsSection({ diff, expanded, onToggle }: {
  diff: CsvApplyDiff; expanded: boolean; onToggle: () => void;
}) {
  const total = diff.warnings.unknownAliases.length + diff.warnings.unmatchableRows.length
  if (total === 0) return null
  return (
    <DiffSection title={`${total} warning${total !== 1 ? 's' : ''}`} color="yellow" expanded={expanded} onToggle={onToggle}>
      {diff.warnings.unknownAliases.slice(0, 20).map((w, i) => (
        <div key={`ua-${i}`} className="text-xs text-gray-600 py-0.5">
          Alias <span className="font-mono bg-gray-100 px-1 rounded">{w.alias}</span> in "{w.csvSupplierName}" not found in project
        </div>
      ))}
      {diff.warnings.unknownAliases.length > 20 && (
        <div className="text-xs text-gray-400 py-0.5">...and {diff.warnings.unknownAliases.length - 20} more</div>
      )}
      {diff.warnings.unmatchableRows.map((w, i) => (
        <div key={`ur-${i}`} className="text-xs text-gray-600 py-0.5">
          Row "{w.supplierName}": {w.reason}
        </div>
      ))}
    </DiffSection>
  )
}
