import { create } from 'zustand'
import { ipc } from '../lib/ipc'
import type { ProjectMetadata } from '../../shared/types/project'
import type { ClassificationProgress } from '../../shared/types/classification'

interface WorkflowState {
  // Core state
  projectMetadata: ProjectMetadata | null
  classificationProgress: ClassificationProgress | null
  classifiedRows: number

  // Derived booleans
  hasProject: boolean
  hasCompanyContext: boolean
  hasTaxonomy: boolean
  hasUploadedData: boolean
  hasCanonicalizedData: boolean
  hasReviewedData: boolean
  isClassifying: boolean
  hasClassifiedData: boolean

  // Actions
  createProject: (name: string) => Promise<void>
  loadProject: (filePath: string) => Promise<void>
  closeProject: () => Promise<void>
  refreshMetadata: () => Promise<void>
  refreshStats: () => Promise<void>
  subscribeToClassificationProgress: () => () => void
  setClassificationProgress: (progress: ClassificationProgress | null) => void
  reset: () => void
}

function deriveState(metadata: ProjectMetadata | null, classifiedRows: number, progress: ClassificationProgress | null) {
  const hasProject = metadata !== null
  const hasCompanyContext = metadata?.companyContext !== null && metadata?.companyContext !== undefined
  const hasTaxonomy = metadata?.taxonomyName !== null && metadata?.taxonomyName !== undefined
  const hasUploadedData = metadata?.columnMappings !== null && metadata?.columnMappings !== undefined
  const hasCanonicalizedData = hasUploadedData
  // Consider classified if we have rows OR if the pipeline just completed
  const hasClassifiedData = classifiedRows > 0 || (progress !== null && progress.status === 'completed')
  const isClassifying = progress !== null &&
    (progress.status === 'pending' || progress.status === 'researching' || progress.status === 'classifying')

  return {
    hasProject,
    hasCompanyContext,
    hasTaxonomy,
    hasUploadedData,
    hasCanonicalizedData,
    hasReviewedData: false,
    isClassifying,
    hasClassifiedData,
  }
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  projectMetadata: null,
  classificationProgress: null,
  classifiedRows: 0,

  ...deriveState(null, 0, null),

  createProject: async (name: string) => {
    await ipc.project.new(name)
    const metadata = await ipc.project.getMetadata()
    set({
      projectMetadata: metadata,
      classifiedRows: 0,
      classificationProgress: null,
      ...deriveState(metadata, 0, null),
    })
  },

  loadProject: async (filePath: string) => {
    await ipc.project.open(filePath)
    const metadata = await ipc.project.getMetadata()

    let classifiedRows = 0
    try {
      const stats = await ipc.transactions.stats()
      classifiedRows = stats.classifiedRows
    } catch {
      // No transactions yet
    }

    let progress: ClassificationProgress | null = null
    try {
      const run = await ipc.classification.getStatus()
      if (run && (run.status === 'pending' || run.status === 'researching' || run.status === 'classifying')) {
        progress = {
          runId: run.id,
          status: run.status,
          phase: run.status === 'researching' ? 'researching' : 'classifying',
          total: run.progressTotal,
          processed: run.progressProcessed,
          percentage: run.progressPercentage,
          currentStep: '',
        }
      }
    } catch {
      // No classification running
    }

    set({
      projectMetadata: metadata,
      classifiedRows,
      classificationProgress: progress,
      ...deriveState(metadata, classifiedRows, progress),
    })
  },

  closeProject: async () => {
    try {
      await ipc.project.close()
    } catch {
      // Already closed
    }
    set({
      projectMetadata: null,
      classifiedRows: 0,
      classificationProgress: null,
      ...deriveState(null, 0, null),
    })
  },

  refreshMetadata: async () => {
    try {
      const metadata = await ipc.project.getMetadata()
      const { classifiedRows, classificationProgress } = get()
      set({
        projectMetadata: metadata,
        ...deriveState(metadata, classifiedRows, classificationProgress),
      })
    } catch {
      // Project might not be open
    }
  },

  refreshStats: async () => {
    try {
      const stats = await ipc.transactions.stats()
      const { projectMetadata, classificationProgress } = get()
      set({
        classifiedRows: stats.classifiedRows,
        ...deriveState(projectMetadata, stats.classifiedRows, classificationProgress),
      })
    } catch {
      // No transactions
    }
  },

  subscribeToClassificationProgress: () => {
    const unsubscribe = ipc.classification.onProgress((progress) => {
      const { projectMetadata, classifiedRows } = get()
      set({
        classificationProgress: progress,
        ...deriveState(projectMetadata, classifiedRows, progress),
      })

      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
        // Refresh stats so classifiedRows updates (hasClassifiedData derives from it)
        // Progress stays set so the UI can show the completed/failed banner
        ipc.transactions.stats().then((stats) => {
          console.log('[WorkflowStore] Post-classification stats:', stats)
          set({
            classifiedRows: stats.classifiedRows,
            ...deriveState(get().projectMetadata, stats.classifiedRows, get().classificationProgress),
          })
        }).catch((e) => {
          console.error('[WorkflowStore] Failed to refresh stats:', e)
        })
      }
    })
    return unsubscribe
  },

  setClassificationProgress: (progress) => {
    const { projectMetadata, classifiedRows } = get()
    set({
      classificationProgress: progress,
      ...deriveState(projectMetadata, classifiedRows, progress),
    })
  },

  reset: () => {
    set({
      projectMetadata: null,
      classifiedRows: 0,
      classificationProgress: null,
      ...deriveState(null, 0, null),
    })
  },
}))
