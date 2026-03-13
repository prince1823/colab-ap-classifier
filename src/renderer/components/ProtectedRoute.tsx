import { Navigate } from 'react-router-dom'
import { useWorkflowStore } from '../stores/workflowStore'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const hasProject = useWorkflowStore(s => s.hasProject)

  if (!hasProject) {
    return <Navigate to="/workflow/upload" replace />
  }

  return <>{children}</>
}
