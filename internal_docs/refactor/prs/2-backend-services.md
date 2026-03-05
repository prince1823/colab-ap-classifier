# PR 2: All Backend Services + Container + IPC Wiring

**Goal:** Convert every service/agent to a class with constructor injection, wire the container, update IPC handlers. No Pipeline class — research and classification are independent user-triggered operations.

## Naming Convention

- **Leaf layer** (DB-specific): Descriptive names — `DuckDBDatabase`, `DuckDBSupplierUniverse`, `OpenRouterLLMClient`, `ExaWebSearch`
- **Data services**: Same name as interface — `TransactionStore`, `ProjectStore`, `SupplierService`, etc.
- **Orchestrators**: Same name as interface — `SupplierResearcher`, `ClassificationRunner`
- **Agents**: Prefixed with `LLM` — `LLMClassificationAgent`, `LLMResearchAgent`, `LLMColumnMappingAgent`

## 2a. Database Layer

**Modify:** `src/main/services/database.ts`
- Rename `DatabaseService` → `DuckDBDatabase implements Database`
- Remove module-level singleton exports — export class only
- Remove `SupplierUniverseService` (moved to separate file)

**Create:** `src/main/services/supplier-universe.ts`
- `class DuckDBSupplierUniverse implements SupplierUniverse`
- High-level methods: `getSupplier(name)`, `upsertSupplier(name, data)`, `searchVariants(name)`
- Internally uses DuckDB (the shared `supplier_universe.db`)

## 2b. External Services

| Class | File | Notes |
|---|---|---|
| `OpenRouterLLMClient implements LLMClient` | `llm-client.ts` | Constructor reads env vars |
| `ExaWebSearch implements WebSearch` | `exa-search.ts` | |

**Delete:** `src/main/services/colabip.ts` — ColabipSync removed entirely

## 2c. Agents (thin classes wrapping LLMClient)

| Class | File | Constructor |
|---|---|---|
| `LLMClassificationAgent implements ClassificationAgent` | `agents/classification-agent.ts` | `(llm: LLMClient)` |
| `LLMResearchAgent implements ResearchAgent` | `agents/research-agent.ts` | `(llm: LLMClient)` |
| `LLMColumnMappingAgent implements ColumnMappingAgent` | `agents/column-mapping-agent.ts` | `(llm: LLMClient)` |

Prompt builders + parsers stay as standalone exported pure functions.

## 2d. Data Services (constructor injection)

| Class | File | Constructor Params |
|---|---|---|
| `ChangelogStore` | `changelog.ts` | `db: Database` |
| `TransactionStore` | `transactions.ts` | `db: Database, changelog: ChangelogStore` |
| `ProjectStore` | `project.ts` | `db: Database, transactions: TransactionStore` |
| `TaxonomyStore` | `taxonomy.ts` | `db: Database, project: ProjectStore` |
| `SupplierService` | `supplier-service.ts` | `db: Database, supplierUniverse: SupplierUniverse` |
| `RuleStore` | `rules.ts` | `db: Database` |
| `IngestService` | `ingest.ts` | `db: Database, transactions: TransactionStore, columnMappingAgent: ColumnMappingAgent` |
| `ExportService` | `export.ts` | `db: Database` |

### Key changes in `TaxonomyStore`:
- `importFromColabip(industryName)` → `importFromFile(filePath)` — reads taxonomy files directly
- `deleteNode(nodeId, reassignTo?)` — reassigns affected transactions
- `renameNode(nodeId, newName)` — cascades full_path updates to children + transaction references
- `mergeNodes(sourceId, targetId)` — re-maps transactions, deletes source
- No ColabipSync dependency

### Key changes in `SupplierService`:
- `normalizeSupplierName(rawName)` → resolves to canonical supplier, returns `project_supplier_id`
- `normalizeAllTransactions()` → batch: for each unique `original_supplier_name`, resolve and set `project_supplier_id` FK on transaction rows
- `addAlias(canonicalName, alias)` / `getAliases(canonicalName)` — alias management
- `renameSupplier(supplierId, newName)` — single row update, zero transaction rows touched (FK-based)
- `listProjectSuppliers()` — JOIN with transactions for count/spend aggregates
- `confirmSupplier(id, status)`, `assignParent(id, parentId)`, `filterTailSpend(threshold)`
- `enrichProjectSupplier(id)` — delegates to SupplierUniverse for shared data

### Key changes in `IngestService`:
- No `updateColumnPriority()` — column priorities are in `project_settings` via `ProjectStore`
- `importCSV()` accepts `ColumnMapping` (no priority sub-object), stores in uploads table
- `getStoredMappings(columns)` — find existing uploads with matching column structure for reuse

### Pure functions extracted:
- `buildWhereClause`, `conditionToSQL` → `src/main/utils/query-builder.ts`
- `cleanDescription` → `src/main/utils/text.ts`

## 2e. Orchestrators

### `SupplierResearcher`
**File:** `src/main/services/supplier-research.ts`
**Constructor:** `(supplierUniverse: SupplierUniverse, webSearch: WebSearch, researchAgent: ResearchAgent, eventBus: EventBus)`

- `researchSingle(supplierName)` — check universe → web search fallback → LLM format → upsert to universe
- `researchAll(onProgress?)` — sequential loop calling `researchSingle` per supplier, emits progress events
- `cancel()` — sets cancellation flag

### `ClassificationRunner`
**File:** `src/main/services/classification.ts`
**Constructor:** `(db: Database, taxonomy: TaxonomyStore, project: ProjectStore, rules: RuleStore, transactions: TransactionStore, changelog: ChangelogStore, classificationAgent: ClassificationAgent, eventBus: EventBus)`

- `classifyAll()` — classify all unclassified suppliers, emitting progress via EventBus
- `classifySupplier(projectSupplierId, taxonomy, companyContext)` — atomic: get transactions by `project_supplier_id` FK → evaluate rules → LLM classify remaining → update transactions
- `getIsRunning()` / `cancel()`
- No pipeline, no checkpoints — runs to completion

### Pipeline: REMOVED
**Delete:** `src/main/services/pipeline.ts` — no automated pipeline. Research and classification are separate user-triggered actions.

## 2f. Service Container

**Create:** `src/main/container.ts`

```typescript
export interface ServiceContainer {
  // Leaf
  db: Database;
  supplierUniverse: SupplierUniverse;
  eventBus: EventBus;
  llm: LLMClient;
  webSearch: WebSearch;
  // Agents
  classificationAgent: ClassificationAgent;
  researchAgent: ResearchAgent;
  columnMappingAgent: ColumnMappingAgent;
  // Data
  changelog: ChangelogStore;
  transactions: TransactionStore;
  project: ProjectStore;
  taxonomy: TaxonomyStore;
  suppliers: SupplierService;
  rules: RuleStore;
  ingest: IngestService;
  export: ExportService;
  // Orchestrators
  researcher: SupplierResearcher;
  classifier: ClassificationRunner;
}

export function createContainer(): ServiceContainer {
  // Leaf layer
  const db = new DuckDBDatabase();
  const supplierUniverse = new DuckDBSupplierUniverse();
  const llm = new OpenRouterLLMClient();
  const webSearch = new ExaWebSearch();

  // Agents
  const classificationAgent = new LLMClassificationAgent(llm);
  const researchAgent = new LLMResearchAgent(llm);
  const columnMappingAgent = new LLMColumnMappingAgent(llm);

  // Data layer (order matters — respect dependency graph)
  const changelog = new ChangelogStore(db);
  const transactions = new TransactionStore(db, changelog);
  const project = new ProjectStore(db, transactions);
  const taxonomy = new TaxonomyStore(db, project);
  const suppliers = new SupplierService(db, supplierUniverse);
  const rules = new RuleStore(db);
  const ingest = new IngestService(db, transactions, columnMappingAgent);
  const exportSvc = new ExportService(db);

  // Orchestrators
  const researcher = new SupplierResearcher(
    supplierUniverse, webSearch, researchAgent, eventBus);
  const classifier = new ClassificationRunner(
    db, taxonomy, project, rules,
    transactions, changelog, classificationAgent, eventBus);

  return { db, supplierUniverse, eventBus, llm, webSearch,
    classificationAgent, researchAgent, columnMappingAgent,
    changelog, transactions, project, taxonomy, suppliers, rules,
    ingest, export: exportSvc, researcher, classifier };
}
```

## 2g. IPC Handlers Take Dependencies

| IPC File | Receives |
|---|---|
| `project.ts` | `project: ProjectStore` |
| `ingest.ts` | `ingest: IngestService` |
| `transactions.ts` | `transactions: TransactionStore` |
| `taxonomy.ts` | `taxonomy: TaxonomyStore` |
| `suppliers.ts` | `suppliers: SupplierService, researcher: SupplierResearcher` |
| `classification.ts` | `classifier: ClassificationRunner` |
| `rules.ts` | `rules: RuleStore` |
| `changelog.ts` | `changelog: ChangelogStore` |
| `export.ts` | `export: ExportService` |

**Delete:** `src/main/ipc/colabip.ts` — no longer needed
**Delete:** `src/main/ipc/pipeline.ts` — pipeline removed

**Modify:** `src/main/ipc/index.ts` — `registerAllHandlers(services: ServiceContainer)`

## 2h. Entry Point

**Modify:** `src/main/index.ts`:
```typescript
import { createContainer } from './container';
import { eventBus } from './event-bus';

app.whenReady().then(() => {
  const services = createContainer();
  registerAllHandlers(services);
  createWindow();

  // Forward events to renderer
  eventBus.on('suppliers:research:progress', (...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('suppliers:research:progress', ...args);
  });
  eventBus.on('classification:progress', (...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('classification:progress', ...args);
  });
});
```

No more `setMainWindow()` calls. No more `setColabipBasePath()` calls.

## Verify
- `npx tsc --noEmit`
- Manual Electron smoke test

## Files

| Action | Path |
|---|---|
| Create | `src/main/container.ts` |
| Create | `src/main/services/supplier-universe.ts` |
| Create | `src/main/services/supplier-service.ts` |
| Create | `src/main/utils/query-builder.ts` |
| Create | `src/main/utils/text.ts` |
| Delete | `src/main/services/colabip.ts` |
| Delete | `src/main/services/pipeline.ts` |
| Delete | `src/main/ipc/colabip.ts` |
| Delete | `src/main/ipc/pipeline.ts` |
| Modify | All remaining files in `src/main/services/` |
| Modify | 3 files in `src/main/agents/` |
| Modify | All remaining files in `src/main/ipc/` |
| Modify | `src/main/index.ts` |
