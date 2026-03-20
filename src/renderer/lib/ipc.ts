import type { IPCResponse } from '../../shared/types/ipc';
import type { IPCChannel, IPCArgs, IPCResult, IPCEventMap } from '../../shared/types/ipc-contract';
import type { ClassificationProgress, ResearchProgress, QCProgress } from '../../shared/types/classification';
import type { LicenseStatus, LicenseActivationResult } from '../../shared/types/license';
import type { SupplierConfirmationStatus, SupplierUpdateInput } from '../../shared/types/suppliers';
import type { TransactionFilter, TransactionUpdate, FilterCondition } from '../../shared/types/transactions';
import type { OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types/rules';
import type { ProjectMetadataUpdate } from '../../shared/types/project';
import type { ColumnMapping, DeriveMappingsSource } from '../../shared/types/column-mapping';

/**
 * Typed invoke wrapper that unwraps the IPCResponse envelope.
 * Channel name, args, and return type are compile-checked via IPCInvokeMap.
 */
async function invoke<K extends IPCChannel>(channel: K, ...args: IPCArgs<K>): Promise<IPCResult<K>> {
  const result: IPCResponse<IPCResult<K>> = await window.electronAPI.invoke(channel, ...args);
  if (!result.success) {
    throw new Error(result.error || `IPC call failed: ${channel}`);
  }
  return result.data as IPCResult<K>;
}

/**
 * Typed event listener wrapper. Channel and callback type are compile-checked via IPCEventMap.
 * Returns an unsubscribe function.
 */
function on<K extends keyof IPCEventMap>(channel: K, callback: (data: IPCEventMap[K]) => void): () => void {
  return window.electronAPI.on(channel, (data: unknown) => callback(data as IPCEventMap[K]));
}

/**
 * Typed IPC client — all types inferred from IPCInvokeMap via channel string.
 */
export const ipc = {
  // ── Project (10 channels) ──
  project: {
    new: (name: string, filePath?: string) =>
      invoke('project:new', name, filePath),
    open: (filePath?: string) =>
      invoke('project:open', filePath),
    close: () => invoke('project:close'),
    finalizeOpen: () => invoke('project:finalizeOpen'),
    getSetting: (key: string) => invoke('project:getSetting', key),
    setSetting: (key: string, value: unknown) => invoke('project:setSetting', key, value),
    deleteSetting: (key: string) => invoke('project:deleteSetting', key),
    getAllSettings: () => invoke('project:getAllSettings'),
    getMetadata: () => invoke('project:getMetadata'),
    updateMetadata: (updates: ProjectMetadataUpdate) =>
      invoke('project:updateMetadata', updates),
  },

  // ── Ingest (8 channels) ──
  ingest: {
    selectFile: () => invoke('ingest:selectFile'),
    parseCSV: (filePath: string) =>
      invoke('ingest:parseCSV', filePath),
    suggestMappings: (columns: string[], sampleRows: Record<string, string>[]) =>
      invoke('ingest:suggestMappings', columns, sampleRows),
    importCSV: (filePath: string, mapping?: ColumnMapping) =>
      invoke('ingest:importCSV', filePath, mapping),
    getUpload: () => invoke('ingest:getUpload'),
    getUploadHistory: () => invoke('ingest:getUploadHistory'),
    deriveMappings: (columns: string[], sampleRows: Record<string, string>[], source: DeriveMappingsSource) =>
      invoke('ingest:deriveMappings', columns, sampleRows, source),
    getExistingCanonicals: () => invoke('ingest:getExistingCanonicals'),
  },

  // ── Classification (3 channels + 1 event) ──
  classification: {
    start: (conditions?: FilterCondition[]) => invoke('classification:start', conditions),
    cancel: () => invoke('classification:cancel'),
    scopeCount: (conditions?: FilterCondition[]) => invoke('classification:scopeCount', conditions),
    onProgress: (callback: (progress: ClassificationProgress) => void) =>
      on('classification:progress', callback),
  },

  // ── QC (3 channels + 1 event) ──
  qc: {
    start: () => invoke('qc:start'),
    cancel: () => invoke('qc:cancel'),
    isRunning: () => invoke('qc:isRunning'),
    onProgress: (callback: (progress: QCProgress) => void) =>
      on('qc:progress', callback),
  },

  // ── Transactions (8 channels) ──
  transactions: {
    query: (filters?: TransactionFilter) =>
      invoke('transactions:query', filters),
    stats: () => invoke('transactions:stats'),
    getColumns: () => invoke('transactions:getColumns'),
    update: (update: TransactionUpdate) =>
      invoke('transactions:update', update),
    queryGrouped: (column: string, filters?: TransactionFilter) =>
      invoke('transactions:queryGrouped', column, filters),
    distinctValues: (column: string, limit?: number) =>
      invoke('transactions:distinctValues', column, limit),
    getIdsByValue: (column: string, value: string, filters?: TransactionFilter) =>
      invoke('transactions:getIdsByValue', column, value, filters),
    pivotAggregation: (dimensions: string[], valueDimension: string, filters?: TransactionFilter) =>
      invoke('transactions:pivotAggregation', dimensions, valueDimension, filters),
    getIdsByConditions: (conditions: FilterCondition[]) =>
      invoke('transactions:getIdsByConditions', conditions),
    getFilterFields: () => invoke('transactions:getFilterFields'),
  },

  // ── Taxonomy (8 channels) ──
  taxonomy: {
    getNodeCount: () => invoke('taxonomy:getNodeCount'),
    getNodes: () => invoke('taxonomy:getNodes'),
    addNode: (fullPath: string, description?: string) =>
      invoke('taxonomy:addNode', fullPath, description),
    updateNode: (nodeId: string, updates: { description?: string }) =>
      invoke('taxonomy:updateNode', nodeId, updates),
    renameNode: (nodeId: string, newName: string) =>
      invoke('taxonomy:renameNode', nodeId, newName),
    mergeNodes: (sourceId: string, targetId: string) =>
      invoke('taxonomy:mergeNodes', sourceId, targetId),
    deleteNode: (nodeId: string) =>
      invoke('taxonomy:deleteNode', nodeId),
    importFromFile: (filePath: string) =>
      invoke('taxonomy:importFromFile', filePath),
  },

  // ── Suppliers (3 channels + research) ──
  suppliers: {
    list: (filter?: { conditions?: FilterCondition[]; groupedConditions?: import('../../shared/types/transactions').GroupedFilter }) => invoke('suppliers:list', filter),
    update: (supplierId: string, updates: SupplierUpdateInput) =>
      invoke('suppliers:update', supplierId, updates),
    confirm: (id: string, status: SupplierConfirmationStatus) =>
      invoke('suppliers:confirm', id, status),
    researchAll: () => invoke('suppliers:researchAll'),
    researchSingle: (supplierId: string) =>
      invoke('suppliers:researchSingle', supplierId),
    onResearchProgress: (callback: (progress: ResearchProgress) => void) =>
      on('suppliers:research:progress', callback),
    filterTailSpend: (threshold: number) =>
      invoke('suppliers:filterTailSpend', threshold),
    getFilterFields: () => invoke('suppliers:getFilterFields'),
    distinctValues: (field: string, limit?: number) => invoke('suppliers:distinctValues', field, limit),
    getAliases: (supplierId: string) => invoke('suppliers:getAliases', supplierId),
    assignAlias: (supplierId: string, rawName: string) => invoke('suppliers:assignAlias', supplierId, rawName),
    rename: (supplierId: string, newName: string) => invoke('suppliers:rename', supplierId, newName),
    merge: (survivorId: string, losingIds: string[]) => invoke('suppliers:merge', survivorId, losingIds),
    delete: (supplierId: string) => invoke('suppliers:delete', supplierId),
    listParents: () => invoke('suppliers:listParents'),
    addParent: (name: string) => invoke('suppliers:addParent', name),
    assignParent: (supplierIds: string[], parentId: string | null) => invoke('suppliers:assignParent', supplierIds, parentId),
    mergeParents: (survivorId: string, losingIds: string[]) => invoke('suppliers:mergeParents', survivorId, losingIds),
    renameParent: (parentId: string, newName: string) => invoke('suppliers:renameParent', parentId, newName),
    deleteParent: (parentId: string) => invoke('suppliers:deleteParent', parentId),
  },

  // ── Rules (4 channels) ──
  rules: {
    list: () => invoke('rules:list'),
    create: (input: OverrideRuleCreate) =>
      invoke('rules:create', input),
    update: (ruleId: string, updates: OverrideRuleUpdate) =>
      invoke('rules:update', ruleId, updates),
    delete: (ruleId: string) => invoke('rules:delete', ruleId),
  },

  // ── Changelog (2 channels) ──
  changelog: {
    list: () => invoke('changelog:list'),
    revert: (changeId: string) => invoke('changelog:revert', changeId),
  },

  // ── Export ──
  export: {
    csv: (filters?: TransactionFilter) => invoke('export:csv', filters),
    saveContent: (content: string, defaultFilename: string) => invoke('export:saveContent', content, defaultFilename),
  },

  // ── Settings (7 channels) ──
  settings: {
    getLLMConfig: () => invoke('settings:getLLMConfig'),
    setApiKey: (provider: string, key: string) => invoke('settings:setApiKey', provider, key),
    setProvider: (provider: string) => invoke('settings:setProvider', provider),
    setModel: (model: string) => invoke('settings:setModel', model),
    validateApiKey: (provider: string, key: string) => invoke('settings:validateApiKey', provider, key),
    setExaKey: (key: string) => invoke('settings:setExaKey', key),
    validateExaKey: (key: string) => invoke('settings:validateExaKey', key),
    validateStoredExaKey: () => invoke('settings:validateStoredExaKey'),
  },

  // ── Supplier Universe (3 channels) ──
  supplierUniverse: {
    getPath: () => invoke('supplier-universe:getPath'),
    selectFile: () => invoke('supplier-universe:selectFile'),
    createNew: () => invoke('supplier-universe:createNew'),
  },

  // ── License (3 channels + 1 event) ──
  license: {
    activate: (key: string) => invoke('license:activate', key),
    getStatus: () => invoke('license:getStatus'),
    checkNow: () => invoke('license:checkNow'),
    onStatusChanged: (callback: (status: LicenseStatus) => void) =>
      on('license:statusChanged', callback),
  },
};
