import { ipc } from './ipc'
import { useWorkflowStore } from '../stores/workflowStore'
import type { ProjectSupplierView, SupplierInfo } from '../../shared/types/suppliers'
import type { ResearchProgress } from '../../shared/types/classification'

/**
 * Module-level research runner. Runs batch research outside any React component
 * so that page navigation does not interrupt ongoing research.
 *
 * Progress is pushed to workflowStore (global Zustand) and read by SuppliersPage.
 */

let abortFlag = false
let isRunning = false

function setProgress(progress: ResearchProgress | null) {
  useWorkflowStore.getState().setResearchProgress(progress)
}

export function isResearchRunning(): boolean {
  return isRunning
}

export function cancelResearch(): void {
  abortFlag = true
}

/**
 * Research a single supplier. Updates workflowStore progress.
 * Returns the SupplierInfo on success, or null on failure.
 */
export async function researchSingle(supplier: ProjectSupplierView): Promise<SupplierInfo | null> {
  if (!isRunning) {
    setProgress({
      status: 'running',
      totalSuppliers: 1,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: supplier.supplierName,
      currentStep: 'Researching',
    })
  }
  try {
    const info = await ipc.suppliers.researchSingle(supplier.id)
    if (!isRunning) {
      setProgress({
        status: 'completed',
        totalSuppliers: 1,
        processedSuppliers: 1,
        percentage: 100,
        currentSupplier: supplier.supplierName,
        currentStep: 'Done',
      })
      setTimeout(() => setProgress(null), 3000)
    }
    return info as SupplierInfo
  } catch (e) {
    if (!isRunning) {
      setProgress({
        status: 'failed',
        totalSuppliers: 1,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: supplier.supplierName,
        currentStep: e instanceof Error ? e.message : 'Research failed',
      })
      setTimeout(() => setProgress(null), 3000)
    }
    return null
  }
}

/**
 * Batch-research a list of suppliers. Runs sequentially, updating progress
 * in the global store. Survives page navigation.
 *
 * Returns a map of supplierId → SupplierInfo for successful results.
 * The caller (SuppliersPage) can use this to update local state if still mounted.
 */
export async function researchBatch(
  selected: ProjectSupplierView[],
  onEachComplete?: (supplierId: string, info: SupplierInfo) => void,
): Promise<Map<string, SupplierInfo>> {
  if (isRunning) return new Map()

  isRunning = true
  abortFlag = false
  const results = new Map<string, SupplierInfo>()
  const total = selected.length

  try {
    for (let i = 0; i < total; i++) {
      if (abortFlag) {
        setProgress({
          status: 'cancelled',
          totalSuppliers: total,
          processedSuppliers: i,
          percentage: Math.round((i / total) * 100),
          currentSupplier: null,
          currentStep: 'Cancelled',
        })
        setTimeout(() => setProgress(null), 3000)
        return results
      }

      const s = selected[i]
      setProgress({
        status: 'running',
        totalSuppliers: total,
        processedSuppliers: i,
        percentage: Math.round((i / total) * 100),
        currentSupplier: s.supplierName,
        currentStep: `Researching ${i + 1} of ${total}`,
      })

      try {
        const info = await ipc.suppliers.researchSingle(s.id) as SupplierInfo
        results.set(s.id, info)
        onEachComplete?.(s.id, info)
      } catch {
        // continue with next supplier
      }
    }

    setProgress({
      status: 'completed',
      totalSuppliers: total,
      processedSuppliers: total,
      percentage: 100,
      currentSupplier: null,
      currentStep: 'Done',
    })
    setTimeout(() => setProgress(null), 3000)

    return results
  } finally {
    isRunning = false
  }
}
