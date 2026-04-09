# Colab91 AP Classifier — Architecture Reference

Electron desktop app for automated classification of accounts payable transactions using LLMs. Users import CSV transaction data, configure taxonomy and company context, run AI classification (with web research on suppliers), then review and correct results.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Renderer (React + Zustand)                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────────────┐  │
│  │  Pages   │  │  Stores  │  │  useIPC   │  │  ipc client       │  │
│  │ (views)  │──│ (Zustand)│──│  (hook)   │──│ (typed channels)  │  │
│  └──────────┘  └──────────┘  └───────────┘  └────────┬──────────┘  │
└───────────────────────────────────────────────────────┼─────────────┘
                         contextBridge (preload)        │
┌───────────────────────────────────────────────────────┼─────────────┐
│  Main Process (Node.js)                               ▼             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  IPC Handlers  (registerHandler → IPCResponse<T> envelope)   │   │
│  └──────────────────────┬───────────────────────────────────────┘   │
│                         │                                           │
│  ┌──────────────────────▼───────────────────────────────────────┐   │
│  │  createContainer() → ServiceContainer                        │   │
│  │                                                              │   │
│  │  ┌─ Orchestrators ──────────────────────────────────────┐    │   │
│  │  │  ClassificationRunner  SupplierResearcher  QCRunner  │    │   │
│  │  └──────────────┬───────────────────────────────────────┘    │   │
│  │  ┌─ Data Services ─────────────────────────────────────┐    │   │
│  │  │  ProjectStore   TransactionStore   TaxonomyStore    │    │   │
│  │  │  SupplierService  RuleStore  ChangelogStore         │    │   │
│  │  │  IngestService   ExportService                      │    │   │
│  │  └──────────────┬──────────────────────────────────────┘    │   │
│  │  ┌─ Agents ─────┴──────────────────────────────────────┐    │   │
│  │  │  ClassificationAgent  ResearchAgent  QCAgent        │    │   │
│  │  │  ColumnMappingAgent   FeedbackAgent  CatAAgent      │    │   │
│  │  └──────────────┬──────────────────────────────────────┘    │   │
│  │  ┌─ Leaf ───────┴──────────────────────────────────────┐    │   │
│  │  │  DuckDBDatabase  OpenRouterLLMClient  ExaWebSearch  │    │   │
│  │  │  AppConfigService  LicenseService  EventBus         │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                    │              │               │                  │
│              .c91 Files    supplier_universe.db   OpenRouter / Exa   │
│              (DuckDB)      (shared DuckDB)        APIs              │
└─────────────────────────────────────────────────────────────────────┘
```

Dependencies always point downward: Orchestrators → Data Services → Agents → Leaf. No upward or lateral dependencies except one controlled circular break (`TransactionStore ↔ ProjectStore`, resolved via `setProjectStore()` lazy reference).

---

## Main Process

### DI Container (`src/main/container.ts`)

`createContainer()` is a plain factory function (no DI framework). It instantiates every service in dependency order and returns a `ServiceContainer` object. All services receive dependencies via constructor injection.

#### Leaf Layer

| Service | Class | Dependencies | Purpose |
|---------|-------|-------------|---------|
| `db` | `DuckDBDatabase` | — | Per-project `.c91` database access |
| `appConfig` | `AppConfigService` | — | App-level config: API keys (encrypted via `safeStorage`), provider, model |
| `supplierUniverse` | `DuckDBSupplierUniverse` | appConfig | Shared `supplier_universe.db` for cross-project supplier data |
| `llm` | `OpenRouterLLMClient` | appConfig | LLM API client (routes to Claude, GPT, etc.) |
| `webSearch` | `ExaWebSearch` | appConfig | Exa API client for supplier research |
| `license` | `LicenseService` | appConfig, eventBus | License activation and periodic validation |
| `eventBus` | `AppEventBus` | — | Singleton typed event emitter; bridges async progress to renderer via `webContents.send` |

#### Agent Layer

Stateless LLM-powered agents. Each receives `llm` as its only dependency.

| Service | Class | Purpose |
|---------|-------|---------|
| `classificationAgent` | `LLMClassificationAgent` | Category selection + L3 classification |
| `researchAgent` | `LLMResearchAgent` | Supplier web research |
| `columnMappingAgent` | `LLMColumnMappingAgent` | CSV column → canonical mapping suggestions |
| `feedbackAgent` | `LLMFeedbackAgent` | Analyze user corrections, recommend improvements |
| `qcAgent` | `LLMQCAgent` | Quality-check classified transactions |
| `catAAgent` | `LLMCatAAgent` | Category A (strategic supplier) resolution |

#### Data Service Layer

Persistent stores. Order of instantiation matters for dependency resolution.

| Service | Class | Dependencies | Purpose |
|---------|-------|-------------|---------|
| `changelog` | `ChangelogStore` | db | Audit trail of all data changes with revert |
| `transactions` | `TransactionStore` | db, changelog | Transaction CRUD, queries, filtering, pivot aggregation |
| `project` | `ProjectStore` | db, transactions, supplierUniverse | Project lifecycle, settings KV store |
| `taxonomy` | `TaxonomyStore` | db, project | 3-level taxonomy CRUD, file import |
| `suppliers` | `SupplierService` | db, supplierUniverse | Supplier normalization, aliases, parents, CSV import, universe sync |
| `rules` | `RuleStore` | db, transactions, project | Override rules CRUD, groups, conflict detection, application |
| `ingest` | `IngestService` | db, transactions, suppliers, project, columnMappingAgent, eventBus | CSV import pipeline: parse, map columns, insert rows |
| `export` | `ExportService` | db | Export transactions to CSV |

#### Orchestrator Layer

Composite services that coordinate agents + data stores for multi-step workflows.

| Service | Class | Key Dependencies | Purpose |
|---------|-------|-----------------|---------|
| `classifier` | `ClassificationRunner` | classificationAgent, taxonomy, transactions, rules, project, changelog, eventBus | Full classification pipeline: scope suppliers, batch classify, emit progress |
| `researcher` | `SupplierResearcher` | researchAgent, catAAgent, classificationAgent, webSearch, supplierUniverse, suppliers, transactions, taxonomy, rules, eventBus | Supplier research + categorization: web search, extract info, assign parents/taxonomy |
| `qc` | `QCRunner` | qcAgent, transactions, supplierUniverse, project, taxonomy, suppliers, eventBus | Post-classification quality check: consolidate, flag, skip |

---

### Classification Pipeline

Classification uses a **two-call architecture**: Call 1 selects L1|L2 categories, Call 2 classifies to L3. Call 1 runs during the **research phase** (before classification starts), so by the time classification runs, every supplier already has a pre-populated `l1_l2_path` on the `project_suppliers` table.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RESEARCH PHASE (SupplierResearcher)                                    │
│                                                                         │
│  researchAll()                   categorizeWithSupplierInfo()           │
│  ┌──────────────────────┐        ┌──────────────────────────────┐      │
│  │ Per non-tail supplier │        │ Non-tail suppliers w/ info   │      │
│  │ • Web search (Exa)   │        │ but no l1_l2_path            │      │
│  │ • LLM extract info   │        │ • Batch 10 suppliers/call    │      │
│  │ • Assign parent co.  │        │ • selectCategories() → Call 1│      │
│  │ • Cat-A rule creation │        │ • Writes l1_l2_path (≤2)    │      │
│  └──────────────────────┘        └──────────────────────────────┘      │
│                                                                         │
│  categorizeTailSpend()                                                  │
│  ┌──────────────────────────────────────────────────┐                  │
│  │ Tail-spend suppliers (no supplier info available) │                  │
│  │ • Build dedup groups from transactions            │                  │
│  │ • Batch: max 10 suppliers OR 300 groups/call      │                  │
│  │ • selectCategoriesForTailSpend() → Call 1 variant │                  │
│  │ • Writes l1_l2_path (single path)                 │                  │
│  └──────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  CLASSIFICATION PHASE (ClassificationRunner.classifyAll)                 │
│                                                                         │
│  Phase 1: Rule Application                                              │
│  ┌──────────────────────────────────────────────────┐                  │
│  │ For each supplier with unclassified transactions: │                  │
│  │ • evaluateRules() → match deterministic rules     │                  │
│  │ • Batch-update matched txns → classified_by_rule  │                  │
│  │ • Remaining unmatched txns pass to Phase 2/3      │                  │
│  └──────────────────────────────────────────────────┘                  │
│                                                                         │
│  Phase 2: Non-Tail-Spend L3 Classification (5 concurrent workers)       │
│  ┌──────────────────────────────────────────────────┐                  │
│  │ Per supplier (must have l1_l2_path):              │                  │
│  │ • Merge L3 taxonomy from all l1_l2_paths          │                  │
│  │ • Build dedup groups from transactions            │                  │
│  │ • Batch groups by ~16k token limit                │                  │
│  │ • classifyL3() → Call 2                           │                  │
│  │ • Retry missed groups up to 3 times               │                  │
│  │ • Update txns → classified_by_ai                  │                  │
│  │ • Groups CAN map to different L3 paths            │                  │
│  └──────────────────────────────────────────────────┘                  │
│                                                                         │
│  Phase 3: Tail-Spend L3 Classification (5 concurrent workers)           │
│  ┌──────────────────────────────────────────────────┐                  │
│  │ Group tail-spend suppliers by L2 path:            │                  │
│  │ • Batch: max 5 suppliers OR 150 groups per call   │                  │
│  │ • classifyL3ForTailSpend() → Call 2 variant       │                  │
│  │ • Single L3 per supplier (all txns → same path)   │                  │
│  │ • Retry missing suppliers up to 3 times           │                  │
│  └──────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Key differences: non-tail-spend vs tail-spend

| Aspect | Non-Tail-Spend | Tail-Spend |
|--------|----------------|------------|
| L1\|L2 source | `categorizeWithSupplierInfo()` using supplier research | `categorizeTailSpend()` using transaction dedup groups |
| L1\|L2 paths | Up to 2 candidates | Single path |
| L3 classification | Per-supplier, multi-group (groups can map to different L3s) | Batched by L2, single L3 per supplier |
| L3 batching | Dedup groups batched by ~16k token limit | Max 5 suppliers OR 150 groups per call |
| Research | Full web search + LLM extraction | Skipped (excluded from `researchAll`) |

#### Agent method signatures

**ClassificationAgent** (`src/main/agents/classification-agent.ts`):

| Method | Input | Output | Used By |
|--------|-------|--------|---------|
| `selectCategories()` | suppliers + taxonomy + companyContext | `Map<supplierIndex, string[]>` (up to 2 L1\|L2 paths) | `categorizeWithSupplierInfo()` |
| `selectCategoriesForTailSpend()` | suppliers with grouped txn data + taxonomy + context | `Map<supplierIndex, string>` (single L1\|L2 path) | `categorizeTailSpend()` |
| `classifyL3()` | categoryPaths + l3Taxonomy + transactions + priorities | `ClassificationResult` (per-group assignments) | Phase 2 |
| `classifyL3ForTailSpend()` | categoryPath + l3Taxonomy + suppliers with groups + context | `Map<supplierIndex, string>` (single L3 per supplier) | Phase 3 |
| `classifyTransactionGroup()` | Backward-compat wrapper | `ClassificationResult` | Legacy/tests |

**ResearchAgent** (`src/main/agents/research-agent.ts`):

| Method | Input | Output |
|--------|-------|--------|
| `researchSupplier()` | supplierName, context?, address?, searchResults? | `SupplierInfo` (type, industry, products, codes, parent, confidence) |

**QCAgent** (`src/main/agents/qc-agent.ts`):

| Method | Input | Output |
|--------|-------|--------|
| `review()` | supplierSummary + rules | `QCResult` (recommendations: which groups to move where, or noChangeNeeded) |

**CatAAgent** (`src/main/agents/cat-a-agent.ts`):

| Method | Input | Output |
|--------|-------|--------|
| `resolve()` | mappedPath + taxonomyNodes | `CatAResolution` (exact match or closest semantic match in project taxonomy) |

**FeedbackAgent** (`src/main/agents/feedback-agent.ts`):

| Method | Input | Output |
|--------|-------|--------|
| `analyze()` | changelogs + userFeedback + taxonomy + companyContext + columnPriorities | `FeedbackRecommendation` (one of 6 action types with details) |

**ColumnMappingAgent** (`src/main/agents/column-mapping-agent.ts`):

| Method | Input | Output |
|--------|-------|--------|
| `suggestMappings()` | columns + sampleRows | `ColumnMappingResult` (mappings, confidence, unmapped columns, reasoning) |

#### QC Pipeline (`QCRunner.runQC`)

Post-classification quality check with two sequential passes:

1. **Algorithmic pass** — For each supplier, compute spend concentration by L3 and L2 categories. If a single L3 exceeds the threshold (default 95%), consolidate all transactions to that path. If L3 is split but a single L2 exceeds its threshold (default 90%), consolidate within the L2 branch. Suppliers are marked `algorithmicResolved` if consolidated or already clean.
2. **LLM pass** — Suppliers that were NOT resolved by the algorithmic pass (controlled by gate conditions) are sent to the QCAgent. The agent reviews dedup group summaries against configurable rules and recommends which groups to move where. Default rules: collapse tax rows for non-government suppliers, align misaligned transactions to supplier's known business, prefer consolidation to dominant category.

Both passes are configurable via `QCConfig` (thresholds, enable/disable, gate conditions, custom rules). Transactions updated by QC are marked `classified_by_qc_agent`.

#### Concurrency and resilience

- **Worker pool**: 5 concurrent workers for all phases (classification, research, categorization, QC)
- **Crash resilience**: No global state accumulation. Each supplier's results are persisted to DB immediately after classification. If the process crashes at supplier 5,000, the first 4,999 are already saved.
- **Retry logic**: Phase 2 retries missed dedup groups (up to 3 attempts). Phase 3 retries missing suppliers (up to 3 attempts). Failed retries are logged and skipped.
- **Path validation**: All LLM-returned taxonomy paths are validated against the project taxonomy. Invalid paths attempt fuzzy matching (case-insensitive, normalized, substring). Unresolvable paths are padded with "Uncategorized".

---

### IPC Handlers

All handlers are registered in `src/main/ipc/index.ts` via `registerAllHandlers(services)`. Each handler file receives its required services as arguments.

**Registration pattern** (`src/main/ipc/register.ts`):
- `registerHandler(channel, handler)` — wraps handler in `IPCResponse<T>` envelope with error catching and debug logging
- `sendEvent(window, channel, ...args)` — pushes events to renderer (no envelope)

#### Project — `src/main/ipc/project.ts` (10 handlers)

| Channel | Description |
|---------|-------------|
| `project:new` | Create new project (.c91 file) |
| `project:open` | Open existing project |
| `project:close` | Close current project |
| `project:finalizeOpen` | Finalize project load (opens supplier universe + reads settings) |
| `project:getSetting` | Get project setting by key |
| `project:setSetting` | Set project setting |
| `project:deleteSetting` | Delete project setting |
| `project:getAllSettings` | Get all project settings |
| `project:getMetadata` | Get assembled project metadata |
| `project:updateMetadata` | Update project metadata fields |

#### Ingest — `src/main/ipc/ingest.ts` (10 handlers)

| Channel | Description |
|---------|-------------|
| `ingest:selectFile` | Open file picker dialog |
| `ingest:parseCSV` | Parse CSV and return preview (columns, sample rows, row count) |
| `ingest:suggestMappings` | LLM-suggest column mappings for a CSV |
| `ingest:importCSV` | Import CSV into project with column mapping |
| `ingest:getUpload` | Get latest upload record |
| `ingest:getUploadHistory` | Get all upload records |
| `ingest:deriveMappings` | Derive mappings from LLM or a previous upload |
| `ingest:getUploadStatsBatch` | Get stats for all uploads |
| `ingest:deleteUpload` | Delete an upload and its rows |
| `ingest:getExistingCanonicals` | Get canonical column names already in the transactions table |

#### Classification — `src/main/ipc/classification.ts` (3 handlers + 1 event)

| Channel | Description |
|---------|-------------|
| `classification:start` | Start classification run (fire-and-forget) |
| `classification:stop` | Cancel running classification |
| `classification:scopeCount` | Count suppliers in classification scope |
| `classification:progress` | **Event**: real-time progress updates |

#### QC — `src/main/ipc/qc.ts` (7 handlers + 1 event)

| Channel | Description |
|---------|-------------|
| `qc:count` | Count suppliers in QC scope |
| `qc:run` | Start QC run (fire-and-forget) |
| `qc:stop` | Cancel running QC |
| `qc:isRunning` | Check if QC is currently running |
| `qc:getConfig` | Get QC configuration from project settings |
| `qc:setConfig` | Save QC configuration |
| `qc:getDefaults` | Get default QC configuration |
| `qc:progress` | **Event**: real-time QC progress updates |

#### Transactions — `src/main/ipc/transactions.ts` (12 handlers)

| Channel | Description |
|---------|-------------|
| `transactions:query` | Query transactions with pagination, filtering, sorting |
| `transactions:stats` | Get aggregate stats (total rows, spend, classified count, etc.) |
| `transactions:getColumns` | Get column names available for pivot/filtering |
| `transactions:update` | Batch-update transactions (taxonomy, status, review flags) |
| `transactions:queryGrouped` | GROUP BY a column with spend aggregation |
| `transactions:distinctValues` | Get distinct values for a column |
| `transactions:getIdsByValue` | Get transaction IDs matching a column value |
| `transactions:pivotAggregation` | Multi-dimensional pivot aggregation |
| `transactions:getIdsByConditions` | Get IDs matching filter conditions |
| `transactions:getIdsByGroupedConditions` | Get IDs matching grouped filter conditions |
| `transactions:getFilterFields` | Get available filter field definitions |
| `transactions:markAllReviewed` | Mark all transactions as reviewed |

#### Taxonomy — `src/main/ipc/taxonomy.ts` (8 handlers)

| Channel | Description |
|---------|-------------|
| `taxonomy:getNodeCount` | Count taxonomy nodes |
| `taxonomy:getNodes` | Get all taxonomy nodes |
| `taxonomy:addNode` | Add a node (L1, L2, or L3) |
| `taxonomy:updateNode` | Update node description |
| `taxonomy:renameNode` | Rename a node (cascades to children and transactions) |
| `taxonomy:mergeNodes` | Merge two nodes into one |
| `taxonomy:deleteNode` | Delete a node |
| `taxonomy:importFromFile` | Import taxonomy from ColabIP file |

#### Suppliers — `src/main/ipc/suppliers.ts` + `supplier-research.ts` (28 handlers + 1 event)

| Channel | Description |
|---------|-------------|
| `suppliers:list` | List project suppliers with pagination/filtering |
| `suppliers:listPaginated` | Server-paginated supplier list with search, sort, spend aggregation |
| `suppliers:update` | Update supplier metadata |
| `suppliers:confirm` | Confirm/reject supplier |
| `suppliers:filterTailSpend` | Mark suppliers below threshold as tail spend |
| `suppliers:getFilterFields` | Get available filter fields for supplier queries |
| `suppliers:distinctValues` | Get distinct values for a supplier field |
| `suppliers:getAliases` | Get aliases for a supplier |
| `suppliers:getAllAliasesWithSpend` | Get aliases with transaction count + spend aggregates for all suppliers (keyed by supplier id) |
| `suppliers:assignAlias` | Assign an alias to a supplier |
| `suppliers:rename` | Rename a supplier |
| `suppliers:merge` | Merge multiple suppliers into one |
| `suppliers:delete` | Delete a supplier |
| `suppliers:listParents` | List parent companies |
| `suppliers:addParent` | Add a parent company |
| `suppliers:assignParent` | Assign a parent to suppliers |
| `suppliers:renameParent` | Rename a parent company |
| `suppliers:deleteParent` | Delete a parent company |
| `suppliers:mergeParents` | Merge parent companies |
| `suppliers:parseCSV` | Parse a supplier CSV for import |
| `suppliers:importCSV` | Import suppliers from CSV |
| `suppliers:computeCsvDiff` | Preview changes from a supplier CSV |
| `suppliers:applyCsvDiff` | Apply previewed CSV changes |
| `suppliers:syncToUniverse` | Sync project suppliers to shared supplier universe |
| `suppliers:researchAll` | Research all suppliers via web (fire-and-forget) |
| `suppliers:categorizeAll` | Categorize all suppliers (fire-and-forget) |
| `suppliers:cancelResearch` | Cancel running research |
| `suppliers:researchSingle` | Research a single supplier |
| `suppliers:research:progress` | **Event**: real-time research progress |

#### Rules — `src/main/ipc/rules.ts` (20 handlers)

| Channel | Description |
|---------|-------------|
| `rules:list` | Get all rules |
| `rules:listPaginated` | Get rules with pagination |
| `rules:listByGroup` | List rules in a specific group with pagination |
| `rules:create` | Create a rule |
| `rules:createAndApply` | Create a rule and immediately apply it |
| `rules:update` | Update a rule |
| `rules:delete` | Delete a rule (with cascade cleanup) |
| `rules:previewConflicts` | Preview conflicts before creating a rule |
| `rules:generate` | Auto-generate rules from classified data |
| `rules:listGroups` | List rule groups |
| `rules:createGroup` | Create a rule group |
| `rules:updateGroup` | Update a rule group |
| `rules:deleteGroup` | Delete a rule group |
| `rules:reorderGroups` | Reorder rule groups by priority |
| `rules:moveRule` | Move a rule to a different group |
| `rules:assignToGroup` | Assign rules to a group by IDs |
| `rules:filterAssign` | Assign rules to a group by filter |
| `rules:previewApply` | Preview what applying rules would change |
| `rules:apply` | Apply rules to transactions |
| `rules:setCategoryA` | Set category-A flag on a rule and update associated suppliers |

#### Changelog — `src/main/ipc/changelog.ts` (3 handlers)

| Channel | Description |
|---------|-------------|
| `changelog:list` | List changes with pagination and filtering |
| `changelog:revert` | Revert a change (undo) |
| `changelog:listByRule` | List changes associated with a specific rule |

#### Feedback — `src/main/ipc/feedback.ts` (2 handlers)

| Channel | Description |
|---------|-------------|
| `feedback:analyze` | Analyze user corrections via LLM and recommend improvements |
| `feedback:apply` | Apply a feedback recommendation |

#### Export — `src/main/ipc/export.ts` (3 handlers)

| Channel | Description |
|---------|-------------|
| `export:columns` | Get available export columns |
| `export:csv` | Export transactions to CSV |
| `export:saveContent` | Save arbitrary content to file (file dialog) |

#### Settings — `src/main/ipc/settings.ts` (11 handlers)

| Channel | Description |
|---------|-------------|
| `settings:getLLMConfig` | Get current LLM configuration |
| `settings:setApiKey` | Set API key for a provider |
| `settings:setProvider` | Set LLM provider |
| `settings:setModel` | Set LLM model |
| `settings:validateApiKey` | Validate an API key against the provider |
| `settings:validateStoredApiKey` | Validate the currently stored API key for a provider |
| `settings:validateModel` | Validate a model against a provider/key |
| `settings:validateStoredModel` | Validate the currently stored model |
| `settings:setExaKey` | Set Exa.ai API key |
| `settings:validateExaKey` | Validate an Exa key |
| `settings:validateStoredExaKey` | Validate the currently stored Exa key |

#### Supplier Universe — `src/main/ipc/supplier-universe.ts` (3 handlers)

| Channel | Description |
|---------|-------------|
| `supplier-universe:getPath` | Get configured universe DB path |
| `supplier-universe:selectFile` | File picker to select an existing universe DB |
| `supplier-universe:createNew` | Create a new universe DB (file dialog) |

#### License — `src/main/ipc/license.ts` (3 handlers + 1 event)

| Channel | Description |
|---------|-------------|
| `license:activate` | Activate a license key |
| `license:getStatus` | Get current license status |
| `license:checkNow` | Force a license check |
| `license:statusChanged` | **Event**: license status changed |

#### Shell — `src/main/ipc/shell.ts` (1 handler)

| Channel | Description |
|---------|-------------|
| `shell:openExternal` | Open a URL in the system browser |

#### Test — `src/main/ipc/index.ts` (1 handler)

| Channel | Description |
|---------|-------------|
| `test:ping` | Returns `'pong'` — connectivity check |

**Totals: 125 invoke handlers, 5 event channels, 14 namespaces.**

---

## Renderer (Frontend)

### Routing

React Router v6 with `HashRouter` (required for Electron). All routes are nested under `/project`. The `AppShell` component uses a keep-alive pattern: pages persist in the DOM when navigated away, preserving scroll position and local state.

#### Workflow Steps (sequential process)

| Route | Page | Purpose |
|-------|------|---------|
| `/project` | ProjectView | Create/open project, configure supplier universe |
| `/taxonomy` | TaxonomyView | Import and manage taxonomy nodes |
| `/data` | DataView | CSV upload → column mapping → priority selection (3 substeps) |
| `/classification` | ClassificationView | Run LLM classification |
| `/suppliers` | SuppliersView | Supplier management, research, categorization |
| `/review` | ReviewView | Manual QC review and pivot analysis |

#### Project Views (accessible anytime)

| Route | Page | Purpose |
|-------|------|---------|
| `/override-rules` | OverrideRulesView | Create and manage override rules |
| `/version-history` | VersionHistoryView | Audit changelog |
| `/sync-to-universe` | SyncToUniverseView | Export to supplier universe |

### State Management (Zustand)

| Store | File | Persistence | Purpose |
|-------|------|-------------|---------|
| `workflowStore` | `stores/workflowStore.ts` | localStorage `c91-workflow` v5 | Core state: project metadata, gate flags (hasTaxonomy, hasUploadedData, etc.), classification/QC/research progress, lastRoute |
| `licenseStore` | `stores/licenseStore.ts` | localStorage `c91-license` v1 | License status, grace period |
| `pivotStore` | `stores/pivotStore.ts` | localStorage `c91-pivot` v4 | Pivot table config: row dimensions, aggregation, display mode |
| `supplierFilterStore` | `stores/supplierFilterStore.ts` | In-memory only | Advanced supplier filter state |

Key patterns:
- Zustand `persist` middleware for localStorage hydration
- Store actions call `ipc.*` directly — components read store via hooks
- `workflowStore` manages event subscriptions for classification/QC/research progress
- Page state resets on project switch to prevent stale data

### IPC Communication

**Preload bridge** (`src/preload/index.ts`): Exposes `window.electronAPI` via `contextBridge` with three methods:
- `invoke(channel, ...args)` — send IPC call, receive `IPCResponse<T>`
- `on(channel, callback)` — subscribe to events, returns unsubscribe function
- `removeAllListeners(channel)` — cleanup

**Typed IPC client** (`src/renderer/lib/ipc.ts`): Namespace-organized object (`ipc.project.*`, `ipc.transactions.*`, etc.) with full TypeScript type safety via `IPCInvokeMap`. The generic `invoke()` unwraps the `IPCResponse` envelope and throws typed errors.

**useIPC hook** (`src/renderer/hooks/useIPC.ts`): Generic async data fetcher with loading/error/refetch states and memory-leak protection via `mountedRef`. Dependency array triggers refetches.

---

## Shared Types (`src/shared/types/`)

All types are re-exported from `src/shared/types/index.ts`.

### Core Data Models

| Type | File | Description |
|------|------|-------------|
| `Transaction` | `transactions.ts` | Full transaction record: id, taxonomy, status, review flags, canonical fields, timestamps |
| `TransactionStats` | `transactions.ts` | Aggregates: totalRows, totalSpend, uniqueSuppliers, classified/unclassified counts |
| `PaginatedTransactions` | `transactions.ts` | Paginated result: rows, totalCount, page, pageSize |
| `TaxonomyNode` | `taxonomy.ts` | Node: id, fullPath, l1/l2/l3, depth, description, parentPath |
| `ProjectSupplier` | `suppliers.ts` | Per-project supplier: confirmation status, tail spend, parent, taxonomy, research flag |
| `ProjectSupplierView` | `suppliers.ts` | ProjectSupplier extended with transactionCount + totalSpend |
| `SupplierInfo` | `suppliers.ts` | Rich supplier metadata from research: type, description, website, industry, products, codes |
| `SupplierParent` | `suppliers.ts` | Parent company: id, name |
| `OverrideRule` | `rules.ts` | Rule: id, name, groupedConditions, target taxonomy node, group, active flag, source |
| `RuleGroup` | `rules.ts` | Rule group: id, name, priority |
| `ChangeLog` | `changelog.ts` | Audit entry: source, affected table/ids, old/new values, description |
| `CompanyContext` | `project.ts` | Company metadata: name, industry, description, sisterCompanies |
| `ProjectMetadata` | `project.ts` | Project state: id, name, filePath, companyContext, taxonomyName, tailSpendThreshold |

### Filtering & Querying

| Type | File | Description |
|------|------|-------------|
| `TransactionFilter` | `transactions.ts` | Complex filter: supplier, taxonomy, status, spend range, conditions, pagination, sort |
| `FilterCondition` | `transactions.ts` | Single condition: field, operator, value, connector |
| `ConditionGroup` | `transactions.ts` | Group of AND/OR conditions |
| `GroupedFilter` | `transactions.ts` | Multiple condition groups with top-level connector |
| `FilterOperator` | `transactions.ts` | 15 operators: equals, contains, regex, in_list, is_null, greater_than, etc. |
| `FieldType` | `transactions.ts` | `'string' \| 'number' \| 'boolean' \| 'enum'` |
| `FieldDefinition` | `transactions.ts` | Filter field definition: name, label, type, enumValues, suggestions, group |
| `GroupedRow` | `transactions.ts` | GROUP BY row: value, amount, count |
| `GroupedTransactionsResult` | `transactions.ts` | Full GROUP BY result |
| `PivotAggregationRow` | `transactions.ts` | Multi-dimensional pivot row: dimensions, amount, count |
| `PivotAggregationResult` | `transactions.ts` | Full pivot result |

### Column Mapping & Ingest

| Type | File | Description |
|------|------|-------------|
| `ColumnMapping` | `column-mapping.ts` | Simple map: canonicalName → csvColumn |
| `ColumnMappingWithPriority` | `column-mapping.ts` | Enriched map: canonicalName → { csvColumn, classificationPriority? } |
| `CanonicalColumnDefinition` | `column-mapping.ts` | Canonical column: name, type, aliases, description |
| `CSVPreview` | `column-mapping.ts` | CSV preview: columns, sampleRows, totalRows |
| `ColumnMappingResult` | `column-mapping.ts` | LLM mapping result: mappings, confidence, unmapped columns, reasoning |
| `MappingRow` | `column-mapping.ts` | Single mapping row for UI: canonical ↔ csvColumn |
| `DerivedMappings` | `column-mapping.ts` | Backend mapping result: rows + existingCanonicals |
| `CompletedUpload` | `column-mapping.ts` | Upload summary: id, fileName, rowCount, mappings |
| `ConfidenceLevel` | `column-mapping.ts` | `'high' \| 'medium' \| 'low'` |

### Classification & Progress

| Type | File | Description |
|------|------|-------------|
| `ClassificationStatus` | `classification.ts` | `'unclassified' \| 'classified_by_rule' \| 'classified_by_ai' \| 'classified_by_qc_agent' \| 'classification_error'` |
| `ClassificationInput` | `classification.ts` | Agent input: transactions, taxonomy, companyContext, supplierResearch, columnPriorities |
| `ClassificationEntry` | `classification.ts` | Single result: id + classificationPath |
| `ClassificationResult` | `classification.ts` | Full result: classifications[] + assignments map |
| `CategorySelectionInput` | `classification.ts` | Category selection input: suppliers, taxonomy, companyContext |
| `L3ClassificationInput` | `classification.ts` | L3 input: categoryPaths, l3Taxonomy, transactions, priorities |
| `TailSpendCategorySelectionInput` | `classification.ts` | Tail spend category input: suppliers with grouped data |
| `TailSpendL3Input` | `classification.ts` | Tail spend L3 input: categoryPath, l3Taxonomy, grouped suppliers |
| `ClassificationProgress` | `classification.ts` | Progress: status, supplier counts, percentages, current supplier, step |
| `ResearchProgress` | `classification.ts` | Research progress: status, counts, current supplier, step |
| `IngestProgress` | `classification.ts` | Ingest progress: status, row counts, step, result?, error? |
| `QCOutcome` | `classification.ts` | `'clean' \| 'consolidated' \| 'flagged' \| 'skipped'` |
| `QCConfig` | `classification.ts` | QC config: scope, algorithmic thresholds, LLM conditions/rules |
| `QCResult` | `classification.ts` | QC result: recommendations[], noChangeNeeded |
| `QCProgress` | `classification.ts` | QC progress: status, counts, current supplier, step, outcome |

### Feedback

| Type | File | Description |
|------|------|-------------|
| `FeedbackActionType` | `feedback.ts` | 6 action types: update_taxonomy_description, update_supplier_info, update_company_context, update_column_priority, create_rule, no_change |
| `FeedbackDetails` | `feedback.ts` | Discriminated union of detail variants per action type |
| `FeedbackRecommendation` | `feedback.ts` | Recommendation: action, reasoning, details |
| `FeedbackAnalyzeInput` | `feedback.ts` | Input: changelogIds + userFeedback |
| `FeedbackApplyInput` | `feedback.ts` | Input: recommendation to apply |
| `FeedbackAgentInput` | `feedback.ts` | Agent input: changelogs, userFeedback, taxonomy, companyContext, columnPriorities |

### Rules

| Type | File | Description |
|------|------|-------------|
| `RuleSource` | `rules.ts` | `'manual' \| 'auto_generated' \| 'supplier_universe'` |
| `OverrideRuleCreate` | `rules.ts` | Create input: name, groupedConditions, targetTaxonomyNodeId |
| `OverrideRuleUpdate` | `rules.ts` | Partial update: name?, conditions?, target?, active? |
| `ConflictRow` | `rules.ts` | Conflict: transactionId, existingRuleId, existingRuleName |
| `GenerateRulesResult` | `rules.ts` | Generation stats: rulesCreated, suppliersProcessed |
| `RuleGroupCreate` | `rules.ts` | Group create: name, priority |
| `RuleGroupUpdate` | `rules.ts` | Group update: name?, priority? |

### Changelog

| Type | File | Description |
|------|------|-------------|
| `ChangeSource` | `changelog.ts` | `'manual' \| 'pipeline' \| 'rule' \| 'feedback'` |
| `ChangelogFilter` | `changelog.ts` | Filter: search?, viewFilter?, pagination |
| `PaginatedChangelog` | `changelog.ts` | Paginated result |

### Supplier Operations

| Type | File | Description |
|------|------|-------------|
| `SupplierConfirmationStatus` | `suppliers.ts` | `'pending' \| 'confirmed' \| 'rejected' \| 'merged'` |
| `SupplierType` | `suppliers.ts` | `'company' \| 'individual' \| 'government'` |
| `SupplierUpdateInput` | `suppliers.ts` | Update: supplierInfo?, aliases?, taxonomyPaths?, categoryA? |
| `CsvApplyRow` | `suppliers.ts` | CSV row: parentName, supplierName, aliases |
| `CsvApplyDiff` | `suppliers.ts` | Diff: renames, merges, alias reassignments, parent ops, warnings |
| `CsvApplyResult` | `suppliers.ts` | Result: applied, diff, noChanges |

### License

| Type | File | Description |
|------|------|-------------|
| `LicenseState` | `license.ts` | `'unlicensed' \| 'valid' \| 'expired' \| 'revoked' \| 'check_failed'` |
| `LicenseStatus` | `license.ts` | Status: state, licenseKey (masked), expiresAt, tier, message, graceDeadline |
| `LicenseActivationResult` | `license.ts` | Result: success, status, error? |
| `LicenseServerPayload` | `license.ts` | Server payload: valid, key, nonce, timestamp, expiresAt, tier |
| `LicenseServerResponse` | `license.ts` | Response: payload + Ed25519 signature |

### IPC Type Safety

| Type | File | Description |
|------|------|-------------|
| `IPCResponse<T>` | `ipc.ts` | Response envelope: `{ success, data?, error?, errorCode? }` |
| `IPCInvokeMap` | `ipc-contract.ts` | Complete type-safe channel map: channel → [args, result] |
| `IPCEventMap` | `ipc-contract.ts` | Event channel map for 5 event streams |
| `IPCChannel` | `ipc-contract.ts` | Union of all channel name strings |
| `IPCArgs<K>` | `ipc-contract.ts` | Extract args tuple for a channel |
| `IPCResult<K>` | `ipc-contract.ts` | Extract result type for a channel |
| `LLMConfigResponse` | `ipc-contract.ts` | LLM config response: provider, model, key-availability booleans |

### Service Interfaces (`src/shared/types/services.ts`)

Every service has an interface defined here; implementations live in `src/main/services/`.

| Interface | Implemented By | Purpose |
|-----------|---------------|---------|
| `Database` | `DuckDBDatabase` | DB operations: open, close, run, exec, all, get |
| `SupplierUniverse` | `DuckDBSupplierUniverse` | Shared supplier DB: configure, search, get, sync |
| `EventBus` | `AppEventBus` | Typed event emitter: emit, on, off |
| `LLMClient` | `OpenRouterLLMClient` | LLM chat: systemPrompt, userPrompt, options? |
| `WebSearch` | `ExaWebSearch` | Web search: isAvailable, searchSupplier |
| `IAppConfigService` | `AppConfigService` | App config: API keys, provider, model, Exa key, universe path |
| `ILicenseService` | `LicenseService` | License: activate, getStatus, checkNow, periodic checks |
| `ClassificationAgent` | `LLMClassificationAgent` | selectCategories, classifyL3 |
| `ResearchAgent` | `LLMResearchAgent` | Research a supplier via web search + LLM |
| `ColumnMappingAgent` | `LLMColumnMappingAgent` | Suggest CSV column mappings |
| `FeedbackAgent` | `LLMFeedbackAgent` | Analyze user corrections |
| `QCAgent` | `LLMQCAgent` | Quality-check transactions |
| `CatAAgent` | `LLMCatAAgent` | Category A resolution |
| `ProjectStore` | `ProjectStore` | Project lifecycle + settings KV |
| `TransactionStore` | `TransactionStore` | Transaction CRUD, queries, pivots |
| `TaxonomyStore` | `TaxonomyStore` | Taxonomy CRUD + file import |
| `SupplierService` | `SupplierService` | Supplier operations + universe sync |
| `RuleStore` | `RuleStore` | Rule CRUD, groups, apply, conflicts |
| `ChangelogStore` | `ChangelogStore` | Audit trail + revert |
| `IngestService` | `IngestService` | CSV ingest pipeline |
| `ExportService` | `ExportService` | CSV export |
| `ClassificationRunner` | `ClassificationRunner` | Classification orchestrator |
| `SupplierResearcher` | `SupplierResearcher` | Research orchestrator |
| `QCRunner` | `QCRunner` | QC orchestrator |

### Shared Constants

| Export | File | Description |
|--------|------|-------------|
| `CANONICAL_COLUMNS` | `canonical-columns.ts` | Array of 14 canonical AP column definitions (3 required, 11 optional) |
| `REQUIRED_CANONICAL_COLUMNS` | `canonical-columns.ts` | Tuple: `supplier_name`, `spend_amount`, `master_date` |
| `VIRTUAL_COLUMN_REGISTRY` | `virtual-columns.ts` | Map of 10 virtual column names → SQL expressions + required joins |
| `VIRTUAL_COLUMN_NAMES` | `virtual-columns.ts` | Set of virtual column names |

### Renderer-Only Types

| Type | File | Description |
|------|------|-------------|
| `PivotTreeNode` | `renderer/types/pivot.ts` | Hierarchical tree node for pivot display |
| `HierarchicalPivotData` | `renderer/types/pivot.ts` | Full pivot tree: root, grandTotal, rowDimensions |
| `FlattenedPivotRow` | `renderer/types/pivot.ts` | Flattened row for table rendering |
| `PathSegment` | `renderer/types/pivot.ts` | Segment in root-to-row path |
| `Aggregation` | `renderer/types/pivot.ts` | `'sum' \| 'count' \| 'average'` |
| `SpendDisplayMode` | `renderer/types/pivot.ts` | `'absolute' \| 'percentage' \| 'both'` |

---

## Storage

### Project Files (`.c91`)

Each project is a single DuckDB file. Location is user-chosen via Electron's save dialog (no app-managed default directory); the repo's `./projects/` is a dev/test scratch dir only. Key tables:

- `project_settings` — key-value store for project metadata and config
- `transactions` — dynamic schema; canonical columns added via ALTER TABLE at import time
- `uploads` — upload history with column mappings (enriched with priorities)
- `taxonomy_nodes` — 3-level hierarchy (L1 → L2 → L3, pipe-delimited paths)
- `project_suppliers` — per-project supplier records with FK to taxonomy (aliases are derived from distinct `original_supplier_name` values on `transactions`, not a separate table)
- `supplier_parents` — parent company records
- `override_rules` — classification override rules
- `rule_groups` — rule grouping with priority ordering
- `changelog` — full audit trail of all changes

### Supplier Universe (`supplier_universe.db`)

Shared DuckDB file holding global supplier data, aliases, and research info across all projects. Path is user-configured per-machine via `AppConfigService.setSupplierUniversePath()` — there is no built-in default location (the repo's `colabip/` directory is a dev convention only).

---

## Environment, Logging & Configuration

### Environment Variables

Loaded by `src/main/load-env.ts` — a lightweight, dependency-free `.env` parser (no `dotenv`). Called first in `src/main/index.ts` before any service imports. System env vars take precedence (`.env` only fills gaps).

| Variable | Purpose |
|----------|---------|
| `CLASSIFIER_LLM_PROVIDER` | LLM provider override (`openrouter`, `anthropic`, `openai`) |
| `CLASSIFIER_MODEL` | Model override (e.g. `claude-3-5-haiku-latest`) |
| `OPENROUTER_API_KEY` | OpenRouter API key (primary) |
| `ANTHROPIC_API_KEY` | Anthropic API key (fallback) |
| `OPENAI_API_KEY` | OpenAI API key (fallback) |
| `EXA_API_KEY` | Exa.ai web search API key |
| `LOG_FILE` | Path to debug log file (opt-in; noop if unset) |
| `LLM_TRACE_FILE` | Path to LLM trace JSONL file (opt-in; records raw LLM request/response) |

**Primary configuration** is via the Settings UI, which writes to `llm-config.json` in `app.getPath('userData')`. API keys are encrypted via Electron `safeStorage`. The env vars serve as fallbacks for development or headless use.

### Debug Logging (`src/main/utils/debug-log.ts`)

Opt-in, zero-overhead when disabled. Controlled by the `LOG_FILE` env var.

```bash
npm run dev          # no logging (noop)
npm run dev:log      # logs to /tmp/c91-debug.log
LOG_FILE=/custom/path.log npm run dev  # custom path
```

- `debugLog(level, msg, data?)` — levels: `INFO`, `WARN`, `ERROR`
- Format: `[HH:MM:SS.mmm] LEVEL MSG {json_data}`
- Appends synchronously to the file; returns immediately if `LOG_FILE` is unset

Follow live: `tail -f /tmp/c91-debug.log`

### LLM Tracing

When `LLM_TRACE_FILE` is set, raw LLM requests and responses are written as JSONL for debugging prompt/response issues.

```bash
npm run dev:trace    # traces to /tmp/c91-trace.jsonl
```

---

## CI/CD

### GitHub Action: Build & Release (`.github/workflows/build-release.yml`)

**Triggers:**
- Push to `main` branch
- Manual dispatch (`workflow_dispatch`) with optional version input

**Matrix:** macOS (latest) + Windows (latest)

**Steps:**
1. Checkout code
2. Setup Node.js v20 with npm cache
3. `npm ci`
4. Verify DuckDB native bindings
5. `npm run build`
6. Package and publish with `electron-builder --publish always` (uses `GH_TOKEN` secret)
7. Verify unpacked native modules in release artifacts

Releases are published automatically to GitHub Releases on every push to `main`.

---

## npm Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Run main + renderer in parallel (concurrently) |
| `npm run dev:log` | Dev with debug logging to `/tmp/c91-debug.log` |
| `npm run dev:trace` | Dev with debug logging + LLM trace to `/tmp/c91-trace.jsonl` |
| `npm run dev:main` | Compile + run Electron main process only |
| `npm run dev:renderer` | Run Vite dev server only |
| `npm run build` | Production build (main + renderer) |
| `npm run build:main` | Compile main process TypeScript |
| `npm run build:renderer` | Vite production build |
| `npm run build:dist` | Full build + electron-builder package |
| `npm run test` | Run all Vitest tests once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:mock` | Classifier integration test with mocked LLM |
| `npm run test:run` | Classifier E2E test with real LLM |
| `npm run test:integration` | All integration tests |
| `npm run typecheck` | Type-check main + renderer (no emit) |

---

## Key Conventions

- **IPC channels**: `namespace:method` naming. All return `IPCResponse<T>`. Events do not use the envelope.
- **Taxonomy paths**: Pipe-delimited 3-level hierarchy: `"Corporate Services|IT|Software"`
- **Override rules**: Priority is a simple integer (lower = higher priority). Conditions are `{field, operator, value}` AND-groups; first match wins.
- **Canonical columns**: CSV columns map to snake_case names (`supplier_name`, `spend_amount`, etc.). `transactions` table schema is dynamic — columns added via ALTER TABLE at import.
- **Supplier model**: FK-based. Transactions reference suppliers via `project_supplier_id`. `original_supplier_name` preserves raw CSV values.
- **LLM defaults**: `claude-3-5-haiku-latest` via `openrouter`. Configurable in Settings UI or env vars.
