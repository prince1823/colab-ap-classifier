import type { LicenseStatus, LicenseActivationResult } from './license';
import type { SupplierInfo, ProjectSupplier, ProjectSupplierView, SupplierConfirmationStatus, SupplierUpdateInput, SupplierParent } from './suppliers';
import type { TaxonomyNode } from './taxonomy';
import type { Transaction, TransactionFilter, TransactionStats, PaginatedTransactions, TransactionUpdate, GroupedTransactionsResult, PivotAggregationResult, FilterCondition, FieldDefinition } from './transactions';
import type { ColumnMapping, ColumnMappingResult, CSVPreview, DeriveMappingsSource, DerivedMappings } from './column-mapping';
import type { OverrideRule, OverrideRuleCreate, OverrideRuleUpdate, GenerateRulesResult, RuleGroup, RuleGroupCreate, RuleGroupUpdate } from './rules';
import type { ChangeLog, ChangeSource, ChangelogFilter, PaginatedChangelog } from './changelog';
import type { CompanyContext } from './project';
import type { ClassificationInput, ClassificationResult, ResearchProgress, ClassificationProgress, CategorySelectionInput, L3ClassificationInput, TailSpendCategorySelectionInput, TailSpendL3Input, QCConfig, QCResult, SpendByTaxonomyResult, FilterConditionQC } from './classification';
import type { FeedbackAgentInput, FeedbackRecommendation } from './feedback';

// ─── LLM Config ──────────────────────────────────────────────────────────────

export interface ILLMConfig {
  getApiKey(provider: string): string | null;
  setApiKey(provider: string, key: string): Promise<void>;
  getProvider(): string;
  setProvider(provider: string): Promise<void>;
  getModel(): string;
  setModel(model: string): Promise<void>;
}

// ─── App Config ──────────────────────────────────────────────────────────────

// ─── License ────────────────────────────────────────────────────────────────

export interface ILicenseService {
  activate(licenseKey: string): Promise<LicenseActivationResult>;
  getStatus(): LicenseStatus;
  checkNow(): Promise<LicenseStatus>;
  startPeriodicChecks(): void;
  stopPeriodicChecks(): void;
}

// ─── App Config ─────────────────────────────────────────────────────────────

export interface IAppConfigService extends ILLMConfig {
  getExaApiKey(): string | null;
  setExaApiKey(key: string): Promise<void>;
  getSupplierUniversePath(): string | null;
  setSupplierUniversePath(p: string): Promise<void>;
  clearSupplierUniversePath(): Promise<void>;
  // License storage (encrypted via safeStorage)
  getLicenseKey(): string | null;
  setLicenseKey(key: string): Promise<void>;
  clearLicenseKey(): Promise<void>;
  getLicenseData(): { lastResult?: LicenseStatus; lastChecked?: number } | null;
  setLicenseData(data: { lastResult?: LicenseStatus; lastChecked?: number }): Promise<void>;
  getLicenseServerUrl(): string | null;
  setLicenseServerUrl(url: string): Promise<void>;
  getLicensePublicKey(): string | null;
  setLicensePublicKey(key: string): Promise<void>;
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
  open(filePath?: string): Promise<{ created: boolean }>;
  close(): Promise<void>;
  isOpen(): boolean;
  configure(path: string): Promise<void>;
  getConfiguredPath(): string | null;
  getSupplier(name: string): Promise<SupplierInfo | null>;
  getSuppliersByNames(names: string[]): Promise<Map<string, SupplierInfo>>;
  upsertSupplier(name: string, data: Partial<SupplierInfo>): Promise<void>;
  upsertSupplierFull(name: string, data: {
    supplierInfo?: Partial<SupplierInfo>;
    aliases?: string[];
    parentName?: string | null;
    mappedTaxonomyPaths?: string[];
    categoryASupplier?: boolean;
  }): Promise<void>;
  getSupplierRecord(name: string): Promise<{
    supplierInfo: SupplierInfo;
    aliases: string[];
    parentName: string | null;
    mappedTaxonomyPaths: string[];
    categoryASupplier: boolean;
  } | null>;
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
  selectCategories(input: CategorySelectionInput): Promise<Map<number, string>>;
  selectCategoriesForTailSpend(input: TailSpendCategorySelectionInput): Promise<Map<number, string>>;
  classifyL3(input: L3ClassificationInput): Promise<ClassificationResult>;
  classifyL3ForTailSpend(input: TailSpendL3Input): Promise<Map<number, string>>;
  /** Backward compat wrapper — calls selectCategories + classifyL3 */
  classifyTransactionGroup(input: ClassificationInput): Promise<ClassificationResult>;
}

export interface ResearchAgent {
  researchSupplier(supplierName: string, context?: unknown, supplierAddress?: string,
    searchResults?: Array<{ title: string; url: string; text: string }>): Promise<SupplierInfo>;
}

export interface ColumnMappingAgent {
  suggestMappings(columns: string[], sampleRows: Record<string, string>[]): Promise<ColumnMappingResult>;
}

export interface FeedbackAgent {
  analyze(input: FeedbackAgentInput): Promise<FeedbackRecommendation>;
}

export interface QCAgent {
  review(input: { supplierSummary: string; rules: string }): Promise<QCResult>;
}

export interface CatAAgent {
  resolve(mappedPath: string, taxonomyNodes: TaxonomyNode[]): Promise<{ resolvedPath: string }>;
}

// ─── Data Services ───────────────────────────────────────────────────────────

export interface ProjectStore {
  createProject(name: string, filePath: string): Promise<{ filePath: string; name: string; warning?: string }>;
  openProject(filePath: string): Promise<{ filePath: string; name: string; warning?: string }>;
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
  getFilterFields(): Promise<FieldDefinition[]>;
  getCount(filters?: TransactionFilter): Promise<number>;
  updateTransactions(update: TransactionUpdate, source?: ChangeSource): Promise<string | undefined>;
  invalidateColumnCache(): void;
  queryGroupedByColumn(column: string, filters?: TransactionFilter): Promise<GroupedTransactionsResult>;
  queryDistinctValues(column: string, limit?: number): Promise<string[]>;
  getTransactionIdsByColumnValue(column: string, value: string, filters?: TransactionFilter): Promise<string[]>;
  queryPivotAggregation(dimensions: string[], valueDimension?: string, filters?: TransactionFilter): Promise<PivotAggregationResult>;
  getIdsByConditions(conditions: FilterCondition[], scopeToIds?: string[]): Promise<string[]>;
  getIdsByGroupedConditions(grouped: import('./transactions').GroupedFilter, scopeToIds?: string[]): Promise<string[]>;
  markAllReviewed(): Promise<number>;
  applyRule(ruleId: string, groupedConditions: import('./transactions').GroupedFilter, targetTaxonomyNodeId: string): Promise<number>;
  getSupplierAddress(supplierId: string): Promise<string | undefined>;
  getSpendByTaxonomy(supplierId: string): Promise<SpendByTaxonomyResult[]>;
  getTransactionsByTaxonomy(supplierId: string, taxonomyNodeId: string, columnPriorities: string[]): Promise<Array<Record<string, unknown>>>;
  queryBySupplier(supplierId: string, statusFilter?: string | string[]): Promise<Record<string, unknown>[]>;
  getIdsBySupplier(supplierId: string, options?: {
    statuses?: string[];
    excludeTaxonomyNodeId?: string;
    requireTaxonomyNode?: boolean;
  }): Promise<string[]>;
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
  normalizeSupplierName(rawName: string, aliasMap?: Map<string, string>): Promise<string>;
  normalizeAllTransactions(): Promise<void>;
  assignAlias(supplierId: string, rawName: string): Promise<void>;
  getProjectAliases(supplierId: string): Promise<string[]>;
  renameSupplier(supplierId: string, newName: string): Promise<void>;
  mergeSuppliers(survivorId: string, losingIds: string[]): Promise<void>;
  deleteSupplier(supplierId: string): Promise<void>;
  updateSupplier(supplierId: string, updates: SupplierUpdateInput): Promise<void>;
  listProjectSuppliers(filter?: { conditions?: FilterCondition[]; groupedConditions?: import('./transactions').GroupedFilter }): Promise<ProjectSupplierView[]>;
  getProjectSupplier(id: string): Promise<ProjectSupplier | null>;
  confirmSupplier(id: string, status: SupplierConfirmationStatus): Promise<void>;
  filterTailSpend(threshold: number): Promise<string[]>;
  isTailSpend(supplierId: string): Promise<boolean>;
  markResearched(supplierId: string): Promise<void>;
  getFilterFields(): FieldDefinition[];
  queryDistinctValues(field: string, limit?: number): Promise<string[]>;
  // Parent management
  listParents(): Promise<SupplierParent[]>;
  addParent(name: string): Promise<SupplierParent>;
  findParentByName(name: string): Promise<SupplierParent | null>;
  assignParent(supplierIds: string[], parentId: string | null): Promise<void>;
  renameParent(parentId: string, newName: string): Promise<void>;
  deleteParent(parentId: string): Promise<void>;
  mergeParents(survivorId: string, losingIds: string[]): Promise<void>;
  // Supplier universe sync
  syncToUniverse(supplierIds: string[]): Promise<{ synced: number; failed: number; errors: string[] }>;
}

export interface RuleStore {
  listRules(): Promise<OverrideRule[]>;
  listRulesPaginated(opts: { limit: number; offset: number; search?: string }): Promise<{ rules: OverrideRule[]; total: number }>;
  getRule(id: string): Promise<OverrideRule | null>;
  createRule(input: OverrideRuleCreate): Promise<{ id: string }>;
  createAndApplyRule(input: OverrideRuleCreate): Promise<{ id: string; matchedCount: number }>;
  updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void>;
  deleteRule(ruleId: string): Promise<void>;
  evaluateRules(transactionIds?: string[], ruleIds?: string[]): Promise<Map<string, { ruleId: string; targetTaxonomyNodeId: string }>>;
  previewRules(ruleIds: string[]): Promise<{ affectedRowCount: number; matchingRuleCount: number }>;
  applyRules(ruleIds: string[]): Promise<{ matchedCount: number; ruleCount: number }>;
  generate_rules_preview(): Promise<GenerateRulesResult>;
  // Group operations
  listGroups(): Promise<RuleGroup[]>;
  createGroup(input: RuleGroupCreate): Promise<{ id: string }>;
  updateGroup(groupId: string, updates: RuleGroupUpdate): Promise<void>;
  deleteGroup(groupId: string): Promise<void>;
  reorderGroups(orderedIds: string[]): Promise<void>;
  moveRuleToGroup(ruleId: string, targetGroupId: string | null): Promise<void>;
  assignToGroup(ruleIds: string[], groupId: string | null): Promise<void>;
  filterAndAssignToGroup(filter: import('./transactions').GroupedFilter, targetGroupId: string | null): Promise<{ matched: number }>;
  getCatARuleForSupplier(supplierName: string): Promise<OverrideRule | null>;
}

export interface ChangelogStore {
  listChanges(filter?: ChangelogFilter): Promise<ChangeLog[]>;
  listChangesPaginated(filter?: ChangelogFilter): Promise<PaginatedChangelog>;
  getCount(filter?: ChangelogFilter): Promise<number>;
  logChange(entry: Omit<ChangeLog, 'id' | 'createdAt'>): Promise<string>;
  revertChange(changeId: string): Promise<void>;
}

export interface IngestService {
  selectFile(): Promise<string | null>;
  parseCSVPreview(filePath: string): Promise<CSVPreview>;
  suggestMappings(columns: string[], sampleRows: Record<string, string>[]): Promise<ColumnMappingResult>;
  importCSV(filePath: string, columnMappings: ColumnMapping, uploadId?: string): Promise<{ rowsInserted: number; uploadId: string }>;
  getUploadHistory(): Promise<UploadRecord[]>;
  deriveMappings(columns: string[], sampleRows: Record<string, string>[], source: DeriveMappingsSource): Promise<DerivedMappings>;
  getExistingCanonicals(): Promise<string[]>;
}

export interface ExportService {
  getExportColumns(): Promise<string[]>;
  exportCSV(filters?: TransactionFilter, selectedColumns?: string[]): Promise<{ rowsExported: number } | null>;
}

// ─── Orchestrators ───────────────────────────────────────────────────────────

export type ResearchProgressCallback = (progress: ResearchProgress) => void;

export interface SupplierResearcher {
  researchSingle(supplierName: string, universeCache?: Map<string, SupplierInfo>, supplierId?: string): Promise<SupplierInfo>;
  researchAll(supplierIds?: string[], options?: { suppressTerminal?: boolean }): Promise<void>;
  categorizeWithSupplierInfo(taxonomy: TaxonomyNode[], companyContext: CompanyContext): Promise<void>;
  categorizeTailSpend(taxonomy: TaxonomyNode[], companyContext: CompanyContext, columnPriorities: string[]): Promise<void>;
  cancel(): void;
}

export interface ClassificationRunner {
  classifyAll(groupedFilter?: import('./transactions').GroupedFilter): Promise<void>;
  getScopeCount(groupedFilter?: import('./transactions').GroupedFilter): Promise<number>;
  classifySupplierTransactions(projectSupplierId: string, categoryPath: string, taxonomy: TaxonomyNode[], companyContext: CompanyContext, columnPriorities: string[], scopedTxnIds?: Set<string>): Promise<void>;
  getIsRunning(): boolean;
  stop(): Promise<void>;
}

export interface QCRunner {
  runQC(config?: QCConfig): Promise<void>;
  getSupplierCount(scope?: FilterConditionQC[]): Promise<number>;
  getIsRunning(): boolean;
  stop(): void;
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
