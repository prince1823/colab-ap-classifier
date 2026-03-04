import type { IPCResponse } from '../../shared/types/ipc';
import type { ProjectMetadata, ProjectMetadataUpdate } from '../../shared/types/project';
import type { CSVPreview, ColumnMapping, ColumnMappingResult, ColumnMappingWithPriority } from '../../shared/types/column-mapping';
import type { ClassificationProgress, ResearchProgress } from '../../shared/types/classification';
import type { TransactionFilter, TransactionStats, PaginatedTransactions, TransactionUpdate } from '../../shared/types/transactions';
import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { ProjectSupplierView, SupplierConfirmationStatus } from '../../shared/types/suppliers';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types/rules';
import type { ChangeLog } from '../../shared/types/changelog';

/**
 * Generic invoke wrapper that unwraps the IPCResponse envelope.
 * Throws on `success: false`.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: IPCResponse<T> = await window.electronAPI.invoke(channel, ...args);
  if (!result.success) {
    throw new Error(result.error || `IPC call failed: ${channel}`);
  }
  return result.data as T;
}

/**
 * Event listener wrapper. Returns an unsubscribe function.
 */
function on<T>(channel: string, callback: (data: T) => void): () => void {
  return window.electronAPI.on(channel, (data: unknown) => callback(data as T));
}

/**
 * Typed IPC client aligned to new architecture.
 */
export const ipc = {
  // ── Project (9 channels) ──
  project: {
    new: (name: string, filePath?: string) =>
      invoke<{ filePath: string; name: string } | null>('project:new', name, filePath),
    open: (filePath?: string) =>
      invoke<{ filePath: string; name: string } | null>('project:open', filePath),
    close: () => invoke<void>('project:close'),
    getSetting: (key: string) => invoke<unknown>('project:getSetting', key),
    setSetting: (key: string, value: unknown) => invoke<void>('project:setSetting', key, value),
    deleteSetting: (key: string) => invoke<void>('project:deleteSetting', key),
    getAllSettings: () => invoke<Record<string, unknown>>('project:getAllSettings'),
    // Compatibility shims
    getMetadata: () => invoke<ProjectMetadata>('project:getMetadata'),
    updateMetadata: (updates: ProjectMetadataUpdate) =>
      invoke<void>('project:updateMetadata', updates),
  },

  // ── Ingest (5 channels) ──
  ingest: {
    selectFile: () => invoke<string | null>('ingest:selectFile'),
    parseCSV: (filePath: string) =>
      invoke<CSVPreview>('ingest:parseCSV', filePath),
    suggestMappings: (columns: string[], sampleRows: Record<string, string>[]) =>
      invoke<ColumnMappingResult>('ingest:suggestMappings', columns, sampleRows),
    importCSV: (filePath: string, mapping?: ColumnMapping) =>
      invoke<{ rowsInserted: number; uploadId: string }>('ingest:importCSV', filePath, mapping),
    getUpload: () =>
      invoke<{ id: string; fileName: string; columnMappings: ColumnMappingWithPriority | null; rowCount: number } | null>('ingest:getUpload'),
  },

  // ── Classification (2 channels + 1 event) ──
  classification: {
    start: () => invoke<void>('classification:start'),
    cancel: () => invoke<void>('classification:cancel'),
    onProgress: (callback: (progress: ClassificationProgress) => void) =>
      on<ClassificationProgress>('classification:progress', callback),
  },

  // ── Transactions (4 channels) ──
  transactions: {
    query: (filters?: TransactionFilter) =>
      invoke<PaginatedTransactions>('transactions:query', filters),
    stats: () => invoke<TransactionStats>('transactions:stats'),
    getColumns: () => invoke<string[]>('transactions:getColumns'),
    update: (update: TransactionUpdate) =>
      invoke<void>('transactions:update', update),
  },

  // ── Taxonomy (5 channels) ──
  taxonomy: {
    getNodes: () => invoke<TaxonomyNode[]>('taxonomy:getNodes'),
    addNode: (fullPath: string, description?: string) =>
      invoke<TaxonomyNode>('taxonomy:addNode', fullPath, description),
    updateNode: (nodeId: string, updates: { description?: string }) =>
      invoke<void>('taxonomy:updateNode', nodeId, updates),
    deleteNode: (nodeId: string) =>
      invoke<void>('taxonomy:deleteNode', nodeId),
    importFromFile: (filePath: string) =>
      invoke<{ nodeCount: number }>('taxonomy:importFromFile', filePath),
  },

  // ── Suppliers (3 channels + research) ──
  suppliers: {
    list: () => invoke<ProjectSupplierView[]>('suppliers:list'),
    update: (supplierId: string, newName: string) =>
      invoke<void>('suppliers:update', supplierId, newName),
    confirm: (id: string, status: SupplierConfirmationStatus) =>
      invoke<void>('suppliers:confirm', id, status),
    researchAll: () => invoke<void>('suppliers:researchAll'),
    researchSingle: (supplierName: string) =>
      invoke<unknown>('suppliers:researchSingle', supplierName),
    onResearchProgress: (callback: (progress: ResearchProgress) => void) =>
      on<ResearchProgress>('suppliers:research:progress', callback),
  },

  // ── Rules (4 channels) ──
  rules: {
    list: () => invoke<OverrideRule[]>('rules:list'),
    create: (input: OverrideRuleCreate) =>
      invoke<{ id: string }>('rules:create', input),
    update: (ruleId: string, updates: OverrideRuleUpdate) =>
      invoke<void>('rules:update', ruleId, updates),
    delete: (ruleId: string) => invoke<void>('rules:delete', ruleId),
  },

  // ── Changelog (2 channels) ──
  changelog: {
    list: () => invoke<ChangeLog[]>('changelog:list'),
    revert: (changeId: string) => invoke<string>('changelog:revert', changeId),
  },

  // ── Export (1 channel) ──
  export: {
    csv: () => invoke<{ rowsExported: number } | null>('export:csv'),
  },
};
