# Test Specifications

Comprehensive test plan for the Colab91 AP Classifier. Each section lists what needs testing — write specs below each heading.

**Test runner:** Vitest 3.0.5 | **Environment:** Node.js | **Coverage:** v8 | **Pool:** forks
**Include:** `tests/**/*.test.ts` (`.ts` only — no `.tsx`) | **Alias:** `@shared` → `src/shared`
**Fixtures:** `tests/fixtures/colabip/` (taxonomies, supplier_universe.csv), `tests/fixtures/csv/` (standard, semicolon, tab, special-chars, large)

---

## Unit Tests — Services

### `src/main/services/database.ts`

**Test file:** `tests/unit/services/database.test.ts` (exists)

Exports (two singleton instances):
- `databaseService.openDatabase(filePath)` — opens DuckDB, initializes 5-table schema, handles WAL corruption
- `databaseService.closeDatabase()` — checkpoints WAL, closes connection
- `databaseService.isOpen()` — returns connection status
- `databaseService.getFilePath()` — returns current file path
- `databaseService.getExpectedTables()` — returns `['project', 'taxonomy', 'transactions', 'override_rules', 'change_log']`
- `databaseService.run(sql, ...params)` — parameterized execute (no results)
- `databaseService.exec(sql)` — batch SQL execution
- `databaseService.all<T>(sql, ...params)` — query with result rows
- `databaseService.get<T>(sql, ...params)` — single row query
- `supplierUniverseService.setDefaultPath(p)` — sets default path for supplier_universe.db
- `supplierUniverseService.open(filePath?)` — opens shared supplier_universe.db
- `supplierUniverseService.close()` — closes supplier universe connection
- `supplierUniverseService.isOpen()` — returns connection status
- `supplierUniverseService.run/exec/all/get(...)` — same query interface as databaseService

Internal (not exported): `convertPlaceholders(sql)`, `EXPECTED_TABLES`

**Specs:**


---

### `src/main/services/project.ts`

**Test file:** `tests/unit/services/project.test.ts` (exists)

Exports:
- `createProject(name, filePath)` — creates .c91 file, initializes schema, inserts project row, opens supplier universe
- `openProject(filePath)` — opens existing project, validates 5-table schema, ensures indexes
- `closeProject()` — closes DB connections, invalidates column cache
- `isProjectOpen()` — returns boolean
- `getMetadata()` — reads single-row project table, parses company_context + column_mapping JSON
- `updateMetadata(updates)` — dynamic UPDATE on project row with change logging
- `selectSavePath()` — Electron save dialog
- `selectOpenPath()` — Electron open dialog

Dependencies: databaseService, supplierUniverseService, invalidateColumnCache, ensureIndexes

**Specs:**


---

### `src/main/services/transactions.ts`

**Test file:** `tests/unit/services/transactions.test.ts` (exists)

Exports:
- `invalidateColumnCache()` — clears cached column list
- `conditionToSQL(condition, params)` — builds SQL clause from FilterCondition, mutates params array
- `buildWhereClause(conditions)` — builds parameterized WHERE from conditions array (shared filter engine used by rules + UI)
- `queryTransactions(filters?)` — paginated query joining taxonomy, excludes metadata columns
- `getStats()` — aggregate stats (row count, spend sum, distinct suppliers, classified count)
- `getColumns()` — discovers transaction columns from DB (cached after first call)
- `getCount(filters?)` — count matching rows using shared filter engine
- `queryTransactionsPaginated(filters?)` — returns rows + totalCount
- `updateTransactions(update, source?)` — updates rows + logs old values to change_log

Constants: `BASE_COLUMNS` (immutable system columns)

**Specs:**


---

### `src/main/services/taxonomy.ts`

**Test file:** `tests/unit/services/taxonomy.test.ts` (exists)

Exports:
- `getNodes()` — returns all taxonomy nodes ordered by path
- `addNode(fullPath, description?)` — validates parent exists, prevents duplicates, auto-generates UUID
- `updateNode(nodeId, {description?})` — dynamic UPDATE
- `deleteNode(nodeId)` — checks for children and transaction references before delete
- `importFromColabip(industryName)` — clears existing nodes, reads from ColabIP, inserts all, updates project metadata

Helpers: `parsePath(fullPath)` — parses `"L1|L2|L3"` into `{l1, l2, l3, depth, parentPath}`

**Specs:**


---

### `src/main/services/suppliers.ts`

**Test file:** `tests/unit/services/suppliers.test.ts` (exists)

Exports:
- `listProjectSuppliers()` — derives supplier list from `SELECT DISTINCT supplier_name FROM transactions`, joins with supplier_universe.db
- `getSupplierByName(name)` — case-sensitive lookup in supplier_universe.db
- `getSuppliersByNames(names)` — batch lookup returning Map
- `updateSupplier(supplierName, updates)` — dynamic UPDATE in supplier_universe.db
- `upsertSupplier(supplierName, data)` — insert or update in supplier_universe.db

**Specs:**


---

### `src/main/services/rules.ts`

**Test file:** `tests/unit/services/rules.test.ts` (exists)

Exports:
- `listRules()` — returns all rules ordered by priority_score
- `createRule(input)` — creates rule with auto-assigned priority
- `updateRule(ruleId, updates)` — dynamic UPDATE
- `deleteRule(ruleId)` — hard delete
- `evaluateRules(transactionIds?)` — evaluates all rules against transactions using `buildWhereClause`, first match wins, returns `Map<txnId, {ruleId, targetTaxonomyNodeId}>`

Dependencies: imports `buildWhereClause` from transactions.ts

**Specs:**


---

### `src/main/services/classification.ts`

**Test file:** `tests/unit/services/classification.test.ts` (exists)

Exports:
- `setMainWindow(win)` — sets window ref for progress events
- `getIsRunning()` — returns boolean
- `pause()` / `resume()` / `cancel()` — pipeline flow control
- `startClassification()` — zero-arg; reads state internally from DB. Main loop: gets unclassified suppliers, applies rules, calls LLM per supplier group, emits progress with runId + phase
- `cleanDescription(desc)` — strips numeric prefixes (pure function)

State: `isRunning`, `isPaused`, `isCancelled`, `currentRunId`
Events emitted: `classification:progress` with `{runId, phase, status, totalSuppliers, processedSuppliers, percentage, currentSupplier, currentStep}`

**Specs:**


---

### `src/main/services/upload.ts`

**Test file:** `tests/unit/services/upload.test.ts` (exists)

Exports:
- `selectFile()` — Electron file dialog
- `parseCSVPreview(filePath)` — detects encoding/delimiter/BOM, parses first 10 rows
- `parsePreview(filePath)` — parseCSVPreview + LLM column mapping suggestions
- `importCSV(filePath, columnMapping?)` — parses full CSV, ALTER TABLE for columns, batch INSERT (500 rows), saves column_mapping to project metadata

Helpers: `detectEncoding(buffer)`, `stripBom(content)`, `detectDelimiter(content)`, `tryParseWithDelimiter(content, delimiter)`

**Specs:**


---

### `src/main/services/llm-client.ts`

**Test file:** `tests/unit/services/llm-client.test.ts` (exists)

Exports:
- `chat(systemPrompt, userPrompt, options?)` — multi-provider LLM call with retries
- `LLMClientError` — error class with code + statusCode

Helpers:
- `getEnvSettings()` — reads CLASSIFIER_LLM_PROVIDER + CLASSIFIER_MODEL from process.env
- `getApiKeyForProvider(provider)` — reads API key from env (anthropic/openai/openrouter)
- `isRetryableStatus(status, errorBody?)` — 429/5xx detection
- `isQuotaExhausted(errorBody)` — OpenAI quota detection
- `retryDelay(attempt, retryAfterHeader?)` — exponential backoff
- `buildAnthropicBody(...)` / `buildOpenAIBody(...)` — request format builders
- `buildHeaders(provider, apiKey, format)` — auth headers
- `extractAnthropicText(data)` / `extractOpenAIText(data)` — response parsers

Constants: `MAX_RETRIES=6`, `REQUEST_TIMEOUT_MS=60_000`, `INITIAL_RETRY_DELAY_MS=1_000`

**Specs:**


---

### `src/main/services/changelog.ts`

**Test file:** `tests/unit/services/changelog.test.ts` (exists)

Exports:
- `listChanges()` — returns all changes ordered by created DESC
- `logChange(entry)` — INSERT change log, returns ID
- `revertChange(changeId)` — applies old_values UPDATE, logs new revert change

**Specs:**


---

### `src/main/services/export.ts`

**Test file:** `tests/unit/services/export.test.ts` (exists)

Exports:
- `exportCSV()` — shows save dialog, queries all transactions with taxonomy, writes CSV

Helpers: `escapeCSV(value)` — field escaping

**Specs:**


---

### `src/main/services/colabip.ts`

**Test file:** `tests/unit/services/colabip.test.ts` (exists)

Exports:
- `setColabipBasePath(p)` / `getColabipBasePath()` — configurable base path
- `listTaxonomies()` — reads `taxonomies/` directory
- `readTaxonomy(industryName)` — parses taxonomy.txt, auto-generates parent nodes
- `readRulePack(industryName)` — parses rules.csv, JSON.parses conditions
- `readSupplierUniverse()` — parses supplier_universe.csv, JSON.parses aliases/info
- `writeSupplierUniverse(suppliers)` — writes CSV (stub for S2-13c)

Helpers: `stripBOM(content)`, `escapeCsv(value)`

**Specs:**


---

### `src/main/services/supplier-research.ts`

**Test file:** `tests/unit/services/supplier-research.test.ts` (exists)

Exports:
- `SupplierResearchResult` — interface extending `SupplierInfo` with `confidence` and `sources`
- `setMainWindow(win)` — sets window ref for progress events
- `cancel()` — sets cancellation flag
- `researchSingle(supplierName)` — checks existing data, calls Exa search + LLM research agent, upserts result
- `researchAllProjectSuppliers()` — sequential research of all project suppliers, emits progress

Events emitted: `suppliers:research:progress`

**Specs:**


---

### `src/main/services/exa-search.ts`

**Test file:** `tests/unit/services/exa-search.test.ts` (exists)

Exports:
- `ExaSearchResult` — interface: `{ title, url, text, publishedDate? }`
- `isAvailable()` — returns `!!process.env.EXA_API_KEY`
- `searchSupplier(supplierName, supplierAddress?, numResults?)` — Exa API call, returns `ExaSearchResult[]`
- `resetClient()` — clears cached client (for tests)

**Specs:**


---

### `src/main/services/load-env.ts`

**Test file:** none

Exports:
- `loadEnv(rootDir?)` — reads `.env` file, populates process.env (guard against re-loading)
- `resetEnvLoaded()` — resets loaded flag (for tests)

**Specs:**


---

## Unit Tests — Agents

### `src/main/agents/classification-agent.ts`

**Test file:** `tests/unit/agents/classification-agent.test.ts` (exists)

Exports:
- `ClassificationInput` — interface: `{ transactions, taxonomy, companyContext, supplierResearch, parentName?, historicalClassifications }`
- `ClassificationResult` — interface: `{ classificationPath, reasoning, descriptionSupplierAligned }`
- `buildSystemPrompt()` — returns system prompt string
- `buildUserPrompt(input)` — assembles taxonomy + supplier research + history + transactions
- `formatTaxonomyTree(taxonomy)` — formats depth-3 nodes as indented tree
- `formatSupplierResearch(supplier, parentName?)` — formats supplier info fields
- `formatHistoricalClassifications(classifications)` — formats with counts
- `formatTransactions(transactions)` — formats excluding EXCLUDED_FIELDS
- `parseResponse(responseText)` — handles JSON, unwraps `{transactions:[...]}` envelope
- `validateL1(path, taxonomy)` — case-insensitive L1 match
- `validateDepth(path)` — enforces exactly 3 levels (L1|L2|L3)
- `findClosestTaxonomyMatch(path, taxonomy)` — tries exact → case-insensitive → partial match
- `validateClassification(result, taxonomy)` — post-processes and fixes LLM response
- `classifyInvoiceGroup(input)` — calls LLM, validates result

**Specs:**


---

### `src/main/agents/column-mapping-agent.ts`

**Test file:** none

Exports:
- `buildSystemPrompt()` — includes CANONICAL_COLUMNS definitions
- `buildUserPrompt(columns, sampleData)` — formats sample rows
- `parseResponse(responseText)` — handles JSON, detects inverted mappings (csv→canonical vs canonical→csv)
- `suggestMappings(columns, sampleData)` — calls LLM, returns mappings + confidence

**Specs:**


---

### `src/main/agents/research-agent.ts`

**Test file:** `tests/unit/agents/research-agent.test.ts` (exists)

Exports:
- `ResearchParseResult` — interface: `{ result: SupplierResearchResult }`
- `buildSystemPrompt()` — returns system prompt
- `buildUserPrompt(supplierName, companyContext?, supplierAddress?, searchResults?)` — assembles sections (includes Exa search results)
- `parseResponse(responseText)` — handles JSON, validates confidence levels, validates supplierType (company/government/individual)
- `researchSupplier(supplierName, companyContext?, supplierAddress?, searchResults?)` — calls LLM, returns `ResearchParseResult`

**Specs:**


---

## Unit Tests — IPC Handlers

### `src/main/ipc/register.ts`

**Test file:** `tests/unit/ipc/register.test.ts` (exists)

Exports:
- `registerHandler<T>(channel, handler)` — wraps handler in IPCResponse envelope, registers on ipcMain
- `sendEvent(window, channel, ...args)` — sends event to renderer
- `removeHandler(channel)` — cleanup for tests

**Specs:**


---

### `src/main/ipc/index.ts`

**Test file:** `tests/unit/ipc/index.test.ts` (exists)

Exports:
- `registerAllHandlers()` — registers all IPC channels + `test:ping`

**Specs:**


---

### `src/main/ipc/project.ts`

**Test file:** none

Channels: `project:new`, `project:open`, `project:close`, `project:getMetadata`, `project:updateMetadata`

**Specs:**


---

### `src/main/ipc/upload.ts`

**Test file:** none

Channels: `upload:selectFile`, `upload:parsePreview`, `upload:csv`

**Specs:**


---

### `src/main/ipc/transactions.ts`

**Test file:** none

Channels: `transactions:query`, `transactions:stats`, `transactions:getColumns`, `transactions:update`

**Specs:**


---

### `src/main/ipc/taxonomy.ts`

**Test file:** none

Channels: `taxonomy:getNodes`, `taxonomy:addNode`, `taxonomy:updateNode`, `taxonomy:deleteNode`, `taxonomy:importFromColabip`

**Specs:**


---

### `src/main/ipc/suppliers.ts`

**Test file:** none

Channels: `suppliers:list`, `suppliers:update`

**Specs:**


---

### `src/main/ipc/rules.ts`

**Test file:** none

Channels: `rules:list`, `rules:create`, `rules:update`, `rules:delete`

**Specs:**


---

### `src/main/ipc/classification.ts`

**Test file:** none

Channels: `classification:start`, `classification:cancel`

**Specs:**


---

### `src/main/ipc/supplier-research.ts`

**Test file:** none

Channels: `suppliers:research`, `suppliers:research:cancel`

**Specs:**


---

### `src/main/ipc/changelog.ts`

**Test file:** none

Channels: `changelog:list`, `changelog:revert`

**Specs:**


---

### `src/main/ipc/export.ts`

**Test file:** none

Channels: `export:csv`

**Specs:**


---

### `src/main/ipc/colabip.ts`

**Test file:** `tests/unit/ipc/colabip.test.ts` (exists)

Channels: `colabip:listTaxonomies`

**Specs:**


---

## Unit Tests — Frontend Utilities

### `src/renderer/utils/filterEvaluation.ts`

**Test file:** none

Exports:
- `evaluateFilterConditions(conditionEntries, filterConnectors, filterCombinator)` — AND/OR operator precedence: groups consecutive ANDs, then ORs across groups
- `computeAndGroupIndices(conditionKeys, filterConnectors)` — groups conditions for UI rendering
- `buildExpressionPreview(labels, conditionKeys, filterConnectors)` — human-readable expression strings

**Specs:**


---

### `src/renderer/utils/transactionTransform.ts`

**Test file:** none (indirectly tested via `tests/integration/review-page.integration.test.ts`)

Exports:
- `transactionToDashboardRow(transaction, index)` — date parsing (year/quarter/month from invoice_date), classification path splitting (`"L1|L2|L3"` → `{L1, L2, L3, L4}`), canonical field spreading

**Specs:**


---

### `src/renderer/utils/pivotToReviewFilters.ts`

**Test file:** none

Exports:
- `convertPivotFiltersToReview(pivotFilterState)` — maps pivot column names to review filter state keys, separates classification keys, routes unmapped columns to activeFilters

**Specs:**


---

### `src/renderer/utils/taxonomyLoader.ts`

**Test file:** none

Exports:
- `buildTaxonomyTree(taxonomyPaths)` — constructs hierarchical tree from pipe-delimited paths
- `populateTreeWithTransactions(tree, transactions)` — aggregates counts and spend at every level

**Specs:**


---

### `src/renderer/utils/exportPivotToExcel.ts`

**Test file:** none

Exports:
- `exportHierarchicalPivotExcel(opts)` — DFS tree flattening, Excel outline levels, currency formatting

**Specs:**


---

## Unit Tests — Frontend Hooks

### `src/renderer/hooks/useIPC.ts`

**Test file:** none

Exports:
- `useIPC<T>(fetchFn, deps)` — generic loading hook: `{loading, error, data, refetch}`, mounted check

**Specs:**


---

### `src/renderer/hooks/useTransactions.ts`

**Test file:** none

Exports:
- `useTransactions(filters)` — progressive chunk loading (CHUNK_SIZE=5000), abort via generation tracking, prevents flash on refetch
- `useTransactionStats()` — wraps useIPC for stats

**Specs:**


---

### `src/renderer/hooks/useHierarchicalPivotData.ts`

**Test file:** none

Exports:
- `useHierarchicalPivotData(transactions, rowDimensions, valueDimension, aggregation)` — multi-level tree building, null→"(Unclassified)", aggregation modes (sum/count/average), value accumulation up ancestor chain, sorted by total desc

**Specs:**


---

### `src/renderer/hooks/usePivotTreeState.ts`

**Test file:** none

Exports:
- `usePivotTreeState(root)` — expand/collapse state, DFS flattening, group separator detection
- `filterRowsBySearch(flatRows, search)` — filters by label preserving ancestors

**Specs:**


---

### `src/renderer/hooks/useKeyboardShortcuts.ts`

**Test file:** none

Exports:
- `useKeyboardShortcuts(shortcuts)` — keyboard listener with modifier parsing (ctrl/cmd + shift + alt + key)

**Specs:**


---

## Unit Tests — Frontend Store

### `src/renderer/stores/workflowStore.ts`

**Test file:** none

State: `projectMetadata`, `classificationProgress`, `classifiedRows`, `dataReviewed`, `uploadDraft`, `reviewFilters`, `lastRoute`

Derived: `hasProject`, `hasCompanyContext`, `hasTaxonomy`, `hasUploadedData`, `hasReviewedData`, `isClassifying`, `hasClassifiedData`

Actions:
- `createProject(name)` — closes backend, resets state, creates via IPC, fetches metadata
- `loadProject(filePath)` — closes backend, opens via IPC, fetches metadata with fallback
- `closeProject()` — closes backend, resets all state
- `refreshMetadata()` / `refreshStats()` — fetches and merges
- `subscribeToClassificationProgress()` — handles progress events, deduplicates stale events via runId
- `deriveState(metadata, classifiedRows, progress)` — computes all derived booleans

**Specs:**


---

## Unit Tests — Frontend Components

### `src/renderer/components/upload/ColumnMappingEditor.tsx`

**Test file:** none

Key logic:
- `autoMap(llmMappings, unmappedCanonical, csvColumns)` — auto-fills unmapped columns using CANONICAL_COLUMNS aliases (case-insensitive), prevents duplicate CSV column usage

**Specs:**


---

### `src/renderer/components/review/Dashboard.tsx`

**Test file:** none (very large component)

Key logic:
- Filter state management (activeFilters, filterState, filterConnectors, filterCombinator)
- View switching (multi-table, classification tree, metrics)
- Reclassification flow via `ipc.transactions.update()`
- Filter application using `evaluateFilterConditions()`

**Specs:**


---

### `src/renderer/components/review/MetricsTab.tsx`

**Test file:** none

Key logic:
- `isLowConfidence(row)` — checks `classification_status` for low-confidence classification

**Specs:**


---

## Unit Tests — Shared

### `src/shared/canonical-columns.ts`

**Test file:** none

Exports:
- `CANONICAL_COLUMNS` — array of 14 column definitions: `{name, relevance, type, aliases, description}`
- Columns: supplier_name (critical), line_description (critical), gl_description (high), spend_amount (critical), gl_code (high), department (medium), invoice_date (high), creation_date (low), company (medium), cost_center (medium), po_number (low), supplier_address (low), currency (low), memo (low)

**Specs:**


---

## Integration Tests

### Pipeline Smoke Test (mocked LLM)

**Test file:** `tests/integration/pipeline-mock.test.ts` (exists)

End-to-end with mocked LLM: create project → import taxonomy → upload CSV → seed suppliers → run classification → verify results → export. Uses real DuckDB, 5-table schema, supplierUniverseService. 7 phased tests.

**Specs:**


---

### Pipeline Real Test (real LLM)

**Test file:** `tests/integration/pipeline-real-run.test.ts` (exists)

End-to-end with real API calls: 11 phases (project, taxonomy, CSV, suppliers, research, classification, verification, rules, reclassification, export, integrity). 13 phased tests, skips without API key.

**Specs:**


---

### Backend Workflow Test

**Test file:** `tests/integration/backend-workflow.test.ts` (exists)

Multi-service orchestration: rules + taxonomy, transaction updates + changelog, transaction queries, supplier CRUD, error handling. 5 describe blocks, 7 tests. Mocks both databaseService + supplierUniverseService.

**Specs:**


---

### IPC Workflow Test

**Test file:** `tests/integration/ipc-workflow.test.ts` (exists)

End-to-end through IPC handlers: 5 phases (project, taxonomy, upload, classification, review/export). 12 tests.

**Specs:**


---

### Review Page Integration Test

**Test file:** `tests/integration/review-page.integration.test.ts` (exists)

Data transformation tests: verifies `transactionToDashboardRow` correctly handles classification path splitting, status mapping, canonical field spreading, unclassified handling. 6 tests. Pure function tests (no React rendering — environment is `node` not `jsdom`).

**Specs:**


---

## Test Infrastructure Notes

- **Fixtures available:** `tests/fixtures/colabip/` (3 taxonomies + supplier_universe.csv), `tests/fixtures/csv/` (5 CSV variants)
- **Helpers directory:** `tests/helpers/` (empty — `.gitkeep` only)
- **Mocking pattern:** `vi.mock()` at module level, `vi.clearAllMocks()` in `beforeEach`
- **DB cleanup pattern:** temp file with `Date.now()` suffix, `unlinkSync` in `afterEach`
- **No co-located tests:** all tests live in `tests/` directory
- **Placeholder tests:** `tests/unit/placeholder.test.ts` (scaffolding sanity), `tests/unit/ReviewPage.test.ts` (placeholder)
