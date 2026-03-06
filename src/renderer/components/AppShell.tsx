import { useState, useEffect, useRef } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import LaunchModal from './LaunchModal'
import { useWorkflowStore } from '../stores/workflowStore'

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { subscribeToClassificationProgress, hasProject, refreshMetadata, refreshGateState, setLastRoute, loadProject, closeProject, reset } = useWorkflowStore()
  const location = useLocation()
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

  // Track current route in persisted store
  useEffect(() => {
    if (hasProject && location.pathname !== '/') {
      setLastRoute(location.pathname)
    }
  }, [location.pathname, hasProject, setLastRoute])

  // Subscribe to classification progress events when a project is open
  useEffect(() => {
    if (!hasProject) return
    const unsubscribe = subscribeToClassificationProgress()
    return unsubscribe
  }, [hasProject, subscribeToClassificationProgress])

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
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            <Outlet />
          </div>
        </main>
      </div>
      {!hasProject && !reopening && <LaunchModal onProjectReady={handleProjectReady} />}
    </div>
  )
}
