import type { IPCResponse } from '../../shared/types/ipc';
import type { ProjectMetadata, ProjectMetadataUpdate, RecentProject } from '../../shared/types/project';
import type { CSVPreviewWithMappings, CanonicalColumnMapping } from '../../shared/types/canonicalization';
import type { ClassificationStartOptions, ClassificationProgress, ProjectRun } from '../../shared/types/classification';
import type { Transaction, TransactionFilter, TransactionStats } from '../../shared/types/transactions';
import type { TaxonomyNode, TaxonomyMetadata, TaxonomySetInput, TaxonomyInfo, RulePackInfo } from '../../shared/types/taxonomy';
import type { ProjectSupplier, SupplierUpdateInput, SupplierResearchResult } from '../../shared/types/suppliers';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types/rules';
import type { SystemFeedback, FeedbackActionDetails } from '../../shared/types/feedback';
import type { ChangeLog } from '../../shared/types/changelog';
import type { AppSettings, SettingsUpdateInput, ModelInfo, ProviderInfo } from '../../shared/types/settings';

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
 * Typed IPC client — all 14 namespaces covering 48 channels.
 */
export const ipc = {
  // ── Project (8 channels) ──
  project: {
    isOpen: () => invoke<boolean>('project:isOpen'),
    selectSavePath: () => invoke<string | null>('project:selectSavePath'),
    selectOpenPath: () => invoke<string | null>('project:selectOpenPath'),
    new: (name: string) => invoke<{ filePath: string; name: string }>('project:new', name),
    open: (path: string) => invoke<{ filePath: string; name: string }>('project:open', path),
    close: () => invoke<void>('project:close'),
    getMetadata: () => invoke<ProjectMetadata>('project:getMetadata'),
    updateMetadata: (updates: ProjectMetadataUpdate) => invoke<void>('project:updateMetadata', updates),
  },

  // ── Recent Projects (3 channels) ──
  recentProjects: {
    list: () => invoke<RecentProject[]>('recentProjects:list'),
    clear: () => invoke<void>('recentProjects:clear'),
    remove: (path: string) => invoke<void>('recentProjects:remove', path),
  },

  // ── Upload (3 channels) ──
  upload: {
    selectFile: () => invoke<string | null>('upload:selectFile'),
    parsePreview: (filePath: string) => invoke<CSVPreviewWithMappings>('upload:parsePreview', filePath),
    csv: (filePath: string) => invoke<{ rowsInserted: number }>('upload:csv', filePath),
  },

  // ── Canonicalization (1 channel) ──
  canonicalization: {
    save: (mapping: CanonicalColumnMapping, groupingColumns: string[]) =>
      invoke<void>('canonicalization:save', mapping, groupingColumns),
  },

  // ── Classification (3 channels + 1 event) ──
  classification: {
    start: (options: ClassificationStartOptions) => invoke<{ runId: string }>('classification:start', options),
    getStatus: () => invoke<ProjectRun | null>('classification:getStatus'),
    cancel: (runId: string) => invoke<void>('classification:cancel', runId),
    onProgress: (callback: (progress: ClassificationProgress) => void) =>
      on<ClassificationProgress>('classification:progress', callback),
  },

  // ── Transactions (4 channels) ──
  transactions: {
    query: (filters?: TransactionFilter) => invoke<Transaction[]>('transactions:query', filters),
    stats: () => invoke<TransactionStats>('transactions:stats'),
    getColumns: () => invoke<string[]>('transactions:getColumns'),
    reclassify: (transactionIds: string[], taxonomyNodeId: string, feedback?: string) =>
      invoke<void>('transactions:reclassify', transactionIds, taxonomyNodeId, feedback),
  },

  // ── Taxonomy (4 channels) ──
  taxonomy: {
    get: () => invoke<TaxonomyMetadata>('taxonomy:get'),
    getNodes: () => invoke<TaxonomyNode[]>('taxonomy:getNodes'),
    set: (input: TaxonomySetInput) => invoke<void>('taxonomy:set', input),
    importFromColabip: (industryName: string) => invoke<void>('taxonomy:importFromColabip', industryName),
  },

  // ── ColabIP (2 channels) ──
  colabip: {
    listTaxonomies: () => invoke<TaxonomyInfo[]>('colabip:listTaxonomies'),
    listRulePacks: () => invoke<RulePackInfo[]>('colabip:listRulePacks'),
  },

  // ── Suppliers (3 channels) ──
  suppliers: {
    list: () => invoke<ProjectSupplier[]>('suppliers:list'),
    update: (supplierName: string, updates: SupplierUpdateInput) =>
      invoke<void>('suppliers:update', supplierName, updates),
    research: (supplierName: string) => invoke<SupplierResearchResult>('suppliers:research', supplierName),
  },

  // ── Rules (5 channels) ──
  rules: {
    list: () => invoke<OverrideRule[]>('rules:list'),
    create: (input: OverrideRuleCreate) => invoke<OverrideRule>('rules:create', input),
    update: (ruleId: string, updates: OverrideRuleUpdate) => invoke<void>('rules:update', ruleId, updates),
    delete: (ruleId: string) => invoke<void>('rules:delete', ruleId),
    importFromColabip: (rulePack: string) => invoke<void>('rules:importFromColabip', rulePack),
  },

  // ── Feedback (3 channels) ──
  feedback: {
    list: () => invoke<SystemFeedback[]>('feedback:list'),
    approve: (feedbackId: string, modifications?: Partial<FeedbackActionDetails>) =>
      invoke<void>('feedback:approve', feedbackId, modifications),
    reject: (feedbackId: string, reason?: string) => invoke<void>('feedback:reject', feedbackId, reason),
  },

  // ── Changelog (2 channels) ──
  changelog: {
    list: () => invoke<ChangeLog[]>('changelog:list'),
    revert: (changeId: string) => invoke<void>('changelog:revert', changeId),
  },

  // ── Export (2 channels) ──
  export: {
    selectPath: () => invoke<string | null>('export:selectPath'),
    export: (filePath: string) => invoke<void>('export:export', filePath),
  },

  // ── Settings (4 channels) ──
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    update: (input: SettingsUpdateInput) => invoke<void>('settings:update', input),
    getModels: () => invoke<ModelInfo[]>('settings:getModels'),
    getProviders: () => invoke<ProviderInfo[]>('settings:getProviders'),
  },
};
