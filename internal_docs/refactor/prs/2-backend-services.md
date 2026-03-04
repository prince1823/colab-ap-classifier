# PR 2: All Backend Services + Container + IPC Wiring

**Goal:** Convert every service/agent to a class, build the interleaved pipeline, implement project_suppliers, wire the container. This is the big PR.

## Naming Convention

- **Leaf layer** (DB-specific): Descriptive names — `DuckDBDatabase`, `DuckDBSupplierUniverse`, `OpenRouterLLMClient`, `ExaWebSearch`, `GitColabipSync`
- **Data services**: Same name as interface — `TransactionStore`, `ProjectStore`, etc. Disambiguated by import path (`@shared/types` for interface, `../services/transactions` for class)
- **Orchestrators**: Same name as interface — `SupplierResearcher`, `ClassificationRunner`, `InterleavedPipeline`
- **Agents**: Prefixed with `LLM` — `LLMClassificationAgent`, `LLMResearchAgent`, `LLMColumnMappingAgent`

## 2a. Database Layer

**Modify:** `src/main/services/database.ts`
- Rename `DatabaseService` → `DuckDBDatabase implements Database`
- Rename `SupplierUniverseService` → `DuckDBSupplierUniverse implements SupplierUniverseDb`
- Remove module-level singleton exports — export classes only

## 2b. External Services

| Class | File | Notes |
|---|---|---|
| `OpenRouterLLMClient implements LLMClient` | `llm-client.ts` | Constructor reads env vars |
| `ExaWebSearch implements WebSearch` | `exa-search.ts` | |
| `GitColabipSync implements ColabipSync` | `colabip.ts` | `basePath` as instance field |

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
| `ProjectStore` | `project.ts` | `db: Database, supplierUniverse: SupplierUniverseDb, transactions: TransactionStore` |
| `TaxonomyStore` | `taxonomy.ts` | `db: Database, colabip: ColabipSync, project: ProjectStore` |
| `SupplierStore` | `suppliers.ts` | `db: Database, supplierUniverse: SupplierUniverseDb` |
| `RuleStore` | `rules.ts` | `db: Database` |
| `IngestService` | `ingest.ts` | `db: Database, transactions: TransactionStore, columnMappingAgent: ColumnMappingAgent` |
| `ExportService` | `export.ts` | `db: Database` |

These classes are database-agnostic — they receive a `Database` interface and write SQL against it. The `DuckDB` prefix only lives on the database layer itself.

### Key changes in `SupplierStore`:
- New methods for `project_suppliers` table: `getProjectSupplier`, `confirmSupplier`, `assignParent`, `filterTailSpend`, `getSupplierVariants`
- `listProjectSuppliers()` joins `project_suppliers` + `supplier_universe` + transaction aggregates

### Pure functions extracted:
- `buildWhereClause`, `conditionToSQL` → `src/main/utils/query-builder.ts`
- `cleanDescription` → `src/main/utils/text.ts`

## 2e. Orchestrators — Interleaved Pipeline

### `SupplierResearcher implements SupplierResearcher`
**File:** `src/main/services/supplier-research.ts`
**Constructor:** `(db: Database, suppliers: SupplierStore, project: ProjectStore, webSearch: WebSearch, researchAgent: ResearchAgent, eventBus: EventBus)`

- `researchSingle(supplierName)` — atomic: web search → LLM format → upsert supplier
- `researchAll(onProgress?)` — loop calling `researchSingle` per supplier

### `ClassificationRunner implements ClassificationRunner`
**File:** `src/main/services/classification.ts`
**Constructor:** `(db: Database, supplierUniverse: SupplierUniverseDb, taxonomy: TaxonomyStore, project: ProjectStore, rules: RuleStore, transactions: TransactionStore, changelog: ChangelogStore, classificationAgent: ClassificationAgent, eventBus: EventBus)`

- `classifySupplier(supplierName, taxonomy, companyContext)` — **public** atomic method: rules → LLM classify
- `startClassification()` removed — pipeline orchestrates the loop

### `InterleavedPipeline implements Pipeline` (REWRITE)
**File:** `src/main/services/pipeline.ts`
**Constructor:** `(researcher: SupplierResearcher, classifier: ClassificationRunner, project: ProjectStore, transactions: TransactionStore, taxonomy: TaxonomyStore, eventBus: EventBus)`

```typescript
async start(): Promise<void> {
  const suppliers = await this.getUnclassifiedSuppliers();
  const taxonomyNodes = await this.taxonomy.getNodes();
  const companyContext = await this.project.getSetting('company_context');
  const checkpoints = [25, 50, 75];
  let nextCheckpointIdx = 0;

  for (let i = 0; i < suppliers.length; i++) {
    if (this.isCancelled) break;
    const supplier = suppliers[i];

    this.emitProgress({ status: 'running', currentService: 'research', currentSupplier: supplier });
    await this.researcher.researchSingle(supplier);

    this.emitProgress({ status: 'running', currentService: 'classification', currentSupplier: supplier });
    await this.classifier.classifySupplier(supplier, taxonomyNodes, companyContext);

    this.processedSuppliers = i + 1;
    const pct = Math.round((this.processedSuppliers / suppliers.length) * 100);

    if (nextCheckpointIdx < checkpoints.length && pct >= checkpoints[nextCheckpointIdx]) {
      nextCheckpointIdx++;
      this.emitProgress({ status: 'awaiting_review', checkpoint: nextCheckpointIdx });
      await this.waitForResume();
    }
  }

  this.emitProgress({ status: 'completed' });
}
```

## 2f. Service Container

**Create:** `src/main/container.ts`

```typescript
export interface ServiceContainer {
  db: Database;
  supplierUniverseDb: SupplierUniverseDb;
  eventBus: EventBus;
  llm: LLMClient;
  webSearch: WebSearch;
  colabip: ColabipSync;
  classificationAgent: ClassificationAgent;
  researchAgent: ResearchAgent;
  columnMappingAgent: ColumnMappingAgent;
  changelog: ChangelogStore;
  transactions: TransactionStore;
  project: ProjectStore;
  taxonomy: TaxonomyStore;
  suppliers: SupplierStore;
  rules: RuleStore;
  ingest: IngestService;
  export: ExportService;
  researcher: SupplierResearcher;
  classifier: ClassificationRunner;
  pipeline: Pipeline;
}

export function createContainer(): ServiceContainer {
  // Leaf (DB-specific implementations)
  const db = new DuckDBDatabase();
  const supplierUniverseDb = new DuckDBSupplierUniverse();
  const llm = new OpenRouterLLMClient();
  const webSearch = new ExaWebSearch();
  const colabip = new GitColabipSync();

  // Agents
  const classificationAgent = new LLMClassificationAgent(llm);
  const researchAgent = new LLMResearchAgent(llm);
  const columnMappingAgent = new LLMColumnMappingAgent(llm);

  // Data layer (database-agnostic — receive Database interface)
  const changelog = new ChangelogStore(db);
  const transactions = new TransactionStore(db, changelog);
  const project = new ProjectStore(db, supplierUniverseDb, transactions);
  const taxonomy = new TaxonomyStore(db, colabip, project);
  const suppliers = new SupplierStore(db, supplierUniverseDb);
  const rules = new RuleStore(db);
  const ingest = new IngestService(db, transactions, columnMappingAgent);
  const exportService = new ExportService(db);

  // Orchestrators
  const researcher = new SupplierResearcher(db, suppliers, project, webSearch, researchAgent, eventBus);
  const classifier = new ClassificationRunner(db, supplierUniverseDb, taxonomy, project, rules, transactions, changelog, classificationAgent, eventBus);
  const pipeline = new InterleavedPipeline(researcher, classifier, project, transactions, taxonomy, eventBus);

  return { db, supplierUniverseDb, eventBus, llm, webSearch, colabip,
    classificationAgent, researchAgent, columnMappingAgent,
    changelog, transactions, project, taxonomy, suppliers, rules,
    ingest, export: exportService, researcher, classifier, pipeline };
}
```

## 2g. IPC Handlers Take Dependencies

| IPC File | Receives |
|---|---|
| `project.ts` | `project: ProjectStore` |
| `ingest.ts` | `ingest: IngestService` |
| `pipeline.ts` | `pipeline: Pipeline` |
| `transactions.ts` | `transactions: TransactionStore` |
| `taxonomy.ts` | `taxonomy: TaxonomyStore` |
| `suppliers.ts` | `suppliers: SupplierStore` |
| `supplier-research.ts` | `researcher: SupplierResearcher` |
| `rules.ts` | `rules: RuleStore` |
| `changelog.ts` | `changelog: ChangelogStore` |
| `export.ts` | `export: ExportService` |
| `colabip.ts` | `colabip: ColabipSync` |

**Modify:** `src/main/ipc/index.ts` — `registerAllHandlers(services: ServiceContainer)`

**Rename:** `pipeline:approve` → `pipeline:resume`

## 2h. Entry Point

**Modify:** `src/main/index.ts`:
```typescript
import { createContainer } from './container';
import { eventBus } from './event-bus';

app.whenReady().then(() => {
  const services = createContainer();
  services.colabip.setBasePath(getColabipDir());
  registerAllHandlers(services);
  createWindow();

  eventBus.on('pipeline:progress', (...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pipeline:progress', ...args);
  });
});
```

## Verify
- `npx tsc --noEmit`
- Manual Electron smoke test

## Files

| Action | Path |
|---|---|
| Create | `src/main/container.ts` |
| Create | `src/main/utils/query-builder.ts` |
| Create | `src/main/utils/text.ts` |
| Modify | All 15 files in `src/main/services/` |
| Modify | 3 files in `src/main/agents/` |
| Modify | All files in `src/main/ipc/` |
| Modify | `src/main/index.ts` |
