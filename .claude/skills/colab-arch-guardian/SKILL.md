---
name: colab-arch-guardian
description: >
  For the colab-ap-classifier Electron app: invoke this skill automatically whenever a developer
  shows code they are writing — service classes, IPC handlers, DuckDB/SQL queries, anything in
  src/main/. Architecture validation should run even when the stated goal is adding a feature,
  not requesting a review. If code is present and it belongs to this codebase's backend, this
  skill runs. Explicit triggers include "arch check", "does this follow the pattern", and
  "looks right?". Do not invoke for UI/CSS-only changes, questions about existing behavior
  without new code being shown, or scripts unrelated to the app's service layer.
---

# Colab AP Classifier — Architecture Guardian

You are the architecture guardian for this Electron desktop app. Your job is to catch
violations of the 9 invariants below before they become bugs. Apply these checks whenever
you write or review code, silently verifying each rule and surfacing only the ones that are
violated (or flagging them clearly during review).

---

## The 9 Invariants

### 1. DI Container — constructor injection only

**Rule:** Services receive all dependencies via constructor. No module-level singletons
except `eventBus` (imported from `event-bus.ts`). Every new service must be instantiated
in `createContainer()` in `src/main/container.ts` and returned from the container object.

**Why it matters:** Module singletons make state implicit and tests impossible to isolate.
The container is the single source of truth for how the app is wired.

**Check:** If a file in `src/main/services/` imports another service directly (not via
constructor arg), that's a violation. If a new service exists but isn't in `createContainer()`,
it won't be used.

**Pattern:**
```ts
// CORRECT
export class MyService {
  constructor(private db: Database, private taxonomy: TaxonomyStore) {}
}
// in container.ts
const myService = new MyService(db, taxonomy)
return { ..., myService }

// WRONG
import { taxonomy } from './taxonomy' // module-level import of another service
```

---

### 2. IPC Contract — every channel must be typed in IPCInvokeMap

**Rule:** Before any new IPC handler can be written, its channel must be declared in
`IPCInvokeMap` in `src/shared/types/ipc-contract.ts` with typed `args` and `result`.
Handlers use `registerHandler()` from `src/main/ipc/register.ts`, which auto-wraps the
return value in `IPCResponse<T>`. The renderer always calls IPC via `src/renderer/lib/ipc.ts`
(the typed client), never `ipcRenderer.invoke` directly.

**Why it matters:** Without the type contract, both sides of the IPC bridge can diverge
silently. A missing channel in `IPCInvokeMap` means TypeScript can't catch arg/result
mismatches.

**Check when adding a handler:**
1. Channel exists in `IPCInvokeMap`? ✓
2. Handler uses `registerHandler('channel:name', async (...) => ...)` ✓
3. Handler returns the raw data (not an IPCResponse — the wrapper does that) ✓
4. Renderer calls via the typed `ipc` client ✓

**Pattern:**
```ts
// ipc-contract.ts
'myns:doThing': { args: [id: string]; result: MyResult };

// ipc/myns.ts
registerHandler('myns:doThing', async (_event, id: unknown) =>
  service.doThing(id as string)
)

// renderer/lib/ipc.ts  — add to typed client
doThing: (id: string) => invoke('myns:doThing', id),
```

---

### 3. DuckDB safety — all queries go through the promise queue

**Rule:** Never call `db.run()`, `db.exec()`, or `db.all()` from multiple places
concurrently. All queries are serialized through the promise queue inside `database.ts`.
This happens automatically if you go through the service layer. If you write a new service
that accepts a `db: Database` dependency, use the methods on the `Database` interface
(which internally queue) — do not unwrap the connection and call DuckDB directly.

**Why it matters:** DuckDB's node-api does not support concurrent queries on a single
connection. Concurrent calls cause "Failed to execute prepared statement" crashes that are
hard to reproduce (commit 82dea49).

**Check:** If a new service or IPC handler creates a raw DuckDB connection, or if two
async operations call `db.*` methods in parallel without awaiting each, flag it.

**Pattern:**
```ts
// CORRECT — service queues internally
await this.db.run('INSERT INTO ...', [val1, val2])
await this.db.all('SELECT ...')

// WRONG — bypass service, open raw connection in handler
const conn = await duck.connect()  // never do this in handlers
```

---

### 4. Virtual dimensions — classification_l1/l2/l3 require a taxonomy JOIN

**Rule:** `classification_l1`, `classification_l2`, and `classification_l3` are **not**
physical columns on the `transactions` table. Transactions reference taxonomy nodes via
`taxonomy_node_id` FK. Any query that needs classification labels must JOIN `taxonomy_nodes`.

**Why it matters:** Treating them as physical columns causes silent empty results or "column
not found" errors. The pivot view handles this via `VIRTUAL_DIMS` in `queryPivotAggregation`
— any new query must replicate the JOIN pattern.

**Check:** If a query does `SELECT classification_l1 FROM transactions` without a JOIN
against `taxonomy_nodes`, it will return nothing or error. Flag it.

**Pattern:**
```sql
-- CORRECT
SELECT tx.id, tn.l1 AS classification_l1, tn.l2 AS classification_l2
FROM transactions tx
LEFT JOIN taxonomy_nodes tn ON tx.taxonomy_node_id = tn.id

-- WRONG
SELECT classification_l1 FROM transactions  -- column doesn't exist
```

---

### 5. column_priorities must be saved after any CSV import path

**Rule:** After calling `ingest:importCSV`, the project setting `column_priorities` must be
saved via `ipc.project.setSetting('column_priorities', [...columns])`. This is required for
the classification runner to know which columns to send to the LLM — it throws
"must be configured" if this setting is absent.

**Why it matters:** Every alternative import path (e.g., a future re-import flow, a batch
import script) must include this step or classification will silently fail to start.

**Check:** If you see an import flow that calls `ingest:importCSV` but does not follow up
with `project:setSetting('column_priorities', ...)`, add it.

**Pattern (from UploadPage.tsx):**
```ts
await ipc.ingest.importCSV(filePath, toSimpleMapping(mapping))
const required = REQUIRED_COLS.filter(col => mapping[col]?.csvColumn)
const optional = Object.entries(mapping)
  .filter(([name, e]) => !REQUIRED_COLS.includes(name) && e.classificationPriority > 0)
  .sort(([,a],[,b]) => (a.classificationPriority ?? 99) - (b.classificationPriority ?? 99))
  .map(([name]) => name)
await ipc.project.setSetting('column_priorities', [...required, ...optional])
```

---

### 6. Interface discipline — concrete methods must be on the interface

**Rule:** When you add a new method to a concrete service class (e.g., `TransactionStore`,
`SupplierService`), you must also add the method signature to its interface in
`src/shared/types/services.ts`. IPC handlers must receive the interface type, not the
concrete class, so they remain testable with mocks.

**Why it matters:** The DI contract promises that IPC handlers depend only on interfaces.
Casting to the concrete class in handlers (as currently happens with 4 TransactionStore
methods) means mock implementations used in tests won't have those methods.

**Check:** If an IPC handler does `(service as ConcreteClass).newMethod()`, that's a
violation. Add the method to the interface instead.

**Pattern:**
```ts
// src/shared/types/services.ts
export interface TransactionStore {
  // existing methods...
  queryPivotAggregation(dims: string[], value: string, filter?: TransactionFilter): Promise<PivotAggregationResult>
}

// src/main/ipc/transactions.ts — no cast needed
registerHandler('transactions:pivotAggregation', async (_event, dims, value, filter) =>
  transactions.queryPivotAggregation(dims as string[], value as string, filter as TransactionFilter)
)
```

---

### 7. Dynamic schema — never assume a column exists on transactions

**Rule:** The `transactions` table schema is dynamic. Columns are added via `ALTER TABLE`
at import time based on what the CSV contained. Do not assume any column (beyond the base
schema) exists. Use `transactions:getColumns` to discover the actual schema before
building queries that reference optional columns.

**Why it matters:** A query referencing a non-existent column will fail at runtime for
users whose CSV didn't contain that field, with a confusing error unrelated to what they
were trying to do.

**Base schema columns** (always present): `id`, `row_index`, `upload_id`, `taxonomy_node_id`,
`classification_status`, `human_reviewed`, `classification_reasoning`, `original_supplier_name`,
`project_supplier_id`, `created_at`, `updated_at`.
Note: `supplier_name` is a **virtual column** resolved via JOIN to `project_suppliers` (see invariant 8).
Columns like `spend_amount`, `invoice_date`, and other canonical columns are added dynamically
via `ALTER TABLE` at import time based on the CSV mapping.

**Check:** If a service or query hardcodes an optional column like `gl_description` or
`department` without first checking it exists, flag it.

---

### 8. supplier_name is virtual — FK-based, resolved via JOIN

**Rule:** `supplier_name` is NOT a physical column on the `transactions` table. It is a
**virtual column** resolved via `LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id`
(defined in `VIRTUAL_COLUMNS` in `transactions.ts`). `original_supplier_name` is the physical
column that stores the raw CSV value as an audit trail. `project_supplier_id` is the FK that
links to the canonical supplier record.

**Why it matters:** The mapping flow maps user CSV columns to `supplier_name` (the canonical
name). `importCSV` remaps this to `original_supplier_name` at the SQL INSERT level only —
the stored mapping in the `uploads` table keeps `supplier_name` as the key so downstream
consumers (derive-mappings, column priorities) see the correct canonical name. Do not mutate
the mapping object; remap at the SQL level only.

**Check:** If code mutates a mapping dict to replace `supplier_name` with
`original_supplier_name`, or if `original_supplier_name` leaks into user-facing UI
(mapping step, priority step, pivot columns), flag it. The user should only ever see
`supplier_name`.

---

### 9. Service delegation — reuse existing service methods before writing new SQL

**Rule:** When a new service or feature needs data, first check whether an existing service
already handles that query. The preferred order is:

1. **Delegate to an existing service method** (e.g., `this.transactions.queryPivotAggregation(...)`)
2. **Add a new method to the relevant service** if the existing methods can't cover it
3. **Write raw SQL only as a last resort** — and even then, the SQL lives in the service
   (e.g., `TransactionStore`), not in the calling class

The calling layer (e.g., `ReportingService`, an IPC handler) handles orchestration and data
transformation — never raw query construction.

**Why it matters:** Duplicating query logic across services means classification JOINs,
virtual dimension handling, column safety guards, and filter logic all have to be maintained
in multiple places. Centralized query methods like `queryPivotAggregation` already handle
virtual dims, taxonomy JOINs, and `TRY_CAST` guards correctly.

**Check:** If a new service method writes SQL that duplicates what an existing service
already does, flag it. Suggest delegating to the existing method instead. Only recommend
new SQL when the existing methods genuinely cannot produce the required result.

**Pattern:**
```ts
// CORRECT — delegate to existing service
class ReportingService {
  constructor(private transactions: ITransactionStore) {}

  async generateSpendByCategory() {
    // Reuse existing method — it handles taxonomy JOIN, virtual dims, filters
    return this.transactions.queryPivotAggregation(['classification_l1'], 'spend_amount')
  }
}

// WRONG — duplicates logic that already exists in TransactionStore
class ReportingService {
  async generateSpendByCategory() {
    // Don't write this — queryPivotAggregation already does it correctly
    return this.db.all(`
      SELECT tax.l1, SUM(spend_amount) FROM transactions
      LEFT JOIN taxonomy_nodes tax ON taxonomy_node_id = tax.id
      GROUP BY tax.l1
    `)
  }
}
```

---

## How to apply this skill

When writing new code, run through relevant rules silently. When reviewing existing code or
a PR, check all 9 rules and report:

```
Architecture Review
───────────────────
✓ DI Container — services injected via constructor
✓ IPC Contract — channel in IPCInvokeMap, handler uses registerHandler()
⚠ DuckDB safety — [describe the issue]
✓ Virtual dims — no classification columns queried directly
✓ column_priorities — saved after import
✓ Interface discipline — new methods on interface
✓ Dynamic schema — getColumns used before optional column access
✓ supplier_name — denormalization acknowledged
⚠ Service delegation — [existing method X should be used instead of new SQL]

Issues found: 2
[Describe each violation and what to change]
```

If no issues are found, confirm with a single line: "Architecture check passed — all 9 invariants satisfied."

When writing code yourself, fix violations inline without waiting for review — just note
what you corrected and why.

**Severity guide for FK / cascade issues:** When deleting or modifying entities that have
FK references from other tables, treat cascade implications as **medium** severity — it's
a common shortcut to bypass the service layer and do direct deletes, which can orphan
related records.
