import { create } from 'zustand'

interface WorkflowState {
  hasProject: boolean
  hasCompanyContext: boolean
  hasTaxonomy: boolean
  hasUploadedData: boolean
  hasCanonicalizedData: boolean
  hasReviewedData: boolean
  isClassifying: boolean
  hasClassifiedData: boolean
  setHasProject: (value: boolean) => void
  setHasCompanyContext: (value: boolean) => void
  setHasTaxonomy: (value: boolean) => void
  setHasUploadedData: (value: boolean) => void
  setHasCanonicalizedData: (value: boolean) => void
  setHasReviewedData: (value: boolean) => void
  setIsClassifying: (value: boolean) => void
  setHasClassifiedData: (value: boolean) => void
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  hasProject: true, // Temporarily enabled for testing
  hasCompanyContext: false,
  hasTaxonomy: false,
  hasUploadedData: false,
  hasCanonicalizedData: false,
  hasReviewedData: false,
  isClassifying: false,
  hasClassifiedData: true, // Temporarily enabled for testing Review UI
  setHasProject: (value) => set({ hasProject: value }),
  setHasCompanyContext: (value) => set({ hasCompanyContext: value }),
  setHasTaxonomy: (value) => set({ hasTaxonomy: value }),
  setHasUploadedData: (value) => set({ hasUploadedData: value }),
  setHasCanonicalizedData: (value) => set({ hasCanonicalizedData: value }),
  setHasReviewedData: (value) => set({ hasReviewedData: value }),
  setIsClassifying: (value) => set({ isClassifying: value }),
  setHasClassifiedData: (value) => set({ hasClassifiedData: value }),
}))
