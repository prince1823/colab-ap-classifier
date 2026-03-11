import type { ProjectMetadata, ProjectMetadataUpdate } from './project';

export interface LLMConfigResponse {
  provider: string;
  model: string;
  hasOpenRouterKey: boolean;
  hasAnthropicKey: boolean;
  hasOpenAIKey: boolean;
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
} from './transactions';
import type { ClassificationProgress, ResearchProgress } from './classification';
import type { TaxonomyNode } from './taxonomy';
import type { ProjectSupplierView, SupplierConfirmationStatus, SupplierInfo, SupplierUpdateInput } from './suppliers';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate } from './rules';
import type { ChangeLog } from './changelog';
import type { UploadRecord } from './services';

export interface IPCInvokeMap {
  // Project
  'project:new':            { args: [name: string, filePath?: string]; result: { filePath: string; name: string; warning?: string; needsSupplierUniverseSetup?: boolean } | null };
  'project:open':           { args: [filePath?: string]; result: { filePath: string; name: string; warning?: string; needsSupplierUniverseSetup?: boolean } | null };
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

  // Classification
  'classification:start':  { args: []; result: void };
  'classification:cancel': { args: []; result: void };

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
  'suppliers:list':           { args: [filter?: { conditions: FilterCondition[] }]; result: ProjectSupplierView[] };
  'suppliers:update':         { args: [supplierName: string, updates: SupplierUpdateInput]; result: void };
  'suppliers:confirm':        { args: [id: string, status: SupplierConfirmationStatus]; result: void };
  'suppliers:researchAll':    { args: []; result: void };
  'suppliers:researchSingle': { args: [supplierName: string]; result: SupplierInfo };
  'suppliers:filterTailSpend': { args: [threshold: number]; result: { markedCount: number } };
  'suppliers:getFilterFields': { args: []; result: FieldDefinition[] };

  // Rules
  'rules:list':   { args: []; result: OverrideRule[] };
  'rules:create': { args: [input: OverrideRuleCreate]; result: { id: string } };
  'rules:update': { args: [ruleId: string, updates: OverrideRuleUpdate]; result: void };
  'rules:delete': { args: [ruleId: string]; result: void };

  // Changelog
  'changelog:list':   { args: []; result: ChangeLog[] };
  'changelog:revert': { args: [changeId: string]; result: void };

  // Export
  'export:csv': { args: []; result: { rowsExported: number } | null };

  // Settings — LLM
  'settings:getLLMConfig':   { args: []; result: LLMConfigResponse };
  'settings:setApiKey':      { args: [provider: string, key: string]; result: void };
  'settings:setProvider':    { args: [provider: string]; result: void };
  'settings:setModel':       { args: [model: string]; result: void };
  'settings:validateApiKey': { args: [provider: string, key: string]; result: { valid: boolean; error?: string } };

  // Supplier Universe
  'supplier-universe:getPath':    { args: []; result: string | null };
  'supplier-universe:selectFile': { args: []; result: string | null };
  'supplier-universe:createNew':  { args: []; result: string | null };
}

export interface IPCEventMap {
  'classification:progress':     ClassificationProgress;
  'suppliers:research:progress': ResearchProgress;
}

export type IPCChannel = keyof IPCInvokeMap;
export type IPCArgs<K extends IPCChannel> = IPCInvokeMap[K]['args'];
export type IPCResult<K extends IPCChannel> = IPCInvokeMap[K]['result'];
