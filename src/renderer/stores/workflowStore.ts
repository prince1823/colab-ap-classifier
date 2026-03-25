import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import { usePivotStore } from './pivotStore'
import { useSupplierFilterStore } from './supplierFilterStore'
import type { ProjectMetadata } from '../../shared/types/project'
import type { ClassificationProgress, QCProgress, ResearchProgress } from '../../shared/types/classification'

interface WorkflowState {
  // Core state
  projectMetadata: ProjectMetadata | null
  classificationProgress: ClassificationProgress | null
  qcProgress: QCProgress | null
  researchProgress: ResearchProgress | null

  // Persisted for auto-reopen only — a plain string, never a partial cast of ProjectMetadata
  projectFilePath: string | null

  // Persisted route — restored on reload
  lastRoute: string | null

  // Derived booleans
  hasProject: boolean
  isClassifying: boolean

  // Gate booleans (refreshed via refreshGateState)
  hasTaxonomy: boolean
  hasUploadedData: boolean
  hasConfirmedSuppliers: boolean
  hasClassifiedRows: boolean

  // Cached counts for gates
  taxonomyNodeCount: number
  totalRows: number
  classifiedRows: number
  confirmedSupplierCount: number

  // Actions
  createProject: (name: string) => Promise<{ needsSupplierUniverseSetup?: boolean; missingSupplierUniversePath?: string }>
  loadProject: (filePath: string) => Promise<{ needsSupplierUniverseSetup?: boolean; missingSupplierUniversePath?: string }>
  finalizeProjectOpen: () => Promise<void>
  closeProject: () => Promise<void>
  refreshMetadata: () => Promise<void>
  refreshGateState: () => Promise<void>
  subscribeToClassificationProgress: () => () => void
  subscribeToQCProgress: () => () => void
  setClassificationProgress: (progress: ClassificationProgress | null) => void
  setResearchProgress: (progress: ResearchProgress | null) => void
  subscribeToResearchProgress: () => () => void
  setLastRoute: (route: string) => void
  reset: () => void
}

const INITIAL_GATE_STATE = {
  hasTaxonomy: false,
  hasUploadedData: false,
  hasConfirmedSuppliers: false,
  hasClassifiedRows: false,
  taxonomyNodeCount: 0,
  totalRows: 0,
  classifiedRows: 0,
  confirmedSupplierCount: 0,
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set) => ({
      projectMetadata: null,
      classificationProgress: null,
      qcProgress: null,
      researchProgress: null,
      projectFilePath: null,
      lastRoute: null,
      hasProject: false,
      isClassifying: false,
      ...INITIAL_GATE_STATE,

      createProject: async (name: string) => {
        try { await ipc.project.close() } catch { /* already closed */ }
        set({ projectMetadata: null, classificationProgress: null, hasProject: false, isClassifying: false, ...INITIAL_GATE_STATE })

        const result = await ipc.project.new(name)
        if (result?.needsSupplierUniverseSetup) {
          return { needsSupplierUniverseSetup: true, missingSupplierUniversePath: result.missingSupplierUniversePath }
        }
        const metadata = await ipc.project.getMetadata()
        set({
          projectMetadata: metadata,
          projectFilePath: metadata?.filePath ?? null,
          classificationProgress: null,
          hasProject: metadata !== null,
          isClassifying: false,
        })
        return {}
      },

      loadProject: async (filePath: string) => {
        try { await ipc.project.close() } catch { /* already closed */ }
        set({ projectMetadata: null, classificationProgress: null, hasProject: false, isClassifying: false, ...INITIAL_GATE_STATE })
        // Clear page state so stale filters from previous project don't carry over
        usePivotStore.getState().reset()
        useSupplierFilterStore.getState().reset()

        const result = await ipc.project.open(filePath)
        if (result?.needsSupplierUniverseSetup) {
          return { needsSupplierUniverseSetup: true, missingSupplierUniversePath: result.missingSupplierUniversePath }
        }

        let metadata: ProjectMetadata | null = null
        try {
          metadata = await ipc.project.getMetadata()
        } catch (e) {
          showError('Failed to load project metadata', e)
          metadata = {
            id: '',
            projectName: filePath.split('/').pop()?.replace(/\.c91$/, '') ?? 'Unknown',
            filePath,
            createdAt: '',
            companyContext: null,
            taxonomyName: null,
            tailSpendThreshold: 10000,
          }
        }

        set({
          projectMetadata: metadata,
          projectFilePath: metadata?.filePath ?? null,
          classificationProgress: null,
          hasProject: metadata !== null,
          isClassifying: false,
        })
        return {}
      },

      finalizeProjectOpen: async () => {
        // Ensure supplier universe is open on the main process, then fetch metadata
        await ipc.project.finalizeOpen()
        let metadata: ProjectMetadata | null = null
        try {
          metadata = await ipc.project.getMetadata()
        } catch (e) {
          showError('Failed to load project metadata', e)
        }
        set({
          projectMetadata: metadata,
          projectFilePath: metadata?.filePath ?? null,
          classificationProgress: null,
          hasProject: metadata !== null,
          isClassifying: false,
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
          projectFilePath: null,
          classificationProgress: null,
          lastRoute: null,
          hasProject: false,
          isClassifying: false,
          ...INITIAL_GATE_STATE,
        })
      },

      refreshMetadata: async () => {
        try {
          const metadata = await ipc.project.getMetadata()
          if (!metadata) return
          set({ projectMetadata: metadata, hasProject: true })
        } catch (e) {
          showError('Failed to refresh project metadata', e)
        }
      },

      refreshGateState: async () => {
        try {
          const [stats, nodeCount, suppliers] = await Promise.all([
            ipc.transactions.stats().catch((e) => { showError('Failed to load transaction stats', e); return null }),
            ipc.taxonomy.getNodeCount().catch((e) => { showError('Failed to load taxonomy count', e); return 0 }),
            ipc.suppliers.list().catch((e) => { showError('Failed to load suppliers', e); return [] as Awaited<ReturnType<typeof ipc.suppliers.list>> }),
          ])

          const totalRows = stats?.totalRows ?? 0
          const classifiedRows = stats?.classifiedRows ?? 0
          const confirmedSupplierCount = suppliers.filter(
            (s) => s.confirmationStatus === 'confirmed'
          ).length

          set({
            hasTaxonomy: nodeCount > 0,
            hasUploadedData: totalRows > 0,
            hasConfirmedSuppliers: confirmedSupplierCount > 0,
            hasClassifiedRows: classifiedRows > 0,
            taxonomyNodeCount: nodeCount,
            totalRows,
            classifiedRows,
            confirmedSupplierCount,
          })
        } catch (e) {
          showError('Failed to refresh workflow state', e)
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

          set({
            classificationProgress: progress,
            isClassifying: progress.status === 'running',
          })
        })
        return unsubscribe
      },

      subscribeToQCProgress: () => {
        let reachedTerminal = false

        const unsubscribe = ipc.qc.onProgress((progress) => {
          if (reachedTerminal && progress.status === 'running') {
            return
          }

          if (progress.status === 'cancelled' || progress.status === 'failed' || progress.status === 'completed') {
            reachedTerminal = true
          } else {
            reachedTerminal = false
          }

          set({ qcProgress: progress })
        })
        return unsubscribe
      },

      setClassificationProgress: (progress) => {
        set({
          classificationProgress: progress,
          isClassifying: progress !== null && progress?.status === 'running',
        })
      },

      setResearchProgress: (progress) => {
        set({ researchProgress: progress })
      },

      subscribeToResearchProgress: () => {
        const unsubscribe = ipc.suppliers.onResearchProgress((progress) => {
          set({ researchProgress: progress })
          if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
            setTimeout(() => {
              set({ researchProgress: null })
            }, 3000)
          }
        })
        return unsubscribe
      },

      setLastRoute: (route: string) => {
        set({ lastRoute: route })
      },

      reset: () => {
        set({
          projectMetadata: null,
          projectFilePath: null,
          classificationProgress: null,
          qcProgress: null,
          researchProgress: null,
          lastRoute: null,
          hasProject: false,
          isClassifying: false,
          ...INITIAL_GATE_STATE,
        })
      },
    }),
    {
      name: 'c91-workflow',
      version: 5,
      partialize: (state) => ({
        projectFilePath: state.projectFilePath,
        lastRoute: state.lastRoute,
      }),
    }
  )
)
