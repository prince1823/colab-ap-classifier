import { useState, useEffect, useRef } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import Header from './Header'
import Sidebar from './Sidebar'
import { useWorkflowStore } from '../stores/workflowStore'

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { subscribeToClassificationProgress, hasProject, refreshMetadata, setLastRoute, loadProject, reset } = useWorkflowStore()
  const location = useLocation()
  const navigate = useNavigate()
  const autoReopenAttempted = useRef(false)
  const [reopening, setReopening] = useState(false)

  const isReviewTab = location.pathname === '/workflow/review'
  const [reviewSidebarCollapsed, setReviewSidebarCollapsed] = useState(true)

  // Auto-reopen project from persisted state on first mount
  useEffect(() => {
    if (autoReopenAttempted.current) return
    autoReopenAttempted.current = true

    const { projectMetadata, lastRoute } = useWorkflowStore.getState()
    if (!projectMetadata?.filePath) return

    setReopening(true)
    loadProject(projectMetadata.filePath)
      .then(() => {
        // Navigate to the persisted route (or fallback to upload)
        const target = lastRoute || '/workflow/upload'
        navigate(target, { replace: true })
      })
      .catch((err) => {
        console.warn('[AutoReopen] Failed to reopen project:', err)
        reset()
        navigate('/workflow/upload', { replace: true })
      })
      .finally(() => setReopening(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Track current route in persisted store
  useEffect(() => {
    if (hasProject && location.pathname !== '/') {
      setLastRoute(location.pathname)
    }
  }, [location.pathname, hasProject, setLastRoute])

  // Auto-collapse sidebar when entering Review, restore when leaving
  useEffect(() => {
    if (isReviewTab) setReviewSidebarCollapsed(true)
  }, [isReviewTab])

  // Subscribe to classification progress events when a project is open
  useEffect(() => {
    if (!hasProject) return
    const unsubscribe = subscribeToClassificationProgress()
    return unsubscribe
  }, [hasProject, subscribeToClassificationProgress])

  // Refresh metadata + stats on every route change so tabs stay in sync.
  // Uses a small debounce to let the navigation settle before refreshing.
  useEffect(() => {
    const currentHasProject = useWorkflowStore.getState().hasProject
    if (!currentHasProject) return

    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) refreshMetadata()
    }, 50)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  if (reopening) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
          <p className="text-sm text-gray-500">Reopening project…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          collapsed={isReviewTab ? reviewSidebarCollapsed : sidebarCollapsed}
          onToggle={() => isReviewTab ? setReviewSidebarCollapsed(!reviewSidebarCollapsed) : setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
