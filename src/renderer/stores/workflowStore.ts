import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ipc } from '../lib/ipc'
import type { ProjectMetadata } from '../../shared/types/project'
import type { ClassificationProgress } from '../../shared/types/classification'
import type { CSVPreviewWithMappings, CanonicalColumnMapping } from '../../shared/types/canonicalization'

interface UploadDraft {
  filePath: string | null
  preview: CSVPreviewWithMappings | null
  mapping: CanonicalColumnMapping
  groupingColumns: string[]
  showUploader: boolean
}

interface PivotSettings {
  rowDimensions: string[]
  valueDimension: string
  aggregation: 'sum' | 'count' | 'average'
  filterState: Record<string, string[]>
}

const defaultPivotSettings: PivotSettings = {
  rowDimensions: ['supplier_name', 'gl_description'],
  valueDimension: 'spend_amount',
  aggregation: 'sum',
  filterState: {},
}

interface ReviewFilterState {
  activeFilters: Record<string, string[]>
  filterState: Record<string, string[]>
  filterGroupOperators: Record<string, string>
  filterConnectors: Record<string, 'AND' | 'OR'>
  filterCombinator: 'AND' | 'OR'
  showFilterPanel: boolean
}

const defaultReviewFilters: ReviewFilterState = {
  activeFilters: {},
  filterState: {
    supplier: [],
    classificationL1: [],
    classificationL2: [],
    classificationL3: [],
    classificationL4: [],
    glDescription: [],
    company: [],
    year: [],
    quarter: [],
    month: [],
    costCenter: [],
    country: [],
    lineDescription: [],
  },
  filterGroupOperators: {},
  filterConnectors: {},
  filterCombinator: 'AND',
  showFilterPanel: false,
}

interface WorkflowState {
  // Core state
  projectMetadata: ProjectMetadata | null
  classificationProgress: ClassificationProgress | null
  classifiedRows: number
  dataReviewed: boolean

  // Upload draft (persists across tab navigation)
  uploadDraft: UploadDraft

  // Pivot table settings (persists across tab navigation)
  pivotSettings: PivotSettings

  // Review tab filter state (persists across tab navigation, resets on project close)
  reviewFilters: ReviewFilterState

  // Persisted route — restored on reload
  lastRoute: string | null

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
  setUploadDraft: (draft: Partial<UploadDraft>) => void
  clearUploadDraft: () => void
  setPivotSettings: (settings: Partial<PivotSettings>) => void
  setReviewFilters: (filters: Partial<ReviewFilterState>) => void
  clearReviewFilters: () => void
  markDataReviewed: () => void
  setLastRoute: (route: string) => void
  reset: () => void
}

function deriveState(metadata: ProjectMetadata | null, classifiedRows: number, progress: ClassificationProgress | null, dataReviewed = false) {
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
    hasReviewedData: dataReviewed,
    isClassifying,
    hasClassifiedData,
  }
}

const defaultUploadDraft: UploadDraft = {
  filePath: null,
  preview: null,
  mapping: {},
  groupingColumns: [],
  showUploader: true,
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      projectMetadata: null,
      classificationProgress: null,
      classifiedRows: 0,
      dataReviewed: false,
      uploadDraft: { ...defaultUploadDraft },
      pivotSettings: { ...defaultPivotSettings },
      reviewFilters: { ...defaultReviewFilters },
      lastRoute: null,

      ...deriveState(null, 0, null, false),

      createProject: async (name: string) => {
        // Always close backend project (may be open even if frontend metadata was never set)
        try { await ipc.project.close() } catch { /* already closed */ }
        set({
          projectMetadata: null,
          classifiedRows: 0,
          classificationProgress: null,
          uploadDraft: { ...defaultUploadDraft },
          pivotSettings: { ...defaultPivotSettings },
          reviewFilters: { ...defaultReviewFilters },
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
          uploadDraft: { ...defaultUploadDraft },
          pivotSettings: { ...defaultPivotSettings },
          reviewFilters: { ...defaultReviewFilters },
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
          uploadDraft: { ...defaultUploadDraft },
          pivotSettings: { ...defaultPivotSettings },
          reviewFilters: { ...defaultReviewFilters },
          lastRoute: null,
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
          const { classificationProgress, dataReviewed } = get()
          set({
            projectMetadata: metadata,
            classifiedRows,
            ...deriveState(metadata, classifiedRows, classificationProgress, dataReviewed),
          })
        } catch {
          // IPC failed — keep existing state intact, don't reset anything
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
        // Track cancelled/failed runIds so stale in-flight progress events
        // (from research or classification callbacks completing after cancel)
        // don't overwrite the reset UI state.
        const terminalRunIds = new Set<string>()

        const unsubscribe = ipc.classification.onProgress((progress) => {
          // If this runId already reached a terminal state, ignore any active-status events
          if (terminalRunIds.has(progress.runId)) {
            if (progress.status === 'pending' || progress.status === 'researching' || progress.status === 'classifying') {
              return // Drop stale event
            }
          }

          // Remember when a run reaches a terminal state
          if (progress.status === 'cancelled' || progress.status === 'failed' || progress.status === 'completed') {
            terminalRunIds.add(progress.runId)
          }

          const { projectMetadata, classifiedRows, dataReviewed } = get()
          set({
            classificationProgress: progress,
            ...deriveState(projectMetadata, classifiedRows, progress, dataReviewed),
          })

          if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
            // Refresh stats so classifiedRows updates (hasClassifiedData derives from it)
            // Progress stays set so the UI can show the completed/failed banner
            ipc.transactions.stats().then((stats) => {
              console.log('[WorkflowStore] Post-classification stats:', stats)
              set({
                classifiedRows: stats.classifiedRows,
                ...deriveState(get().projectMetadata, stats.classifiedRows, get().classificationProgress, get().dataReviewed),
              })
            }).catch((e) => {
              console.error('[WorkflowStore] Failed to refresh stats:', e)
            })

            // Clean up after a delay to avoid accumulating stale runIds
            setTimeout(() => terminalRunIds.delete(progress.runId), 60_000)
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

      setUploadDraft: (draft) => {
        set({ uploadDraft: { ...get().uploadDraft, ...draft } })
      },

      clearUploadDraft: () => {
        set({ uploadDraft: { ...defaultUploadDraft } })
      },

      setPivotSettings: (settings) => {
        set({ pivotSettings: { ...get().pivotSettings, ...settings } })
      },

      setReviewFilters: (filters) => {
        set({ reviewFilters: { ...get().reviewFilters, ...filters } })
      },

      clearReviewFilters: () => {
        set({ reviewFilters: { ...defaultReviewFilters } })
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
          uploadDraft: { ...defaultUploadDraft },
          pivotSettings: { ...defaultPivotSettings },
          reviewFilters: { ...defaultReviewFilters },
          lastRoute: null,
          ...deriveState(null, 0, null, false),
        })
      },
    }),
    {
      name: 'c91-workflow',
      version: 1,
      partialize: (state) => ({
        projectMetadata: state.projectMetadata,
        lastRoute: state.lastRoute,
      }),
    }
  )
)
