import type { SupplierInfo, ProjectSupplier, ProjectSupplierView, SupplierConfirmationStatus } from './suppliers';
import type { TaxonomyNode } from './taxonomy';
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions, TransactionUpdate, GroupedTransactionsResult, PivotAggregationResult } from './transactions';
import type { ColumnMapping, ColumnMappingResult, CSVPreview } from './column-mapping';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate } from './rules';
import type { ChangeLog, ChangeSource } from './changelog';
import type { CompanyContext } from './project';
import type { ClassificationInput, ClassificationResult, ResearchProgress, ClassificationProgress } from './classification';

// ─── LLM Config ──────────────────────────────────────────────────────────────

export interface ILLMConfigService {
  getApiKey(provider: string): string | null;
  setApiKey(provider: string, key: string): Promise<void>;
  getProvider(): string;
  setProvider(provider: string): Promise<void>;
  getModel(): string;
  setModel(model: string): Promise<void>;
}

// ─── Database Layer ──────────────────────────────────────────────────────────

export interface Database {
  openDatabase(filePath: string): Promise<void>;
  closeDatabase(): Promise<void>;
  isOpen(): boolean;
  getFilePath(): string | null;
  getExpectedTables(): string[];
  run(sql: string, ...params: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
}

export interface SupplierUniverse {
  open(filePath?: string): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  getSupplier(name: string): Promise<SupplierInfo | null>;
  getSuppliersByNames(names: string[]): Promise<Map<string, SupplierInfo>>;
  upsertSupplier(name: string, data: Partial<SupplierInfo>): Promise<void>;
  searchVariants(name: string): Promise<string[]>;
}

// ─── Infrastructure ──────────────────────────────────────────────────────────

export interface EventBus {
  emit(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  off(channel: string, listener: (...args: unknown[]) => void): void;
}

// ─── External Services ───────────────────────────────────────────────────────

export interface LLMClient {
  chat(systemPrompt: string, userPrompt: string, options?: {
    model?: string; maxTokens?: number; temperature?: number; provider?: string;
  }): Promise<string>;
}

export interface WebSearch {
  isAvailable(): boolean;
  searchSupplier(supplierName: string, supplierAddress?: string, numResults?: number): Promise<Array<{
    title: string; url: string; text: string; publishedDate?: string;
  }>>;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface ClassificationAgent {
  classifyInvoiceGroup(input: ClassificationInput): Promise<ClassificationResult>;
}

export interface ResearchAgent {
  researchSupplier(supplierName: string, context?: unknown, supplierAddress?: string,
    searchResults?: Array<{ title: string; url: string; text: string }>): Promise<SupplierInfo>;
}

export interface ColumnMappingAgent {
  suggestMappings(columns: string[], sampleRows: Record<string, string>[]): Promise<ColumnMappingResult>;
}

// ─── Data Services ───────────────────────────────────────────────────────────

export interface ProjectStore {
  createProject(name: string, filePath: string): Promise<{ filePath: string; name: string }>;
  openProject(filePath: string): Promise<{ filePath: string; name: string }>;
  closeProject(): Promise<void>;
  isProjectOpen(): boolean;
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  getAllSettings(): Promise<Record<string, unknown>>;
  selectSavePath(): Promise<string | null>;
  selectOpenPath(): Promise<string | null>;
}

export interface TransactionStore {
  queryTransactions(filters?: TransactionFilter): Promise<Transaction[]>;
  queryTransactionsPaginated(filters?: TransactionFilter): Promise<PaginatedTransactions>;
  getStats(): Promise<TransactionStats>;
  getColumns(): Promise<string[]>;
  getCount(filters?: TransactionFilter): Promise<number>;
  updateTransactions(update: TransactionUpdate, source?: ChangeSource): Promise<void>;
  invalidateColumnCache(): void;
  queryGroupedByColumn(column: string, filters?: TransactionFilter): Promise<GroupedTransactionsResult>;
  queryDistinctValues(column: string, limit?: number): Promise<string[]>;
  getTransactionIdsByColumnValue(column: string, value: string, filters?: TransactionFilter): Promise<string[]>;
  queryPivotAggregation(dimensions: string[], valueDimension?: string, filters?: TransactionFilter): Promise<PivotAggregationResult>;
}

export interface TaxonomyStore {
  getNodeCount(): Promise<number>;
  getNodes(): Promise<TaxonomyNode[]>;
  addNode(fullPath: string, description?: string): Promise<TaxonomyNode>;
  updateNode(nodeId: string, updates: { description?: string }): Promise<void>;
  deleteNode(nodeId: string, reassignTo?: string): Promise<void>;
  renameNode(nodeId: string, newName: string): Promise<void>;
  mergeNodes(sourceId: string, targetId: string): Promise<{ transactionsMoved: number }>;
  importFromFile(filePath: string): Promise<{ nodeCount: number; fileName: string }>;
  createFromText(text: string): Promise<{ nodeCount: number }>;
}

export interface SupplierService {
  normalizeSupplierName(rawName: string): Promise<string>;
  normalizeAllTransactions(): Promise<void>;
  addAlias(canonicalName: string, alias: string): Promise<void>;
  getAliases(canonicalName: string): Promise<string[]>;
  renameSupplier(supplierId: string, newName: string): Promise<void>;
  listProjectSuppliers(): Promise<ProjectSupplierView[]>;
  getProjectSupplier(id: string): Promise<ProjectSupplier | null>;
  confirmSupplier(id: string, status: SupplierConfirmationStatus): Promise<void>;
  assignParent(id: string, parentId: string): Promise<void>;
  filterTailSpend(threshold: number): Promise<string[]>;
  enrichProjectSupplier(id: string): Promise<ProjectSupplierView>;
}

export interface RuleStore {
  listRules(): Promise<OverrideRule[]>;
  createRule(input: OverrideRuleCreate): Promise<{ id: string }>;
  updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void>;
  deleteRule(ruleId: string): Promise<void>;
  evaluateRules(transactionIds?: string[]): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>>;
}

export interface ChangelogStore {
  listChanges(): Promise<ChangeLog[]>;
  logChange(entry: Omit<ChangeLog, 'id' | 'createdAt'>): Promise<string>;
  revertChange(changeId: string): Promise<void>;
}

export interface IngestService {
  selectFile(): Promise<string | null>;
  parseCSVPreview(filePath: string): CSVPreview;
  suggestMappings(columns: string[], sampleRows: Record<string, string>[]): Promise<ColumnMappingResult>;
  getStoredMappings(columns: string[]): Promise<UploadRecord | null>;
  importCSV(filePath: string, columnMappings: ColumnMapping, uploadId?: string): Promise<{ rowsInserted: number; uploadId: string }>;
  getUploadHistory(): Promise<UploadRecord[]>;
}

export interface ExportService {
  exportCSV(): Promise<{ rowsExported: number } | null>;
}

// ─── Orchestrators ───────────────────────────────────────────────────────────

export type ResearchProgressCallback = (progress: ResearchProgress) => void;

export interface SupplierResearcher {
  researchSingle(supplierName: string): Promise<SupplierInfo>;
  researchAll(onProgress?: ResearchProgressCallback): Promise<void>;
  cancel(): void;
}

export interface ClassificationRunner {
  classifyAll(): Promise<void>;
  classifySupplier(projectSupplierId: string, taxonomy: TaxonomyNode[], companyContext: CompanyContext, columnPriorities: string[]): Promise<void>;
  getIsRunning(): boolean;
  cancel(): Promise<void>;
}

// ─── Upload Record ───────────────────────────────────────────────────────────

export interface UploadRecord {
  id: string;
  fileName: string;
  filePath?: string;
  columnMappings: ColumnMapping;
  rowCount: number;
  status: 'pending' | 'mapped' | 'imported' | 'failed';
  createdAt: string;
  updatedAt?: string;
}
