# PR 4: Test Rewrite

**Goal:** Rewrite all ~27 test files to use constructor injection with mock factories. Add new tests for interleaved pipeline, project_suppliers, and checkpoint logic.

## Pattern

**Before (fragile):**
```typescript
vi.mock('../../../src/main/services/database', () => ({ databaseService: { run: vi.fn() } }));
vi.mock('../../../src/main/services/taxonomy', () => ({ getNodes: vi.fn() }));
import { startClassification } from '../../../src/main/services/classification';
```

**After (clean):**
```typescript
import { ClassificationRunner } from '../../../src/main/services/classification';
import { createMockDatabase, createMockEventBus } from '../../helpers/mock-services';

const db = createMockDatabase();
const eventBus = createMockEventBus();
const classifier = new ClassificationRunner(db, mockSupplierUniverse, mockTaxonomy, ...);

it('applies rules before LLM classification', async () => {
  vi.mocked(db.all).mockResolvedValue([...]);
  await classifier.classifySupplier('Acme', taxonomyNodes, companyContext);
  expect(db.all).toHaveBeenCalledWith(...);
});
```

Only external libs (`electron`, `csv-parse`, `@duckdb/node-api`) still need `vi.mock()`.

## New Test Coverage

| Test Suite | What It Tests |
|---|---|
| `pipeline.test.ts` | Interleaved: research→classify per supplier, checkpoint gates at 25/50/75%, resume/cancel |
| `project-suppliers.test.ts` | CRUD on project_suppliers table, confirmation status, tail spend filtering, parent assignment |
| `supplier-store.test.ts` | Variant detection, universe upsert, project supplier join queries |
| `container.test.ts` | Service container wires all deps correctly, all services are instances of their interfaces |

## Existing Tests to Rewrite

All files in:
- `tests/unit/services/` — database, project, transactions, taxonomy, suppliers, rules, classification, pipeline, supplier-research, upload/ingest, llm-client, changelog, export, colabip, exa-search
- `tests/unit/agents/` — classification-agent, research-agent
- `tests/unit/ipc/` — register, index, colabip
- `tests/integration/` — backend-workflow, ipc-workflow, classifier-mock, classifier-real-run, review-page

## Verify
- `npm test` — all green
- `npm run typecheck`
- `npm run test:integration` (if applicable)
