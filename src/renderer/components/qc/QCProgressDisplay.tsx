import type { QCProgress } from '../../../shared/types/classification'

interface OutcomeCounts {
  clean: number
  consolidated: number
  flagged: number
  skipped: number
}

interface Props {
  progress: QCProgress
  outcomes: OutcomeCounts
  onDismiss?: () => void
}

export default function QCProgressDisplay({ progress, outcomes, onDismiss }: Props) {
  const pct = Math.round(progress.percentage)
  const isRunning = progress.status === 'running'
  const isCompleted = progress.status === 'completed'
  const isFailed = progress.status === 'failed'
  const isCancelled = progress.status === 'cancelled'

  const barColor = isCompleted
    ? 'from-emerald-400 to-emerald-500'
    : isFailed || isCancelled
      ? 'from-red-400 to-red-500'
      : 'from-violet-500 to-indigo-500'

  const statusIcon = isCompleted
    ? <svg className="h-4 w-4 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    : isFailed
      ? <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
      : isCancelled
        ? <svg className="h-4 w-4 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
        : null

  const total = outcomes.clean + outcomes.consolidated + outcomes.flagged + outcomes.skipped

  return (
    <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-5 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {isRunning ? (
            <div className="relative h-4 w-4">
              <div className="absolute inset-0 animate-ping rounded-full bg-violet-400 opacity-30" />
              <div className="relative h-4 w-4 rounded-full bg-violet-500" />
            </div>
          ) : (
            statusIcon
          )}
          <span className="text-sm font-semibold text-gray-800">
            {isCompleted ? 'QC Complete' : isFailed ? 'QC Failed' : isCancelled ? 'QC Cancelled' : 'Running QC Agent'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500">
            {progress.processedSuppliers} / {progress.totalSuppliers} suppliers
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold tabular-nums text-gray-700">
            {pct}%
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="relative mb-2.5 h-2 overflow-hidden rounded-full bg-gray-200/80">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${barColor} transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
        {isRunning && pct > 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)',
              animation: 'shimmer 1.5s infinite',
            }}
          />
        )}
      </div>

      {/* Current step */}
      {progress.currentStep && (
        <p className="truncate text-[11px] text-gray-400 mb-3">
          {progress.currentStep}
        </p>
      )}

      {/* Live outcome counters */}
      {total > 0 && (
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-gray-600">Clean</span>
            <span className="font-semibold text-gray-800">{outcomes.clean}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
            <span className="text-gray-600">Consolidated</span>
            <span className="font-semibold text-gray-800">{outcomes.consolidated}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            <span className="text-gray-600">Flagged</span>
            <span className="font-semibold text-gray-800">{outcomes.flagged}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
            <span className="text-gray-600">Skipped</span>
            <span className="font-semibold text-gray-800">{outcomes.skipped}</span>
          </span>
        </div>
      )}

      {/* Terminal banners */}
      {isCompleted && (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {progress.totalSuppliers} suppliers processed.
          </div>
          {onDismiss && (
            <button onClick={onDismiss} className="text-xs text-emerald-600 hover:text-emerald-800 font-medium">Dismiss</button>
          )}
        </div>
      )}
      {isFailed && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          QC failed. {progress.currentStep}
        </div>
      )}
      {isCancelled && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          QC was cancelled.
        </div>
      )}

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
      `}</style>
    </div>
  )
}
