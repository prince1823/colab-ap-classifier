import { createContext, useContext, ReactNode } from 'react'
import { useWorkflowStore } from '../stores/workflowStore'

interface WorkflowStateContextType {
  hasProject: boolean
  hasCompanyContext: boolean
  hasTaxonomy: boolean
  hasUploadedData: boolean
  hasCanonicalizedData: boolean
  hasReviewedData: boolean
  isClassifying: boolean
  hasClassifiedData: boolean
}

const WorkflowStateContext = createContext<WorkflowStateContextType | undefined>(undefined)

export function WorkflowStateProvider({ children }: { children: ReactNode }) {
  const workflowState = useWorkflowStore()

  return (
    <WorkflowStateContext.Provider value={workflowState}>
      {children}
    </WorkflowStateContext.Provider>
  )
}

export function useWorkflowState() {
  const context = useContext(WorkflowStateContext)
  if (context === undefined) {
    throw new Error('useWorkflowState must be used within a WorkflowStateProvider')
  }
  return context
}
