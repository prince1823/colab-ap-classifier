import { useWorkflowStore } from '../../stores/workflowStore'

export default function ClassificationBanner() {
  const progress = useWorkflowStore((s) => s.classificationProgress)

  if (!progress) return null

  const pct = Math.round(progress.percentage)

  return (
    <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-6 py-2 text-sm">
      <div className="flex items-center gap-2">
        <svg className="h-4 w-4 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span className="font-medium text-blue-700">
          Classifying transactions
        </span>
      </div>
      <div className="flex-1">
        <div className="h-2 overflow-hidden rounded-full bg-blue-200">
          <div
            className="h-full rounded-full bg-blue-600 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <span className="text-xs text-blue-600">
        {progress.processedSuppliers}/{progress.totalSuppliers} ({pct}%)
      </span>
      {progress.currentStep && (
        <span className="max-w-xs truncate text-xs text-blue-500">{progress.currentStep}</span>
      )}
    </div>
  )
}
