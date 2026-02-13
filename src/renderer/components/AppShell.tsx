import { useState, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import Sidebar from './Sidebar'
import WorkflowTabs from './WorkflowTabs'
import ClassificationBanner from './classification/ClassificationBanner'
import { useWorkflowStore } from '../stores/workflowStore'

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { isClassifying, subscribeToClassificationProgress, hasProject } = useWorkflowStore()

  // Subscribe to classification progress events when a project is open
  useEffect(() => {
    if (!hasProject) return
    const unsubscribe = subscribeToClassificationProgress()
    return unsubscribe
  }, [hasProject, subscribeToClassificationProgress])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
        <main className="flex flex-1 flex-col overflow-hidden">
          <WorkflowTabs />
          {isClassifying && <ClassificationBanner />}
          <div className="flex-1 overflow-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
