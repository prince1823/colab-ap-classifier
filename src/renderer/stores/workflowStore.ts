import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ipc } from '../lib/ipc'
import type { ProjectMetadata } from '../../shared/types/project'
import type { ClassificationProgress } from '../../shared/types/classification'

interface WorkflowState {
  // Core state
  projectMetadata: ProjectMetadata | null
  classificationProgress: ClassificationProgress | null
  classifiedRows: number
  dataReviewed: boolean

  // Persisted route — restored on reload
  lastRoute: string | null

  // Derived booleans
  hasProject: boolean
  hasCompanyContext: boolean
  hasTaxonomy: boolean
  hasUploadedData: boolean
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
  markDataReviewed: () => void
  setLastRoute: (route: string) => void
  reset: () => void
}

function deriveState(metadata: ProjectMetadata | null, classifiedRows: number, progress: ClassificationProgress | null, dataReviewed = false, taxonomyNodeCount = 0) {
  const hasProject = metadata !== null
  const hasCompanyContext = metadata?.companyContext !== null && metadata?.companyContext !== undefined
  const hasTaxonomy = taxonomyNodeCount > 0
  const hasUploadedData = metadata?.columnMapping !== null && metadata?.columnMapping !== undefined
  const hasClassifiedData = classifiedRows > 0 || (progress !== null && progress.status === 'completed')
  const isClassifying = progress !== null && progress.status === 'running'

  return {
    hasProject,
    hasCompanyContext,
    hasTaxonomy,
    hasUploadedData,
    hasReviewedData: dataReviewed,
    isClassifying,
    hasClassifiedData,
  }
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      projectMetadata: null,
      classificationProgress: null,
      classifiedRows: 0,
      dataReviewed: false,
      lastRoute: null,

      ...deriveState(null, 0, null, false),

      createProject: async (name: string) => {
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
        try { await ipc.project.close() } catch { /* already closed */ }
        set({
          projectMetadata: null,
          classifiedRows: 0,
          classificationProgress: null,
          ...deriveState(null, 0, null),
        })

        await ipc.project.open(filePath)

        let metadata: ProjectMetadata | null = null
        try {
          metadata = await ipc.project.getMetadata()
        } catch (e) {
          console.warn('[loadProject] getMetadata failed, using fallback:', e)
          metadata = {
            id: '',
            projectName: filePath.split('/').pop()?.replace(/\.c91$/, '') ?? 'Unknown',
            filePath,
            createdAt: '',
            companyContext: null,
            taxonomyName: null,
            tailSpendThreshold: 10000,
            columnMapping: null,
          }
        }

        let classifiedRows = 0
        try {
          const stats = await ipc.transactions.stats()
          classifiedRows = stats.classifiedRows
        } catch {
          // No transactions yet
        }
        let taxonomyNodeCount = 0
        try {
          taxonomyNodeCount = await ipc.taxonomy.getNodeCount()
        } catch {
          // No taxonomy yet
        }

        const derived = deriveState(metadata, classifiedRows, null, false, taxonomyNodeCount)
        console.log('[loadProject] metadata:', JSON.stringify(metadata, null, 2))
        console.log('[loadProject] classifiedRows:', classifiedRows)
        console.log('[loadProject] derived:', JSON.stringify(derived))

        set({
          projectMetadata: metadata,
          classifiedRows,
          classificationProgress: null,
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
          lastRoute: null,
          ...deriveState(null, 0, null),
        })
      },

      refreshMetadata: async () => {
        try {
          const metadata = await ipc.project.getMetadata()
          if (!metadata) return

          let classifiedRows = get().classifiedRows
          try {
            const stats = await ipc.transactions.stats()
            classifiedRows = stats.classifiedRows
          } catch {
            // No transactions yet — keep previous value
          }
          let taxonomyNodeCount = 0
          try {
            taxonomyNodeCount = await ipc.taxonomy.getNodeCount()
          } catch {
            // No taxonomy yet
          }
          const { classificationProgress, dataReviewed } = get()
          set({
            projectMetadata: metadata,
            classifiedRows,
            ...deriveState(metadata, classifiedRows, classificationProgress, dataReviewed, taxonomyNodeCount),
          })
        } catch {
          // IPC failed — keep existing state intact
        }
      },

      refreshStats: async () => {
        try {
          const stats = await ipc.transactions.stats()
          const { projectMetadata, classificationProgress, dataReviewed } = get()
          set({
            classifiedRows: stats.classifiedRows,
            ...deriveState(projectMetadata, stats.classifiedRows, classificationProgress, dataReviewed),
          })
        } catch {
          // No transactions
        }
      },

      subscribeToClassificationProgress: () => {
        let reachedTerminal = false

        const unsubscribe = ipc.classification.onProgress((progress) => {
          if (reachedTerminal && progress.status === 'running') {
            return
          }

          if (progress.status === 'cancelled' || progress.status === 'failed' || progress.status === 'completed') {
            reachedTerminal = true
          } else {
            reachedTerminal = false
          }

          const { projectMetadata, classifiedRows, dataReviewed } = get()
          set({
            classificationProgress: progress,
            ...deriveState(projectMetadata, classifiedRows, progress, dataReviewed),
          })

          if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
            ipc.transactions.stats().then((stats) => {
              console.log('[WorkflowStore] Post-classification stats:', stats)
              set({
                classifiedRows: stats.classifiedRows,
                ...deriveState(get().projectMetadata, stats.classifiedRows, get().classificationProgress, get().dataReviewed),
              })
            }).catch((e) => {
              console.error('[WorkflowStore] Failed to refresh stats:', e)
            })
          }
        })
        return unsubscribe
      },

      setClassificationProgress: (progress) => {
        const { projectMetadata, classifiedRows, dataReviewed } = get()
        set({
          classificationProgress: progress,
          ...deriveState(projectMetadata, classifiedRows, progress, dataReviewed),
        })
      },

      markDataReviewed: () => {
        const { projectMetadata, classifiedRows, classificationProgress } = get()
        set({
          dataReviewed: true,
          ...deriveState(projectMetadata, classifiedRows, classificationProgress, true),
        })
      },

      setLastRoute: (route: string) => {
        set({ lastRoute: route })
      },

      reset: () => {
        set({
          projectMetadata: null,
          classifiedRows: 0,
          dataReviewed: false,
          classificationProgress: null,
          lastRoute: null,
          ...deriveState(null, 0, null, false),
        })
      },
    }),
    {
      name: 'c91-workflow',
      version: 3,
      partialize: (state) => ({
        projectMetadata: state.projectMetadata
          ? ({ filePath: state.projectMetadata.filePath } as ProjectMetadata)
          : null,
        lastRoute: state.lastRoute,
      }),
    }
  )
)
