import type { IPCResponse } from '../../shared/types/ipc';
import type { ProjectMetadata, ProjectMetadataUpdate } from '../../shared/types/project';
import type { CSVPreviewWithMappings } from '../../shared/types/column-mapping';
import type { ClassificationProgress } from '../../shared/types/classification';
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions, TransactionUpdate } from '../../shared/types/transactions';
import type { TaxonomyNode, TaxonomyInfo } from '../../shared/types/taxonomy';
import type { ProjectSupplierView, SupplierUpdateInput } from '../../shared/types/suppliers';
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
 * Typed IPC client — ~30 channels aligned to architecture spec.
 */
export const ipc = {
  // ── Project (5 channels) ──
  project: {
    new: (name: string, filePath?: string) =>
      invoke<{ filePath: string; name: string } | null>('project:new', name, filePath),
    open: (filePath?: string) =>
      invoke<{ filePath: string; name: string } | null>('project:open', filePath),
    close: () => invoke<void>('project:close'),
    getMetadata: () => invoke<ProjectMetadata>('project:getMetadata'),
    updateMetadata: (updates: ProjectMetadataUpdate) =>
      invoke<void>('project:updateMetadata', updates),
  },

  // ── Upload (3 channels) ──
  upload: {
    selectFile: () => invoke<string | null>('upload:selectFile'),
    parsePreview: (filePath: string) =>
      invoke<CSVPreviewWithMappings>('upload:parsePreview', filePath),
    csv: (filePath: string, mapping?: Record<string, string>) =>
      invoke<{ rowsInserted: number }>('upload:csv', filePath, mapping),
  },

  // ── Classification (2 channels + 1 event) ──
  classification: {
    start: () => invoke<{ started: boolean }>('classification:start'),
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
    importFromColabip: (industryName: string) =>
      invoke<void>('taxonomy:importFromColabip', industryName),
  },

  // ── Suppliers (3 channels + research event) ──
  suppliers: {
    list: () => invoke<ProjectSupplierView[]>('suppliers:list'),
    update: (supplierName: string, updates: SupplierUpdateInput) =>
      invoke<void>('suppliers:update', supplierName, updates),
    research: () => invoke<{ started: boolean }>('suppliers:research'),
    onResearchProgress: (callback: (progress: {
      done: number;
      total: number;
      percentage: number;
      currentSupplier: string | null;
      step: string;
    }) => void) => on('suppliers:research:progress', callback),
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

  // ── ColabIP (1 channel) ──
  colabip: {
    listTaxonomies: () => invoke<TaxonomyInfo[]>('colabip:listTaxonomies'),
  },
};
