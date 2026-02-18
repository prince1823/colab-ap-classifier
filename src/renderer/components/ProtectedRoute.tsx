import { Navigate } from 'react-router-dom'
import { useWorkflowState } from '../contexts/WorkflowStateContext'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { hasProject } = useWorkflowState()

  if (!hasProject) {
    return <Navigate to="/workflow/upload" replace />
  }

  return <>{children}</>
}
