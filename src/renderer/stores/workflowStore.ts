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
    // Always close backend project (may be open even if frontend metadata was never set)
    try { await ipc.project.close() } catch { /* already closed */ }
    set({
      projectMetadata: null,
      classifiedRows: 0,
      classificationProgress: null,
      ...deriveState(null, 0, null),
    })

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
    // Always close backend project (may be open even if frontend metadata was never set)
    try { await ipc.project.close() } catch { /* already closed */ }
    set({
      projectMetadata: null,
      classifiedRows: 0,
      classificationProgress: null,
      ...deriveState(null, 0, null),
    })

    await ipc.project.open(filePath)

    // Fetch metadata — may fail on older DBs with schema mismatches
    let metadata: ProjectMetadata | null = null
    try {
      metadata = await ipc.project.getMetadata()
    } catch (e) {
      console.warn('[loadProject] getMetadata failed, using fallback:', e)
      // Build a minimal metadata object so the project still opens
      const name = filePath.split('/').pop()?.replace(/\.c91$/, '') ?? 'Unknown'
      metadata = {
        name,
        filePath,
        companyContext: null,
        columnMappings: null,
        invoiceGroupingColumns: null,
        tailSpendThreshold: 10000,
        taxonomyName: null,
        createdAt: null,
      }
    }

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

    const derived = deriveState(metadata, classifiedRows, progress)
    console.log('[loadProject] metadata:', JSON.stringify(metadata, null, 2))
    console.log('[loadProject] classifiedRows:', classifiedRows)
    console.log('[loadProject] derived:', JSON.stringify(derived))

    set({
      projectMetadata: metadata,
      classifiedRows,
      classificationProgress: progress,
      ...derived,
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
      // Guard: only refresh if a project is actually open
      const isOpen = await ipc.project.isOpen()
      if (!isOpen) return

      const metadata = await ipc.project.getMetadata()
      if (!metadata) return // Keep existing state if metadata comes back null

      // Refresh stats — keep previous classifiedRows if stats call fails
      let classifiedRows = get().classifiedRows
      try {
        const stats = await ipc.transactions.stats()
        classifiedRows = stats.classifiedRows
      } catch {
        // No transactions yet — keep previous value
      }
      const { classificationProgress } = get()
      set({
        projectMetadata: metadata,
        classifiedRows,
        ...deriveState(metadata, classifiedRows, classificationProgress),
      })
    } catch {
      // IPC failed — keep existing state intact, don't reset anything
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
