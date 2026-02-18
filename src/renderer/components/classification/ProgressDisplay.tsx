import type { ClassificationProgress } from '../../../shared/types/classification'

interface Props {
  progress: ClassificationProgress
}

export default function ProgressDisplay({ progress }: Props) {
  const pct = Math.round(progress.percentage)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`h-2.5 w-2.5 rounded-full ${
              progress.status === 'completed'
                ? 'bg-green-500'
                : progress.status === 'failed' || progress.status === 'cancelled'
                  ? 'bg-red-500'
                  : 'animate-pulse bg-blue-500'
            }`}
          />
          <span className="text-sm font-medium text-gray-700">
            {progress.phase === 'researching' ? 'Researching Suppliers' : 'Classifying Transactions'}
          </span>
        </div>
        <span className="text-sm text-gray-500">
          {progress.processed} / {progress.total}
        </span>
      </div>

      <div className="mb-2 h-3 overflow-hidden rounded-full bg-gray-200">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            progress.status === 'completed'
              ? 'bg-green-500'
              : progress.status === 'failed' || progress.status === 'cancelled'
                ? 'bg-red-500'
                : 'bg-blue-600'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{pct}% complete</span>
        {progress.currentStep && <span className="max-w-sm truncate">{progress.currentStep}</span>}
      </div>

      {progress.status === 'completed' && (
        <div className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
          Classification complete! {progress.total} transactions processed.
        </div>
      )}
      {progress.status === 'failed' && (
        <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          Classification failed. Please check your settings and try again.
        </div>
      )}
      {progress.status === 'cancelled' && (
        <div className="mt-4 rounded-md bg-yellow-50 p-3 text-sm text-yellow-700">
          Classification was cancelled.
        </div>
      )}
    </div>
  )
}
