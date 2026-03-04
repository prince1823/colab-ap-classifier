# PR 4: Test Rewrite

**Goal:** Rewrite all ~27 test files to use constructor injection with mock factories. Add new tests for SupplierService (normalization, FK-based retrieval), ClassificationRunner (FK-based), and removed pipeline.

## Pattern

**Before (fragile — module mocking):**
```typescript
vi.mock('../../../src/main/services/database', () => ({ databaseService: { run: vi.fn() } }));
vi.mock('../../../src/main/services/taxonomy', () => ({ getNodes: vi.fn() }));
import { startClassification } from '../../../src/main/services/classification';
```

**After (clean — constructor injection):**
```typescript
import { ClassificationRunner } from '../../../src/main/services/classification';
import { createMockDatabase, createMockEventBus } from '../../helpers/mock-services';

const db = createMockDatabase();
const eventBus = createMockEventBus();
const classifier = new ClassificationRunner(db, mockTaxonomy, mockProject, mockRules, mockTransactions, mockChangelog, mockClassificationAgent, eventBus);

it('retrieves transactions by project_supplier_id FK', async () => {
  vi.mocked(db.all).mockResolvedValue([{ id: 'txn1', project_supplier_id: 'sup1', ... }]);
  await classifier.classifySupplier('sup1', taxonomyNodes, companyContext);
  expect(db.all).toHaveBeenCalledWith(expect.stringContaining('project_supplier_id'), 'sup1');
});
```

Only external libs (`electron`, `csv-parse`, `@duckdb/node-api`) still need `vi.mock()`.

## New Test Coverage

| Test Suite | What It Tests |
|---|---|
| `supplier-service.test.ts` | Normalization (raw → canonical via aliases), FK assignment on transactions, rename (single row, no txn updates), alias CRUD, listProjectSuppliers with JOIN aggregates |
| `classification-runner.test.ts` | FK-based transaction retrieval, rules → LLM flow, progress emission, cancel |
| `supplier-researcher.test.ts` | Universe check → web search fallback → LLM → upsert flow |
| `taxonomy-store.test.ts` | CRUD, rename cascading, merge with txn reassignment, delete with reassignment, importFromFile |
| `ingest-service.test.ts` | CSV import, stored mapping reuse, no column priority methods |
| `container.test.ts` | Service container wires all deps correctly, all services are instances of their interfaces |

## Removed Tests

| Test Suite | Why |
|---|---|
| `pipeline.test.ts` | Pipeline removed — research and classification are independent |
| `colabip.test.ts` | ColabipSync removed |
| `colabip-ipc.test.ts` | ColabipSync IPC removed |

## Existing Tests to Rewrite

All files in:
- `tests/unit/services/` — database, project, transactions, taxonomy, suppliers, rules, classification, supplier-research, ingest, llm-client, changelog, export, exa-search
- `tests/unit/agents/` — classification-agent, research-agent, column-mapping-agent
- `tests/unit/ipc/` — register, index
- `tests/integration/` — backend-workflow, ipc-workflow, classifier-mock, classifier-real-run, review-page

## Verify
- `npm test` — all green
- `npm run typecheck`
- `npm run test:integration` (if applicable)
