import type { ProjectMetadata, ProjectMetadataUpdate } from './project';
import type { LicenseStatus, LicenseActivationResult } from './license';

export interface LLMConfigResponse {
  provider: string;
  model: string;
  hasOpenRouterKey: boolean;
  hasAnthropicKey: boolean;
  hasOpenAIKey: boolean;
  hasExaKey: boolean;
}
import type { CSVPreview, ColumnMapping, ColumnMappingResult, ColumnMappingWithPriority, DeriveMappingsSource, DerivedMappings } from './column-mapping';
import type {
  TransactionFilter,
  FilterCondition,
  FieldDefinition,
  TransactionStats,
  PaginatedTransactions,
  TransactionUpdate,
  GroupedTransactionsResult,
  PivotAggregationResult,
  GroupedFilter,
} from './transactions';
import type { ClassificationProgress, ResearchProgress, QCProgress, IngestProgress, QCConfig, FilterConditionQC } from './classification';
import type { TaxonomyNode } from './taxonomy';
import type { ProjectSupplierView, SupplierConfirmationStatus, SupplierInfo, SupplierUpdateInput, SupplierParent } from './suppliers';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate, GenerateRulesResult, RuleGroup, RuleGroupCreate, RuleGroupUpdate } from './rules';
import type { ChangeLog, ChangelogFilter, PaginatedChangelog } from './changelog';
import type { UploadRecord } from './services';
import type { FeedbackAnalyzeInput, FeedbackRecommendation, FeedbackApplyInput } from './feedback';

export interface IPCInvokeMap {
  // Project
  'project:new':            { args: [name: string, filePath?: string]; result: { filePath: string; name: string; warning?: string; needsSupplierUniverseSetup?: boolean; missingSupplierUniversePath?: string } | null };
  'project:open':           { args: [filePath?: string]; result: { filePath: string; name: string; warning?: string; needsSupplierUniverseSetup?: boolean; missingSupplierUniversePath?: string } | null };
  'project:close':          { args: []; result: void };
  'project:finalizeOpen':   { args: []; result: { filePath: string; name: string } };
  'project:getSetting':     { args: [key: string]; result: unknown };
  'project:setSetting':     { args: [key: string, value: unknown]; result: void };
  'project:deleteSetting':  { args: [key: string]; result: void };
  'project:getAllSettings':  { args: []; result: Record<string, unknown> };
  'project:getMetadata':    { args: []; result: ProjectMetadata };
  'project:updateMetadata': { args: [updates: ProjectMetadataUpdate]; result: void };

  // Ingest
  'ingest:selectFile':       { args: []; result: string | null };
  'ingest:parseCSV':         { args: [filePath: string]; result: CSVPreview };
  'ingest:suggestMappings':  { args: [columns: string[], sampleRows: Record<string, string>[]]; result: ColumnMappingResult };
  'ingest:importCSV':        { args: [filePath: string, mapping?: ColumnMapping]; result: { rowsInserted: number; uploadId: string } };
  'ingest:getUpload':              { args: []; result: { id: string; fileName: string; columnMappings: ColumnMappingWithPriority | null; rowCount: number } | null };
  'ingest:getUploadHistory':       { args: []; result: UploadRecord[] };
  'ingest:deriveMappings':         { args: [columns: string[], sampleRows: Record<string, string>[], source: DeriveMappingsSource]; result: DerivedMappings };
  'ingest:getExistingCanonicals':  { args: []; result: string[] };

  // Transactions
  'transactions:query':             { args: [filters?: TransactionFilter]; result: PaginatedTransactions };
  'transactions:stats':             { args: []; result: TransactionStats };
  'transactions:getColumns':        { args: []; result: string[] };
  'transactions:update':            { args: [update: TransactionUpdate]; result: string | undefined };
  'transactions:queryGrouped':      { args: [column: string, filters?: TransactionFilter]; result: GroupedTransactionsResult };
  'transactions:distinctValues':    { args: [column: string, limit?: number]; result: string[] };
  'transactions:getIdsByValue':     { args: [column: string, value: string, filters?: TransactionFilter]; result: string[] };
  'transactions:pivotAggregation':  { args: [dimensions: string[], valueDimension: string, filters?: TransactionFilter]; result: PivotAggregationResult };
  'transactions:getIdsByConditions': { args: [conditions: FilterCondition[]]; result: string[] };
  'transactions:getFilterFields':    { args: []; result: FieldDefinition[] };
  'transactions:markAllReviewed':   { args: []; result: number };

  // Classification
  'classification:start':      { args: [groupedFilter?: GroupedFilter]; result: void };
  'classification:stop':       { args: []; result: void };
  'classification:cancel':     { args: []; result: void };
  'classification:scopeCount': { args: [groupedFilter?: GroupedFilter]; result: number };

  // QC
  'qc:run':        { args: [config?: QCConfig]; result: void };
  'qc:count':      { args: [scope?: FilterConditionQC[]]; result: number };
  'qc:stop':       { args: []; result: void };
  'qc:isRunning':  { args: []; result: boolean };
  'qc:getConfig':  { args: []; result: QCConfig };
  'qc:setConfig':  { args: [config: QCConfig]; result: void };
  'qc:getDefaults': { args: []; result: QCConfig };

  // Taxonomy
  'taxonomy:getNodeCount':   { args: []; result: number };
  'taxonomy:getNodes':       { args: []; result: TaxonomyNode[] };
  'taxonomy:addNode':        { args: [fullPath: string, description?: string]; result: TaxonomyNode };
  'taxonomy:updateNode':     { args: [nodeId: string, updates: Partial<TaxonomyNode>]; result: void };
  'taxonomy:deleteNode':     { args: [nodeId: string]; result: void };
  'taxonomy:renameNode':     { args: [nodeId: string, newName: string]; result: void };
  'taxonomy:mergeNodes':     { args: [sourceId: string, targetId: string]; result: { transactionsMoved: number } };
  'taxonomy:importFromFile': { args: [filePath: string]; result: { nodeCount: number; fileName: string } };

  // Suppliers
  'suppliers:list':           { args: [filter?: { conditions?: FilterCondition[]; groupedConditions?: GroupedFilter }]; result: ProjectSupplierView[] };
  'suppliers:update':         { args: [supplierId: string, updates: SupplierUpdateInput]; result: void };
  'suppliers:confirm':        { args: [id: string, status: SupplierConfirmationStatus]; result: void };
  'suppliers:researchAll':    { args: [supplierIds?: string[]]; result: void };
  'suppliers:cancelResearch': { args: []; result: void };
  'suppliers:researchSingle': { args: [supplierId: string]; result: SupplierInfo };
  'suppliers:filterTailSpend': { args: [threshold: number]; result: { markedCount: number } };
  'suppliers:getFilterFields': { args: []; result: FieldDefinition[] };
  'suppliers:distinctValues':  { args: [field: string, limit?: number]; result: string[] };
  'suppliers:getAliases':      { args: [supplierId: string]; result: string[] };
  'suppliers:assignAlias':     { args: [supplierId: string, rawName: string]; result: void };
  'suppliers:rename':          { args: [supplierId: string, newName: string]; result: void };
  'suppliers:merge':           { args: [survivorId: string, losingIds: string[]]; result: void };
  'suppliers:delete':          { args: [supplierId: string]; result: void };
  'suppliers:listParents':     { args: []; result: SupplierParent[] };
  'suppliers:addParent':       { args: [name: string]; result: SupplierParent };
  'suppliers:assignParent':    { args: [supplierIds: string[], parentId: string | null]; result: void };
  'suppliers:renameParent':    { args: [parentId: string, newName: string]; result: void };
  'suppliers:deleteParent':    { args: [parentId: string]; result: void };
  'suppliers:mergeParents':    { args: [survivorId: string, losingIds: string[]]; result: void };

  // Rules
  'rules:list':           { args: []; result: OverrideRule[] };
  'rules:listPaginated':  { args: [opts: { limit: number; offset: number; search?: string }]; result: { rules: OverrideRule[]; total: number } };
  'rules:create':         { args: [input: OverrideRuleCreate]; result: { id: string } };
  'rules:createAndApply': { args: [input: OverrideRuleCreate]; result: { id: string; matchedCount: number } };
  'rules:update':         { args: [ruleId: string, updates: OverrideRuleUpdate]; result: void };
  'rules:delete':         { args: [ruleId: string]; result: void };
  'rules:generate':       { args: []; result: GenerateRulesResult };

  // Rule Groups
  'rules:listGroups':     { args: []; result: RuleGroup[] };
  'rules:createGroup':    { args: [input: RuleGroupCreate]; result: { id: string } };
  'rules:updateGroup':    { args: [groupId: string, updates: RuleGroupUpdate]; result: void };
  'rules:deleteGroup':    { args: [groupId: string]; result: void };
  'rules:reorderGroups':  { args: [orderedIds: string[]]; result: void };
  'rules:moveRule':       { args: [ruleId: string, targetGroupId: string | null]; result: void };
  'rules:assignToGroup':  { args: [ruleIds: string[], groupId: string | null]; result: void };
  'rules:filterAssign':   { args: [filter: GroupedFilter, targetGroupId: string | null]; result: { matched: number } };

  // Changelog
  'changelog:list':   { args: [filter?: ChangelogFilter]; result: PaginatedChangelog };
  'changelog:revert': { args: [changeId: string]; result: void };

  // Feedback
  'feedback:analyze': { args: [input: FeedbackAnalyzeInput]; result: FeedbackRecommendation };
  'feedback:apply':   { args: [input: FeedbackApplyInput]; result: void };

  // Export
  'export:csv': { args: [filters?: TransactionFilter]; result: { rowsExported: number } | null };
  'export:saveContent': { args: [content: string, defaultFilename: string]; result: boolean };

  // Settings — LLM
  'settings:getLLMConfig':   { args: []; result: LLMConfigResponse };
  'settings:setApiKey':      { args: [provider: string, key: string]; result: void };
  'settings:setProvider':    { args: [provider: string]; result: void };
  'settings:setModel':       { args: [model: string]; result: void };
  'settings:validateApiKey': { args: [provider: string, key: string]; result: { valid: boolean; error?: string } };
  // Settings — Exa
  'settings:setExaKey':           { args: [key: string]; result: void };
  'settings:validateExaKey':      { args: [key: string]; result: { valid: boolean; error?: string } };
  'settings:validateStoredExaKey': { args: []; result: { valid: boolean; error?: string } };

  // Supplier Universe
  'supplier-universe:getPath':    { args: []; result: string | null };
  'supplier-universe:selectFile': { args: []; result: string | null };
  'supplier-universe:createNew':  { args: []; result: string | null };

  // License
  'license:activate':  { args: [licenseKey: string]; result: LicenseActivationResult };
  'license:getStatus': { args: []; result: LicenseStatus };
  'license:checkNow':  { args: []; result: LicenseStatus };

  // Shell
  'shell:openExternal': { args: [url: string]; result: void };
}

export interface IPCEventMap {
  'classification:progress':     ClassificationProgress;
  'suppliers:research:progress': ResearchProgress;
  'qc:progress':                 QCProgress;
  'ingest:progress':             IngestProgress;
  'license:statusChanged':       LicenseStatus;
}

export type IPCChannel = keyof IPCInvokeMap;
export type IPCArgs<K extends IPCChannel> = IPCInvokeMap[K]['args'];
export type IPCResult<K extends IPCChannel> = IPCInvokeMap[K]['result'];
