import { useState, useEffect, useCallback, useRef } from 'react'
import { ipc } from '../../lib/ipc'
import QCSettingsForm from './QCSettingsForm'
import QCProgressDisplay from './QCProgressDisplay'
import QCResultsSummary from './QCResultsSummary'
import type { QCConfig, QCProgress } from '../../../shared/types/classification'

interface OutcomeCounts {
  clean: number
  consolidated: number
  flagged: number
  skipped: number
}

interface ConsolidatedEntry {
  supplier: string
  toPath: string
}

interface FlaggedEntry {
  supplier: string
}

export default function QCPanel() {
  const [localProgress, setLocalProgress] = useState<QCProgress | null>(null)

  const [config, setConfig] = useState<QCConfig | null>(null)
  const [defaults, setDefaults] = useState<QCConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Scope count
  const [scopeCount, setScopeCount] = useState<number | null>(null)
  const [scopeCountLoading, setScopeCountLoading] = useState(false)
  const scopeCountTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Config save debounce
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Outcome tracking
  const [outcomes, setOutcomes] = useState<OutcomeCounts>({ clean: 0, consolidated: 0, flagged: 0, skipped: 0 })
  const [consolidated, setConsolidated] = useState<ConsolidatedEntry[]>([])
  const [flagged, setFlagged] = useState<FlaggedEntry[]>([])

  // Confirmation state
  const [confirmCount, setConfirmCount] = useState<number | null>(null)

  const isRunning = localProgress?.status === 'running'
  const isTerminal = localProgress != null && localProgress.status !== 'running'

  // Load config + defaults on mount
  useEffect(() => {
    async function load() {
      try {
        const [cfg, defs] = await Promise.all([
          ipc.qc.getConfig(),
          ipc.qc.getDefaults(),
        ])
        setConfig(cfg)
        setDefaults(defs)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load QC config')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Subscribe directly to qc:progress to catch every event (Zustand batches and can miss intermediate ones)
  useEffect(() => {
    const unsubscribe = ipc.qc.onProgress((progress) => {
      setLocalProgress(progress)

      // Accumulate outcomes from each progress event
      if (progress.outcome && progress.currentSupplier) {
        setOutcomes(prev => ({
          ...prev,
          [progress.outcome!]: prev[progress.outcome!] + 1,
        }))
        if (progress.outcome === 'consolidated' && progress.consolidatedTo) {
          setConsolidated(prev => [...prev, {
            supplier: progress.currentSupplier!,
            toPath: progress.consolidatedTo!,
          }])
        }
        if (progress.outcome === 'flagged') {
          setFlagged(prev => [...prev, { supplier: progress.currentSupplier! }])
        }
      }
    })
    return unsubscribe
  }, [])

  // Fetch scope count when scope changes (debounced)
  const fetchScopeCount = useCallback((scope: QCConfig['scope']) => {
    if (scopeCountTimer.current) clearTimeout(scopeCountTimer.current)
    setScopeCountLoading(true)
    scopeCountTimer.current = setTimeout(async () => {
      try {
        const count = await ipc.qc.count(scope.length > 0 ? scope : undefined)
        setScopeCount(count)
      } catch {
        setScopeCount(null)
      } finally {
        setScopeCountLoading(false)
      }
    }, 400)
  }, [])

  // Initial scope count
  useEffect(() => {
    if (config) {
      fetchScopeCount(config.scope)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Config change handler — update state, debounce save + scope count
  const handleConfigChange = useCallback((newConfig: QCConfig) => {
    setConfig(newConfig)

    // Debounced save
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      ipc.qc.setConfig(newConfig).catch(console.error)
    }, 500)

    // Debounced scope count
    fetchScopeCount(newConfig.scope)
  }, [fetchScopeCount])

  // Run QC
  const handleRun = async () => {
    if (!config) return
    // Get count first for confirmation
    setScopeCountLoading(true)
    try {
      const count = await ipc.qc.count(config.scope.length > 0 ? config.scope : undefined)
      setScopeCount(count)
      setConfirmCount(count)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to get supplier count')
    } finally {
      setScopeCountLoading(false)
    }
  }

  const handleConfirmRun = async () => {
    if (!config) return
    setConfirmCount(null)
    // Reset outcome tracking
    setOutcomes({ clean: 0, consolidated: 0, flagged: 0, skipped: 0 })
    setConsolidated([])
    setFlagged([])
    setLocalProgress(null)
    setError(null)

    try {
      await ipc.qc.run(config)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start QC')
    }
  }

  const handleStop = async () => {
    try {
      await ipc.qc.stop()
    } catch (e) {
      console.error('Failed to stop QC:', e)
    }
  }

  const handleDismiss = () => {
    setLocalProgress(null)
    setOutcomes({ clean: 0, consolidated: 0, flagged: 0, skipped: 0 })
    setConsolidated([])
    setFlagged([])
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-violet-500" />
      </div>
    )
  }

  if (!config) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        {error || 'Failed to load QC configuration.'}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Settings (hidden while running) */}
      {!isRunning && !isTerminal && (
        <QCSettingsForm
          config={config}
          defaults={defaults}
          onChange={handleConfigChange}
          scopeCount={scopeCount}
          scopeCountLoading={scopeCountLoading}
        />
      )}

      {/* Controls */}
      {!isRunning && !isTerminal && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleRun}
            disabled={scopeCountLoading}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
          >
            Run QC
          </button>
          {scopeCount !== null && !scopeCountLoading && (
            <span className="text-xs text-gray-500">
              {scopeCount} supplier{scopeCount !== 1 ? 's' : ''} in scope
            </span>
          )}
        </div>
      )}

      {isRunning && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleStop}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            Stop QC
          </button>
        </div>
      )}

      {/* Confirmation modal */}
      {confirmCount !== null && (
        <div className="flex items-center gap-3 rounded-md border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm">
          <span className="text-violet-800">
            Run QC on <strong>{confirmCount}</strong> supplier{confirmCount !== 1 ? 's' : ''}?
          </span>
          <button
            onClick={handleConfirmRun}
            disabled={confirmCount === 0}
            className="rounded bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirmCount(null)}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Progress display */}
      {localProgress && (
        <QCProgressDisplay
          progress={localProgress}
          outcomes={outcomes}
          onDismiss={isTerminal ? handleDismiss : undefined}
        />
      )}

      {/* Results summary (after completion) */}
      {isTerminal && localProgress?.status === 'completed' && (
        <QCResultsSummary
          totalSuppliers={localProgress.totalSuppliers}
          outcomes={outcomes}
          consolidated={consolidated}
          flagged={flagged}
        />
      )}

      {/* Empty state */}
      {!isRunning && !localProgress && !error && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          <p className="text-sm">Configure settings above and run QC to review classifications.</p>
        </div>
      )}
    </div>
  )
}
