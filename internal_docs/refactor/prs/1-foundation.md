# PR 1: Foundation — Types, Interfaces, EventBus, Schema, Test Helpers

**Goal:** Lay the entire type foundation. After this PR, any developer can pick up a service interface and implement it independently.

## 1a. Service Interfaces

**Create:** `src/shared/types/services.ts`

### Database Layer
```typescript
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
  searchVariants(name: string): Promise<string[]>;  // fuzzy match, aliases
}
```

### Infrastructure
```typescript
export interface EventBus {
  emit(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  off(channel: string, listener: (...args: unknown[]) => void): void;
}
```

### External Services
```typescript
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
```

### Agents
```typescript
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
```

### Data Services
```typescript
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
}

export interface TaxonomyStore {
  getNodes(): Promise<TaxonomyNode[]>;
  addNode(fullPath: string, description?: string): Promise<TaxonomyNode>;
  updateNode(nodeId: string, updates: { description?: string }): Promise<void>;
  deleteNode(nodeId: string, reassignTo?: string): Promise<void>;
  renameNode(nodeId: string, newName: string): Promise<void>;
  mergeNodes(sourceId: string, targetId: string): Promise<{ transactionsMoved: number }>;
  importFromFile(filePath: string): Promise<{ nodeCount: number }>;
  createFromText(text: string): Promise<{ nodeCount: number }>;
}

export interface SupplierService {
  normalizeSupplierName(rawName: string): Promise<string>;  // returns project_supplier_id
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
```

### Orchestrators
```typescript
export interface SupplierResearcher {
  researchSingle(supplierName: string): Promise<SupplierInfo>;
  researchAll(onProgress?: ResearchProgressCallback): Promise<void>;
  cancel(): void;
}

export interface ClassificationRunner {
  classifyAll(): Promise<void>;
  classifySupplier(projectSupplierId: string, taxonomy: TaxonomyNode[], companyContext: CompanyContext): Promise<void>;
  getIsRunning(): boolean;
  cancel(): Promise<void>;
}
```

## 1b. Progress Types

**Modify:** `src/shared/types/classification.ts`

```typescript
// Separate progress types — no pipeline, no checkpoints
export interface ResearchProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}

export interface ClassificationProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}
```

Remove old `ClassificationProgress` with `phase` and `runId` fields.

## 1c. New `project_suppliers` Types

**Modify:** `src/shared/types/suppliers.ts`

```typescript
export type SupplierConfirmationStatus = 'pending' | 'confirmed' | 'rejected' | 'merged';

export interface ProjectSupplier {
  id: string;
  supplierName: string;
  confirmationStatus: SupplierConfirmationStatus;
  isTailSpend: boolean;
  parentSupplierName: string | null;
  dataSource: 'universe' | 'web_search' | 'manual';
  universeMatch: boolean;
  createdAt: string;
}

export interface ProjectSupplierView extends ProjectSupplier {
  transactionCount: number;
  totalSpend: number;
  aliases: string[];
}
```

## 1d. Database Schema Updates

**Modify:** `src/main/services/database.ts` `initializeSchema()`:

```sql
-- Add project_suppliers table
CREATE TABLE IF NOT EXISTS project_suppliers (
  id VARCHAR PRIMARY KEY,
  supplier_name VARCHAR NOT NULL UNIQUE,
  confirmation_status VARCHAR DEFAULT 'pending',
  is_tail_spend BOOLEAN DEFAULT FALSE,
  parent_supplier_name VARCHAR,
  data_source VARCHAR DEFAULT 'manual',
  universe_match BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_project_suppliers_name ON project_suppliers(supplier_name);

-- Add project_supplier_id FK column to transactions (dynamic — added at schema init)
-- ALTER TABLE transactions ADD COLUMN IF NOT EXISTS project_supplier_id VARCHAR;
-- CREATE INDEX IF NOT EXISTS idx_transactions_supplier ON transactions(project_supplier_id);
```

Add `'project_suppliers'` to `EXPECTED_TABLES` array.

## 1e. EventBus

**Create:** `src/main/event-bus.ts`

```typescript
import { EventEmitter } from 'events';
import type { EventBus } from '../shared/types';

class AppEventBus extends EventEmitter implements EventBus {
  emit(channel: string, ...args: unknown[]): boolean {
    return super.emit(channel, ...args);
  }
}

export const eventBus: EventBus = new AppEventBus();
```

## 1f. Test Mock Factories

**Create:** `tests/helpers/mock-services.ts`

One factory per interface — returns an object where every method is a `vi.fn()`.

```typescript
export function createMockDatabase(): Database { ... }
export function createMockSupplierUniverse(): SupplierUniverse { ... }
export function createMockEventBus(): EventBus { ... }
export function createMockLLMClient(): LLMClient { ... }
export function createMockWebSearch(): WebSearch { ... }
export function createMockTransactionStore(): TransactionStore { ... }
export function createMockSupplierService(): SupplierService { ... }
// ... etc for all interfaces
```

## 1g. Update Exports

**Modify:** `src/shared/types/index.ts` — add `export * from './services'`

## Verify

- `npx tsc --noEmit`
- No runtime changes — existing code still works (interfaces are additive)

## Files

| Action | Path |
|---|---|
| Create | `src/shared/types/services.ts` |
| Create | `src/main/event-bus.ts` |
| Create | `tests/helpers/mock-services.ts` |
| Modify | `src/shared/types/index.ts` |
| Modify | `src/shared/types/classification.ts` |
| Modify | `src/shared/types/suppliers.ts` |
| Modify | `src/main/services/database.ts` (schema only) |
