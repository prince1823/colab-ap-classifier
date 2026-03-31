import { ipc } from './ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { ProjectSupplierView, SupplierInfo } from '../../shared/types/suppliers'
import type { ResearchProgress } from '../../shared/types/classification'

/**
 * Returns true if a batch research run is currently in progress.
 * Reads from global store, which is updated via EventBus progress events.
 */
export function isResearchRunning(): boolean {
  return useWorkflowStore.getState().researchProgress?.status === 'running'
}

export function cancelResearch(): void {
  ipc.suppliers.cancelResearch()
}

/**
 * Research a single supplier (from the detail panel).
 * Updates workflowStore progress for the duration of the single call.
 * Returns the SupplierInfo on success, or null on failure.
 */
export async function researchSingle(supplier: ProjectSupplierView): Promise<SupplierInfo | null> {
  const ownsProgress = !isResearchRunning()
  if (ownsProgress) {
    useWorkflowStore.getState().setResearchProgress({
      status: 'running',
      totalSuppliers: 1,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: supplier.supplierName,
      currentStep: 'Researching',
    } satisfies ResearchProgress)
  }
  try {
    const info = await ipc.suppliers.researchSingle(supplier.id)
    if (ownsProgress) {
      useWorkflowStore.getState().setResearchProgress({
        status: 'completed',
        totalSuppliers: 1,
        processedSuppliers: 1,
        percentage: 100,
        currentSupplier: supplier.supplierName,
        currentStep: 'Done',
      } satisfies ResearchProgress)
      setTimeout(() => useWorkflowStore.getState().setResearchProgress(null), 3000)
    }
    return info as SupplierInfo
  } catch (e) {
    if (ownsProgress) {
      useWorkflowStore.getState().setResearchProgress({
        status: 'failed',
        totalSuppliers: 1,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: supplier.supplierName,
        currentStep: e instanceof Error ? e.message : 'Research failed',
      } satisfies ResearchProgress)
      setTimeout(() => useWorkflowStore.getState().setResearchProgress(null), 3000)
    }
    return null
  }
}
