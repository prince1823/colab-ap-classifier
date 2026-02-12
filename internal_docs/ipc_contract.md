# IPC Contract — v1

> **This document is the authoritative source for all frontend ↔ backend IPC communication.** Both teams should build against this contract.
>
> **References:** [features.md](./features.md) for product decisions, [schema.md](./schema.md) for database schema, [backend_spec.md](./backend_spec.md) for data flows.

---

## Conventions

### Response Envelope

Every `ipcMain.handle` handler returns:

```typescript
interface IPCResponse<T> {
  success: boolean;
  data?: T;       // Present when success = true (unless T is void)
  error?: string;  // Present when success = false
}
```

The frontend should always check `result.success` before accessing `result.data`.

### Events (One-Way)

Events are pushed from main → renderer via `ipcRenderer.on(channel, callback)`. These do **not** use the `IPCResponse` envelope — the callback receives the payload directly.

### Frontend Access Pattern

```typescript
// Request/response (invoke)
const result = await window.electronAPI.namespace.method(args);
if (result.success) {
  // result.data is typed
}

// Event (listener)
const unsubscribe = window.electronAPI.classification.onProgress((progress) => { ... });
// Call unsubscribe() to stop listening
```

---

## Channels

### project (8 channels)

---

#### `project:isOpen`

Check if a project database is currently open.

| | |
|---|---|
| **Args** | none |
| **Response** | `boolean` |
| **Notes** | Called on app start and before operations that require an open project. |

---

#### `project:selectSavePath`

Open a native save dialog for the user to choose where to save a new `.c91` file.

| | |
|---|---|
| **Args** | none |
| **Response** | `string \| null` — file path, or null if cancelled |
| **Notes** | Returns the selected path. Does not create the file. |

---

#### `project:selectOpenPath`

Open a native file dialog for the user to select an existing `.c91` file.

| | |
|---|---|
| **Args** | none |
| **Response** | `string \| null` — file path, or null if cancelled |
| **Notes** | Dialog filters to `.c91` files only. |

---

#### `project:new`

Create a new project. Initializes all database tables in the `.c91` file.

| | |
|---|---|
| **Args** | `projectName: string` — user-chosen project name |
| **Response** | `{ filePath: string; name: string }` |
| **Notes** | Creates file at `./projects/{projectName}.c91`. Adds to recent projects index. Opens the project (subsequent calls assume this project is active). |

---

#### `project:open`

Open an existing `.c91` project file.

| | |
|---|---|
| **Args** | `filePath: string` — absolute path to the `.c91` file |
| **Response** | `{ filePath: string; name: string }` |
| **Notes** | Opens DuckDB connection. Adds to recent projects index. Name is derived from filename. |

---

#### `project:close`

Close the currently open project and release the database connection.

| | |
|---|---|
| **Args** | none |
| **Response** | `void` |
| **Notes** | No-op if no project is open. |

---

#### `project:getMetadata`

Get all metadata for the currently open project.

| | |
|---|---|
| **Args** | none |
| **Response** | `ProjectMetadata` |

```typescript
interface ProjectMetadata {
  name: string;                              // Derived from filename
  filePath: string;
  companyContext: CompanyContext | null;
  columnMappings: CanonicalColumnMapping | null;
  invoiceGroupingColumns: string[] | null;
  tailSpendThreshold: number;
  taxonomyName: string | null;               // From settings table
  createdAt: string | null;
}
```

| **Notes** | Requires open project. `companyContext` is null until user configures it. |

---

#### `project:updateMetadata`

Update project settings and/or company context.

| | |
|---|---|
| **Args** | `updates: ProjectMetadataUpdate` |
| **Response** | `void` |

```typescript
interface ProjectMetadataUpdate {
  companyContext?: CompanyContext;
  tailSpendThreshold?: number;
}
```

| **Notes** | Partial update — only provided fields are changed. Requires open project. |

---

### recentProjects (3 channels)

---

#### `recentProjects:list`

Get the list of recently opened projects.

| | |
|---|---|
| **Args** | none |
| **Response** | `RecentProject[]` |

```typescript
interface RecentProject {
  path: string;
  name: string;
  lastOpened: string; // ISO timestamp
}
```

| **Notes** | Read from `~/.config/Colab91 Classifier/recent-projects.json`. Works without an open project. |

---

#### `recentProjects:clear`

Clear all recent projects from the index.

| | |
|---|---|
| **Args** | none |
| **Response** | `void` |

---

#### `recentProjects:remove`

Remove a single project from the recent projects list.

| | |
|---|---|
| **Args** | `filePath: string` |
| **Response** | `void` |
| **Notes** | Does not delete the `.c91` file — only removes from the index. |

---

### upload (3 channels)

---

#### `upload:selectFile`

Open a native file dialog for CSV selection.

| | |
|---|---|
| **Args** | none |
| **Response** | `string \| null` — file path, or null if cancelled |
| **Notes** | Dialog filters to `.csv` files. |

---

#### `upload:parsePreview`

Parse a CSV file, return a preview, and **automatically suggest column mappings** via the CanonicalizationAgent (LLM-first).

| | |
|---|---|
| **Args** | `filePath: string` |
| **Response** | `CSVPreviewWithMappings` |

```typescript
interface CSVPreviewWithMappings {
  columns: string[];                          // All CSV column headers
  sampleRows: Record<string, string>[];       // First 10 rows as key-value pairs
  totalRows: number;                          // Total row count in file
  mappingSuggestion: CanonicalizationResult;  // LLM-suggested column mappings
}
```

| **Notes** | Does not insert data. Automatically calls CanonicalizationAgent with headers + sample rows to produce mapping suggestions. If the LLM call fails, `mappingSuggestion` is returned with empty mappings and confidence 'low'. The frontend displays the pre-populated mappings for review. |

---

#### `upload:csv`

Import a full CSV file into the currently open project's transactions table.

| | |
|---|---|
| **Args** | `filePath: string` |
| **Response** | `{ rowsInserted: number }` |
| **Notes** | Requires open project with saved column mappings. Applies canonicalization during insert. Extracts distinct suppliers into `project_suppliers`. |

---

### canonicalization (1 channel)

> **Note:** The `canonicalization:suggest` channel has been **removed**. LLM mapping suggestions are now returned automatically as part of `upload:parsePreview` (LLM-first flow). See the `upload:parsePreview` channel above.

---

#### `canonicalization:save`

Save confirmed column mappings and invoice grouping columns.

| | |
|---|---|
| **Args** | `mapping: Record<string, string>, groupingColumns: string[]` |
| **Response** | `void` |
| **Notes** | `mapping` = canonical_name → csv_column_name. `groupingColumns` = canonical column names used for invoice grouping. Writes to `column_mappings` and `invoice_grouping_columns` tables. After this call, `transactions:getColumns` returns the mapped canonical column names — the frontend uses these to know which fields exist in `Transaction.canonicalFields`. |

---

### classification (3 channels + 1 event)

---

#### `classification:start`

Start a classification pipeline job.

| | |
|---|---|
| **Args** | `options: ClassificationStartOptions` |
| **Response** | `{ runId: string }` |

```typescript
interface ClassificationStartOptions {
  scope: ClassificationScope;                 // "all" | "new" | "filtered"
  filterCriteria?: TransactionFilter;         // Required when scope = "filtered"
}
```

| **Notes** | Creates an in-memory run tracker (no database table). Pipeline runs async: supplier research → rule sync → override rules → LLM classification → review scores. Progress emitted via `classification:progress` event. Only one job at a time. |

---

#### `classification:getStatus`

Get the status of the most recent classification run.

| | |
|---|---|
| **Args** | none |
| **Response** | `ProjectRun \| null` |

| **Notes** | Returns null if no classification has been started. Returns the current in-memory run state. |

---

#### `classification:cancel`

Cancel an active classification job.

| | |
|---|---|
| **Args** | `runId: string` |
| **Response** | `void` |
| **Notes** | Sets run status to `cancelled`. Rows classified before cancellation remain classified. |

---

#### `classification:progress` (EVENT)

Real-time progress updates pushed from main → renderer during classification.

| | |
|---|---|
| **Direction** | Main → Renderer (event, not invoke) |
| **Payload** | `ClassificationProgress` |

```typescript
interface ClassificationProgress {
  runId: string;
  status: ProjectRunStatus;
  phase: "researching" | "classifying";       // Which pipeline step
  total: number;                              // Total items in current phase
  processed: number;                          // Items completed in current phase
  percentage: number;                         // 0-100
  currentStep: string;                        // Human-readable description
}
```

| **Frontend** | Subscribe: `window.electronAPI.classification.onProgress(callback)`. Returns unsubscribe function. |

---

### transactions (4 channels)

---

#### `transactions:query`

Query transactions with optional filters.

| | |
|---|---|
| **Args** | `filters?: TransactionFilter` |
| **Response** | `Transaction[]` |

```typescript
interface TransactionFilter {
  supplierName?: string;
  taxonomyNodeId?: string;                    // FK to taxonomy.id
  reviewScoreMin?: number;                    // 0-100
  reviewScoreMax?: number;
  spendMin?: number;
  spendMax?: number;
  excludeTailSpend?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}
```

```typescript
interface Transaction {
  // Fixed columns (always present)
  id: string;
  rowIndex: number;
  invoiceGroupKey: string | null;

  // Classification output
  taxonomyNodeId: string | null;              // FK to taxonomy.id
  classificationPath: string | null;          // Denormalized: "L1|L2|L3" (from taxonomy.full_path)
  reviewScore: number | null;                 // 0-100 integer
  classificationReasoning: string | null;

  // Canonical fields — dynamic, based on column_mappings
  // Keys are canonical column names (e.g., "supplier_name", "spend_amount").
  // Which keys are present depends on the project's canonicalization.
  // Use transactions:getColumns to discover available keys.
  canonicalFields: Record<string, unknown>;

  // Metadata
  createdAt: string;
  updatedAt: string;
}
```

| **Notes** | Requires open project. Without filters, returns all transactions. `classificationPath` is denormalized from the taxonomy JOIN for display convenience. Pagination via `page`/`pageSize`. The `canonicalFields` keys match the canonical column names from `column_mappings` — the frontend discovers available fields via `transactions:getColumns` after canonicalization. |

---

#### `transactions:stats`

Get aggregate statistics for the current project's transactions.

| | |
|---|---|
| **Args** | none |
| **Response** | `TransactionStats` |

```typescript
interface TransactionStats {
  totalRows: number;
  totalSpend: number;
  uniqueSuppliers: number;
  classifiedRows: number;                     // rows with taxonomy_node_id != null
  flaggedForReviewRows: number;               // rows with review_score above threshold
}
```

---

#### `transactions:getColumns`

Get the list of canonical columns available in the current project's transactions.

| | |
|---|---|
| **Args** | none |
| **Response** | `string[]` |
| **Notes** | Returns canonical column names that were mapped during canonicalization (e.g., `["supplier_name", "spend_amount", "gl_description"]`). These are the keys present in `Transaction.canonicalFields`. Used by the frontend to configure table views and to know which fields are available for the current project. |

---

#### `transactions:reclassify`

Manually reclassify one or more transactions.

| | |
|---|---|
| **Args** | `transactionIds: string[], taxonomyNodeId: string, feedback?: string` |
| **Response** | `void` |
| **Notes** | Updates `taxonomy_node_id` on each transaction. Inserts a `change_log` entry (source=`manual`). If `feedback` text is provided and feedback generation is enabled, triggers the FeedbackAgent to generate a `system_feedback` suggestion. |

---

### taxonomy (4 channels)

---

#### `taxonomy:get`

Get taxonomy metadata for the current project.

| | |
|---|---|
| **Args** | none |
| **Response** | `TaxonomyMetadata \| null` |

```typescript
interface TaxonomyMetadata {
  name: string;                               // e.g., "Healthcare", "General"
  nodeCount: number;                          // Total nodes in taxonomy
}
```

| **Notes** | Returns null if no taxonomy is imported. Name is from settings table (`taxonomy_name` key). |

---

#### `taxonomy:getNodes`

Get all taxonomy nodes for the current project.

| | |
|---|---|
| **Args** | none |
| **Response** | `TaxonomyNode[]` |

```typescript
interface TaxonomyNode {
  id: string;
  fullPath: string;                           // Pipe-delimited: "Corporate Services|IT|Software"
  l1: string;
  l2: string | null;
  l3: string | null;
  depth: number;                              // 1, 2, or 3
  description: string | null;
  parentPath: string | null;
  createdAt: string;
}
```

| **Notes** | Returns all nodes (L1, L2, L3). Frontend builds tree structure from `parentPath`. |

---

#### `taxonomy:set`

Set/replace the taxonomy in the current project. Used when manually defining a taxonomy.

| | |
|---|---|
| **Args** | `data: TaxonomySetInput` |
| **Response** | `void` |

```typescript
interface TaxonomySetInput {
  name: string;
  nodes: Array<{
    path: string;                             // Pipe-delimited: "Corporate Services|IT|Software"
    description?: string;
  }>;
}
```

| **Notes** | Replaces existing taxonomy entirely. Stores `name` in settings table. Generates IDs and depth/parent from path strings. |

---

#### `taxonomy:importFromColabip`

Import a taxonomy from the ColabIP local store into the current project.

| | |
|---|---|
| **Args** | `industryName: string` — folder name in `colabip/taxonomies/` |
| **Response** | `void` |
| **Notes** | Reads `.txt` node files from `colabip/taxonomies/{industryName}/`. Replaces existing taxonomy. Stores taxonomy name in settings. Associated taxonomy rules (from `rules.csv`) are synced into `override_rules` at classification time (not import time). |

---

### colabip (2 channels)

---

#### `colabip:listTaxonomies`

List available taxonomies from the local ColabIP store.

| | |
|---|---|
| **Args** | none |
| **Response** | `TaxonomyInfo[]` |

```typescript
interface TaxonomyInfo {
  name: string;                               // Industry folder name
  nodeCount: number;                          // Number of .txt files
}
```

| **Notes** | Reads from `colabip/taxonomies/` directory. Does not require an open project. |

---

#### `colabip:listRulePacks`

List available rule packs from the local ColabIP store.

| | |
|---|---|
| **Args** | none |
| **Response** | `RulePackInfo[]` |

```typescript
interface RulePackInfo {
  name: string;                               // Industry/taxonomy name
  ruleCount: number;                          // Number of rules in the CSV
}
```

| **Notes** | Reads `rules.csv` files from `colabip/taxonomies/{industry}/`. Does not require an open project. |

---

### suppliers (3 channels)

---

#### `suppliers:list`

Get all suppliers in the current project with stats and metadata.

| | |
|---|---|
| **Args** | none |
| **Response** | `ProjectSupplier[]` |

```typescript
interface ProjectSupplier {
  id: string;
  supplierName: string;
  parentSupplierId: string | null;            // Self-referencing FK
  supplierType: SupplierType | null;
  supplierInfo: SupplierInfo | null;          // JSON research results
  categoryA: boolean;
  categoryATaxonomyNodeId: string | null;     // FK to taxonomy.id
  transactionCount: number;
  totalSpend: number;
  createdAt: string;
  updatedAt: string;
}
```

---

#### `suppliers:update`

Update supplier metadata.

| | |
|---|---|
| **Args** | `supplierName: string, updates: SupplierUpdateInput` |
| **Response** | `void` |

```typescript
interface SupplierUpdateInput {
  parentSupplierId?: string | null;
  supplierType?: SupplierType | null;
  categoryA?: boolean;
  categoryATaxonomyNodeId?: string | null;    // Required when categoryA = true
  supplierInfo?: SupplierInfo;
}
```

| **Notes** | Partial update. Inserts a `change_log` entry. |

---

#### `suppliers:research`

Trigger the ResearchAgent to research a specific supplier.

| | |
|---|---|
| **Args** | `supplierName: string` |
| **Response** | `SupplierResearchResult` |

| **Notes** | Calls the ResearchAgent with the supplier name and company context. Updates `supplier_type` and `supplier_info` on the `project_suppliers` row. Returns the research result for display. |

---

### rules (5 channels)

---

#### `rules:list`

Get all override rules in the current project.

| | |
|---|---|
| **Args** | none |
| **Response** | `OverrideRule[]` |

```typescript
interface OverrideRule {
  id: string;
  name: string;
  source: RuleSource;
  conditions: RuleCondition[];                // JSON: [{field, operator, value}]
  targetTaxonomyNodeId: string;               // FK to taxonomy.id
  priorityScore: number;                      // Evaluation order (lower = first)
  isActive: boolean;
  importedAt: string | null;                  // When synced from ColabIP/suppliers
  createdAt: string;
}
```

| **Notes** | Includes rules from all sources. Frontend can filter/group by `source`. |

---

#### `rules:create`

Create a new override rule.

| | |
|---|---|
| **Args** | `rule: OverrideRuleCreate` |
| **Response** | `{ id: string }` |

```typescript
interface OverrideRuleCreate {
  name: string;
  source: RuleSource;
  conditions: RuleCondition[];
  targetTaxonomyNodeId: string;               // FK to taxonomy.id
  priorityScore?: number;                     // Auto-assigned by source band if not provided
}
```

| **Notes** | Priority score bands by source: project (100-199), taxonomy (200-299), supplier (300-399). If `priorityScore` is omitted, backend assigns next available in the band. Inserts `change_log` entry. |

---

#### `rules:update`

Update an existing override rule.

| | |
|---|---|
| **Args** | `ruleId: string, updates: OverrideRuleUpdate` |
| **Response** | `void` |

```typescript
interface OverrideRuleUpdate {
  name?: string;
  conditions?: RuleCondition[];
  targetTaxonomyNodeId?: string;
  priorityScore?: number;
  isActive?: boolean;
}
```

| **Notes** | Partial update. All rules are editable regardless of source. Inserts `change_log` entry. |

---

#### `rules:delete`

Delete an override rule.

| | |
|---|---|
| **Args** | `ruleId: string` |
| **Response** | `void` |
| **Notes** | Inserts `change_log` entry. |

---

#### `rules:importFromColabip`

Import rules from a ColabIP rule pack into the current project.

| | |
|---|---|
| **Args** | `rulePack: string` — industry/taxonomy name |
| **Response** | `{ imported: number }` |
| **Notes** | Reads `colabip/taxonomies/{rulePack}/rules.csv`. Inserts rules with `source='taxonomy'`, priority_score band 200-299. Does not remove existing rules. |

---

### feedback (3 channels)

---

#### `feedback:list`

Get all system feedback suggestions.

| | |
|---|---|
| **Args** | none |
| **Response** | `SystemFeedback[]` |

```typescript
interface SystemFeedback {
  id: string;
  feedbackType: FeedbackType;
  affectedTransactionIds: string[] | null;
  suggestion: FeedbackActionDetails;          // JSON — the proposed change
  status: FeedbackStatus;
  createdAt: string;
}
```

| **Notes** | Frontend should group by `feedbackType` and filter by `status`. |

---

#### `feedback:approve`

Approve a system feedback suggestion and apply the change.

| | |
|---|---|
| **Args** | `feedbackId: string, modifications?: Partial<FeedbackActionDetails>` |
| **Response** | `void` |
| **Notes** | If `modifications` provided, the suggestion is edited before applying. Sets status to `approved`. Applies the action: updates company_context, taxonomy description, or creates an override rule depending on `feedbackType`. Inserts `change_log` entry. |

---

#### `feedback:reject`

Reject a system feedback suggestion.

| | |
|---|---|
| **Args** | `feedbackId: string, reason?: string` |
| **Response** | `void` |
| **Notes** | Sets status to `rejected`. Optional reason stored for reference. |

---

### changelog (2 channels)

---

#### `changelog:list`

Get the change log for the current project.

| | |
|---|---|
| **Args** | none |
| **Response** | `ChangeLog[]` |

---

#### `changelog:revert`

Revert a specific change.

| | |
|---|---|
| **Args** | `changeId: string` |
| **Response** | `void` |
| **Notes** | Reads `old_values` from the change log entry and restores them. Creates a **new** change log entry with source=`manual` (never deletes history). |

---

### export (2 channels)

---

#### `export:selectPath`

Open a native save dialog for CSV export.

| | |
|---|---|
| **Args** | none |
| **Response** | `string \| null` — file path, or null if cancelled |

---

#### `export:export`

Export classified transactions to a CSV file.

| | |
|---|---|
| **Args** | `filePath: string` |
| **Response** | `{ rowsExported: number }` |
| **Notes** | Exports all transactions with their current classifications. File reflects all reclassifications and applied rules at time of export. |

---

### settings (4 channels)

---

#### `settings:get`

Get current LLM provider settings.

| | |
|---|---|
| **Args** | none |
| **Response** | `AppSettings` |

```typescript
interface AppSettings {
  provider: string;                           // Current provider ID
  model: string;                              // Current model ID
  hasApiKey: boolean;                         // Whether an API key is configured
  availableProviders: string[];               // List of provider IDs
}
```

| **Notes** | Does not require an open project. |

---

#### `settings:update`

Update LLM provider, model, or API keys.

| | |
|---|---|
| **Args** | `settings: SettingsUpdateInput` |
| **Response** | `void` |

```typescript
interface SettingsUpdateInput {
  provider?: string;
  model?: string;
  apiKeys?: Record<string, string>;           // provider_id → api_key
}
```

| **Notes** | Partial update. API keys are stored in runtime memory only (not persisted to disk). Provider switch takes effect immediately for subsequent LLM calls. |

---

#### `settings:getModels`

Get available models for the current provider.

| | |
|---|---|
| **Args** | none |
| **Response** | `ModelInfo[]` |

```typescript
interface ModelInfo {
  id: string;                                 // e.g., "claude-3-5-haiku-latest"
  name: string;                               // e.g., "Claude 3.5 Haiku"
}
```

---

#### `settings:getProviders`

Get available LLM providers.

| | |
|---|---|
| **Args** | none |
| **Response** | `ProviderInfo[]` |

```typescript
interface ProviderInfo {
  id: string;                                 // e.g., "anthropic"
  name: string;                               // e.g., "Anthropic"
}
```

---

## Shared Types

These types are used across multiple channels. Full definitions provided here for reference.

### Company & Project

```typescript
interface CompanyContext {
  industry: string;
  sector?: string;
  description?: string;
  businessFocus?: string;
  procurementNuances?: string;
}

// Maps canonical column name → original CSV column name
interface CanonicalColumnMapping {
  [canonicalName: string]: string;
}

type ConfidenceLevel = "high" | "medium" | "low";
```

### Suppliers

```typescript
type SupplierType = "company" | "individual" | "government";

interface SupplierInfo {
  officialBusinessName?: string;
  description?: string;
  websiteUrl?: string;
  industry?: string;
  productsServices?: string;
  parentCompany?: string;
  supplierAddress?: string;
  serviceType?: string;
  naicsCode?: string;
  naicsDescription?: string;
  sicCode?: string;
  primaryBusinessModel?: string;
  primaryRevenueStreams?: string;
  serviceCategories?: string;
  targetMarket?: string;
}

interface SupplierResearchResult extends SupplierInfo {
  confidence: ConfidenceLevel;
  sources: string[];
}
```

### Override Rules

```typescript
type RuleSource = "project" | "taxonomy" | "supplier";

type RuleOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "in_list"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal"
  | "less_than_or_equal";

interface RuleCondition {
  field: string;                              // Canonical column name or fixed field
  operator: RuleOperator;
  value: string | number | string[];
}
```

### Classification

```typescript
type ClassificationScope = "all" | "new" | "filtered";

// In-memory only — no database table. State resets when app restarts.
type ProjectRunStatus =
  | "pending"
  | "researching"                             // Supplier research phase
  | "classifying"
  | "completed"
  | "failed"
  | "cancelled";

// In-memory run state — not persisted to database.
interface ProjectRun {
  id: string;
  scope: ClassificationScope;
  filterCriteria: TransactionFilter | null;
  status: ProjectRunStatus;
  progressTotal: number;
  progressProcessed: number;
  progressPercentage: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}
```

### Change Log

```typescript
type ChangeSource = "manual" | "pipeline";

interface ChangeLog {
  id: string;
  source: ChangeSource;
  affectedTable: string;
  affectedIds: string[];
  affectedCount: number;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  description: string | null;
  createdAt: string;
}
```

### System Feedback

```typescript
type FeedbackType =
  | "company_context"
  | "taxonomy_description"
  | "supplier_rule"
  | "uncategorized_feedback";

type FeedbackStatus = "pending" | "approved" | "rejected";

interface CompanyContextAction {
  fieldName: "industry" | "sector" | "businessFocus" | "description" | "procurementNuances";
  currentValue: string;
  proposedValue: string;
}

interface TaxonomyDescriptionAction {
  taxonomyPath: string;
  currentDescription: string;
  proposedDescription: string;
}

interface SupplierRuleAction {
  supplierName: string;
  ruleCategory: "A";
  classificationPaths: string[];
}

interface UncategorizedFeedbackAction {
  issueType:
    | "pattern_recognition"
    | "taxonomy_gap"
    | "prompt_failure"
    | "data_enrichment_needed"
    | "supplier_complexity"
    | "edge_case"
    | "other";
  description: string;
  affectedPattern: string;
  suggestedFix: string;
  exampleTransactions: string;
}

type FeedbackActionDetails =
  | CompanyContextAction
  | TaxonomyDescriptionAction
  | SupplierRuleAction
  | UncategorizedFeedbackAction;
```

### Canonical Column Definitions

Used by the CanonicalizationAgent to suggest mappings from CSV columns to canonical names.

```typescript
type CanonicalColumnRelevance = "critical" | "high" | "medium" | "low";
type CanonicalColumnType = "text" | "log_text" | "number" | "category" | "date";

interface CanonicalColumnDefinition {
  name: string;
  relevance: CanonicalColumnRelevance;
  type: CanonicalColumnType;
  aliases: string[];                          // Common CSV header names for this field
  description: string;
}
```

**Standard canonical columns:**

| Name | Relevance | Type | Description |
|------|-----------|------|-------------|
| `supplier_name` | critical | text | Name of the supplier/vendor |
| `line_description` | critical | log_text | Description of the line item |
| `gl_description` | critical | log_text | General ledger account description |
| `spend_amount` | high | number | Transaction amount |
| `gl_code` | high | category | General ledger account code |
| `department` | high | category | Department or business unit |
| `invoice_date` | medium | date | Date of the invoice/transaction |
| `creation_date` | medium | date | Date the record was created |
| `company` | medium | category | Company or legal entity |
| `cost_center` | medium | category | Cost center code |
| `po_number` | medium | text | Purchase order number |
| `supplier_address` | medium | text | Supplier's address |
| `currency` | low | category | Transaction currency |
| `memo` | low | log_text | Additional notes or memo |

---

## Channels Not in v1

The following are **excluded** from v1 (deferred to v2):

| Channel | Reason |
|---------|--------|
| `sync:pull` | ColabIP sync conflict resolution is v2 |
| `sync:push` | ColabIP sync conflict resolution is v2 |
| `sync:status` | ColabIP sync conflict resolution is v2 |
| `taxonomy:addNode` | Use `taxonomy:set` to replace full taxonomy |
| `taxonomy:updateNode` | Use `taxonomy:set` to replace full taxonomy |
| `taxonomy:deleteNode` | Use `taxonomy:set` to replace full taxonomy |
| `upload:validate` | Validation happens during `upload:csv` |
