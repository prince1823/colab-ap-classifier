import { useState, useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import LaunchModal from './LaunchModal'
import { useWorkflowStore } from '../stores/workflowStore'
import ProjectView from '../views/ProjectView'
import TaxonomyView from '../views/TaxonomyView'
import DataView from '../views/DataView'
import SuppliersView from '../views/SuppliersView'
import ClassificationView from '../views/ClassificationView'
import ReviewView from '../views/ReviewView'
import OverrideRulesView from '../views/OverrideRulesView'
import VersionHistoryView from '../views/VersionHistoryView'
import SyncToUniverseView from '../views/SyncToUniverseView'
import { cancelResearch } from '../lib/researchRunner'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'

/** Route config for keep-alive rendering */
const ROUTE_PAGES: { path: string; element: ReactNode }[] = [
  { path: '/project', element: <ProjectView /> },
  { path: '/taxonomy', element: <TaxonomyView /> },
  { path: '/data', element: <DataView /> },
  { path: '/suppliers', element: <SuppliersView /> },
  { path: '/classification', element: <ClassificationView /> },
  { path: '/review', element: <ReviewView /> },
  { path: '/override-rules', element: <OverrideRulesView /> },
  { path: '/version-history', element: <VersionHistoryView /> },
  { path: '/sync-to-universe', element: <SyncToUniverseView /> },
]

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { subscribeToClassificationProgress, subscribeToResearchProgress, subscribeToQCProgress, hasProject, refreshMetadata, refreshGateState, setLastRoute, loadProject, closeProject, reset, classificationProgress, researchProgress, projectFilePath } = useWorkflowStore()
  const location = useLocation()
  // Track which routes have been visited so we mount them once and keep them alive
  const [visitedRoutes, setVisitedRoutes] = useState<Set<string>>(new Set([location.pathname]))
  const navigate = useNavigate()
  const autoReopenAttempted = useRef(false)
  // Initialize synchronously so the first render already shows the spinner
  // if a project filePath was persisted — prevents flash of wrong UI state.
  const [reopening, setReopening] = useState(
    () => !!useWorkflowStore.getState().projectFilePath
  )

  // Auto-reopen project from persisted state on first mount
  useEffect(() => {
    if (autoReopenAttempted.current) return
    autoReopenAttempted.current = true

    const { projectFilePath, lastRoute } = useWorkflowStore.getState()
    if (!projectFilePath) return

    loadProject(projectFilePath)
      .then(() => {
        refreshGateState()
        const target = lastRoute || '/project'
        navigate(target, { replace: true })
      })
      .catch((err) => {
        console.warn('[AutoReopen] Failed to reopen project:', err)
        reset()
      })
      .finally(() => setReopening(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset keep-alive pages on project switch so stale state doesn't persist.
  // When projectFilePath changes, all previously mounted pages unmount and
  // will re-mount fresh the next time they're visited.
  const prevProjectRef = useRef(projectFilePath)
  useEffect(() => {
    if (prevProjectRef.current !== projectFilePath) {
      prevProjectRef.current = projectFilePath
      setVisitedRoutes(new Set([location.pathname]))
    }
  }, [projectFilePath, location.pathname])

  // Track current route in persisted store + mark as visited for keep-alive
  useEffect(() => {
    if (hasProject && location.pathname !== '/') {
      setLastRoute(location.pathname)
    }
    setVisitedRoutes((prev) => {
      if (prev.has(location.pathname)) return prev
      return new Set(prev).add(location.pathname)
    })
  }, [location.pathname, hasProject, setLastRoute])

  // Subscribe to classification progress events when a project is open
  useEffect(() => {
    if (!hasProject) return
    const unsubscribe = subscribeToClassificationProgress()
    return unsubscribe
  }, [hasProject, subscribeToClassificationProgress])

  // Subscribe to research progress events (from EventBus) when a project is open
  useEffect(() => {
    if (!hasProject) return
    const unsubscribe = subscribeToResearchProgress()
    return unsubscribe
  }, [hasProject, subscribeToResearchProgress])

  // Subscribe to QC progress events when a project is open
  useEffect(() => {
    if (!hasProject) return
    const unsubscribe = subscribeToQCProgress()
    return unsubscribe
  }, [hasProject, subscribeToQCProgress])

  // Show research progress on non-supplier pages
  const showGlobalResearchProgress = researchProgress?.status === 'running' && location.pathname !== '/suppliers'
  const showGlobalClassificationProgress = classificationProgress?.status === 'running' && location.pathname !== '/classification'

  // Refresh metadata + gate state on every route change so views stay in sync.
  useEffect(() => {
    const currentHasProject = useWorkflowStore.getState().hasProject
    if (!currentHasProject) return

    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) {
        refreshMetadata()
        refreshGateState()
      }
    }, 50)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const handleSwitchProject = () => {
    closeProject()
  }

  const handleProjectReady = () => {
    refreshGateState()
    navigate('/project', { replace: true })
  }

  const handleCancelClassification = async () => {
    try {
      await ipc.classification.stop()
    } catch (e) {
      showError('Failed to cancel classification', e)
    }
  }

  if (reopening) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
          <p className="text-sm text-gray-500">Reopening project...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          onSwitchProject={handleSwitchProject}
        />
        <main className="flex flex-1 flex-col overflow-hidden relative">
          {showGlobalClassificationProgress && classificationProgress && (
            <div className="flex items-center gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-xs" style={{ zIndex: 2 }}>
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" />
              <span className="min-w-0 truncate font-medium text-indigo-800">
                {classificationProgress.currentSupplier
                  ? <>Classifying: <strong>{classificationProgress.currentSupplier}</strong></>
                  : classificationProgress.currentStep
                }
              </span>
              {classificationProgress.totalSuppliers > 0 && (
                <span className="shrink-0 text-indigo-600 tabular-nums">
                  {classificationProgress.processedSuppliers}/{classificationProgress.totalSuppliers}
                </span>
              )}
              <div className="ml-auto h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-indigo-200">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all"
                  style={{ width: `${classificationProgress.percentage}%` }}
                />
              </div>
              <button
                onClick={handleCancelClassification}
                className="min-h-8 shrink-0 rounded-md border border-indigo-300 px-2.5 text-xs font-medium text-indigo-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 active:scale-[0.96]"
              >
                Cancel
              </button>
            </div>
          )}
          {showGlobalResearchProgress && researchProgress && (
            <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs" style={{ zIndex: 2 }}>
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
              <span className="min-w-0 truncate font-medium text-blue-800">
                {researchProgress.currentSupplier
                  ? <>Researching: <strong>{researchProgress.currentSupplier}</strong></>
                  : researchProgress.currentStep
                }
              </span>
              {researchProgress.totalSuppliers > 0 && (
                <span className="shrink-0 text-blue-600 tabular-nums">
                  {researchProgress.processedSuppliers}/{researchProgress.totalSuppliers}
                </span>
              )}
              <div className="ml-auto h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-blue-200">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all"
                  style={{ width: `${researchProgress.totalSuppliers > 0 ? (researchProgress.processedSuppliers / researchProgress.totalSuppliers) * 100 : 0}%` }}
                />
              </div>
              <button
                onClick={cancelResearch}
                className="min-h-8 shrink-0 rounded-md border border-blue-300 px-2.5 text-xs font-medium text-blue-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 active:scale-[0.96]"
              >
                Cancel
              </button>
            </div>
          )}
          {ROUTE_PAGES.map(({ path, element }) => {
            const isActive = location.pathname === path
            if (!visitedRoutes.has(path)) return null
            return (
              <div
                key={path}
                className="overflow-auto absolute inset-0"
                style={{
                  visibility: isActive ? 'visible' : 'hidden',
                  pointerEvents: isActive ? 'auto' : 'none',
                  zIndex: isActive ? 1 : 0,
                }}
              >
                {element}
              </div>
            )
          })}
        </main>
      </div>
      {!hasProject && !reopening && <LaunchModal onProjectReady={handleProjectReady} />}
    </div>
  )
}
