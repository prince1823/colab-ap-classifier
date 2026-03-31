# L1/L2 Pre-Population & Tail Spend Classification — Spec v2

**Date:** 2026-03-26

---

## Overview

Two connected improvements to the classification pipeline:

1. **L1/L2 pre-population during research phase.** L1/L2 is resolved during research and stored on `project_suppliers.l1_l2_path`, giving users a chance to review and edit it before classification runs. Call 1 is removed from classification entirely.

2. **Tail spend L3 classification.** Tail spend suppliers get a proper L3 classification using their transaction groups. Multiple tail spend suppliers sharing the same L2 are batched into a single call.

---

## Target Architecture

```
Research Phase
  researchAll()
    → per non-tail-spend supplier:
        if universe hit: return cached supplier_info (skip Exa)
        else: Exa → ResearchAgent → supplier_info

  categorizeTailSpend(taxonomy, context, columnPriorities)
    → per tail spend supplier (concurrent pool):
        build dedup groups from transactions
        batch 10 suppliers per LLM call (max 300 groups per call, no supplier split)
        ClassificationAgent.selectCategoriesForTailSpend()
        validateCategoryPath() → write l1_l2_path

  categorizeWithSupplierInfo(taxonomy, context)
    → per non-tail-spend supplier with supplier_info and no l1_l2_path (concurrent pool):
        batch 10 suppliers per LLM call
        ClassificationAgent.selectCategories()
        validateCategoryPath() → write l1_l2_path

[User reviews / edits l1_l2_path on Suppliers page]

Classification Phase
  classifyAll()
    → Phase 1: apply override rules (unchanged)
    → Phase 2: per non-tail-spend supplier:
        read l1_l2_path from project_suppliers
        if null: mark classification_error, log warning, skip
        Call 2 (classifyL3): one call per supplier, unchanged structure
    → Phase 3: tail spend suppliers:
        group by L2 from l1_l2_path
        per L2 group: classifyL3ForTailSpend() (max 10 suppliers, max 300 groups)
        one L3 per supplier written to transactions
        tail spend with l1_l2_path = null: mark classification_error, log warning
```

---

## Design Decisions

- **`project_suppliers.l1_l2_path` is the sole L1/L2 source of truth.** Call 1 is removed from classification. If `l1_l2_path` is null at classification time, the supplier is marked `classification_error` — no live fallback.
- **Universe hits and Exa suppliers handled together** in `categorizeWithSupplierInfo()`. Both have `supplier_info` populated; the Exa vs universe distinction only affects research speed.
- **Tail spend batching.** Max 300 groups per `selectCategoriesForTailSpend` call. If a single supplier has >300 groups, they get their own call. Suppliers are never split across calls.
- **Tail spend L3.** One L3 path per supplier. LLM sees all groups for context but returns a single best-fit path.
- **Validation.** LLM-returned paths validated via `validateCategoryPath()` before writing. Null result → skip write, log warning.
- **`ClassificationAgent` injected into `SupplierResearcher` via constructor.** Interface type only, not concrete class.

---

## Task 1: Schema & Types

### `src/main/services/database.ts`
- Add `l1_l2_path VARCHAR` to `project_suppliers` DDL
- Add migration: `ALTER TABLE project_suppliers ADD COLUMN IF NOT EXISTS l1_l2_path VARCHAR`

### `src/shared/types/suppliers.ts`
- Add `l1L2Path: string | null` to `ProjectSupplier`
- Add `l1L2Path?: string` to `SupplierUpdateInput`

### `src/main/services/supplier-service.ts`
- Update `updateSupplier` to write `l1_l2_path`
- Update row-mapping to read `l1_l2_path` back into `ProjectSupplier`
- `updateSupplier` is already on the `SupplierService` interface — `SupplierUpdateInput` type change is sufficient

### `src/shared/types/services.ts` — `SupplierResearcher` interface
Add `categorizeTailSpend` and `categorizeWithSupplierInfo`:
```ts
export interface SupplierResearcher {
  researchSingle(supplierName: string): Promise<SupplierInfo>;
  researchAll(supplierIds?: string[]): Promise<void>;
  categorizeWithSupplierInfo(taxonomy: TaxonomyNode[], companyContext: CompanyContext): Promise<void>;
  categorizeTailSpend(taxonomy: TaxonomyNode[], companyContext: CompanyContext, columnPriorities: string[]): Promise<void>;
  cancel(): void;
}
```

---

## Task 2: New Agent Methods

### `ClassificationAgent.selectCategoriesForTailSpend(input: TailSpendCategorySelectionInput)`

**File:** `src/main/agents/classification-agent.ts`

- **System prompt:** Same as `selectCategories` — return one L1|L2 per supplier. Uses transaction groups as the classification signal instead of supplier research.
- **User prompt:** Taxonomy L1|L2 nodes + descriptions, company context, then per-supplier blocks:
  ```
  Supplier 1: Acme Cleaning
  Group 1 (4 rows):
    gl_description: Janitorial services
  Group 2 (1 row):
    gl_description: Cleaning supplies
  ```
- **Response format:**
  ```json
  {"categories": [{"supplierIndex": 1, "categoryPath": "Facilities|Utilities"}, ...]}
  ```
- **Input type:** `TailSpendCategorySelectionInput` — same shape as `CategorySelectionInput` but with `groups` per supplier instead of `supplierInfo`
- Add to `ClassificationAgent` interface in `src/shared/types/services.ts`

### `ClassificationAgent.classifyL3ForTailSpend(input: TailSpendL3Input)`

**File:** `src/main/agents/classification-agent.ts`

- **Input:** Multiple tail spend suppliers sharing the same L2, each with their dedup groups. Max 10 suppliers per call, max 300 groups total.
- **System prompt:** Same as `classifyL3`. One L3 per supplier.
- **User prompt:**
  ```
  Category branch: Facilities|Utilities

  Available L3 categories:
    Facilities|Utilities|Electric - ...
    Facilities|Utilities|Water - ...

  Supplier 1: City Water Dept
  Group 1 (2 rows):
    gl_description: Water utility
  ```
- **Response format:**
  ```json
  {"assignments": [{"supplierIndex": 1, "classificationPath": "Facilities|Utilities|Water"}, ...]}
  ```
- **Retry:** Up to 3 attempts. On retry, re-send only missing `supplierIndex` values.
- Add to `ClassificationAgent` interface in `src/shared/types/services.ts`

---

## Task 3: New Supplier Researcher Methods

**File:** `src/main/services/supplier-research.ts`

### Constructor
- Add `classificationAgent: IClassificationAgent` (interface type)
- Update `createContainer()` in `src/main/container.ts` to inject it

### `categorizeWithSupplierInfo(taxonomy, companyContext)`
- Fetch suppliers: `isTailSpend = false`, `supplier_info != null`, `l1_l2_path = null`
- Concurrent worker pool (same `CONCURRENCY` constant), batches of 10 per LLM call
- Call `classificationAgent.selectCategories()` — existing method, no changes needed
- `validateCategoryPath(path, taxonomy)` — write on match, log warning and skip on null
- Write via `supplierService.updateSupplier(id, { l1L2Path: path })`
- Emit `currentStep: 'Categorizing suppliers...'` + percentage on `suppliers:research:progress`

### `categorizeTailSpend(taxonomy, companyContext, columnPriorities)`
- Fetch suppliers: `isTailSpend = true`, `l1_l2_path = null`
- Per supplier: `buildDedupGroups(transactions, columnPriorities)`
- Batch: accumulate up to 10 suppliers; stop if adding the next would exceed 300 total groups; single supplier >300 groups gets its own call
- Concurrent worker pool (same `CONCURRENCY` constant)
- Call `classificationAgent.selectCategoriesForTailSpend()`
- Validate and write same as above
- No progress events

---

## Task 4: IPC Handler

**File:** `src/main/ipc/supplier-research.ts`

Update `registerSupplierResearchHandlers` to accept `taxonomy: TaxonomyStore` and `project: ProjectStore` and update the call site in the main entry point.

```typescript
registerHandler('suppliers:researchAll', async (_event, supplierIds?: unknown) => {
  const ids = Array.isArray(supplierIds) ? (supplierIds as string[]) : undefined;

  const taxonomyNodes = await taxonomy.getNodes();
  const context = await project.getCompanyContext();
  const columnPriorities = await project.getSetting('column_priorities') as string[];

  // categorizeTailSpend is independent of researchAll — run in parallel
  researcher.categorizeTailSpend(taxonomyNodes, context, columnPriorities)
    .catch((err) => console.error('[IPC] Tail spend categorization failed:', err));

  // categorizeWithSupplierInfo depends on researchAll completing first
  researcher.researchAll(ids)
    .then(() => researcher.categorizeWithSupplierInfo(taxonomyNodes, context))
    .catch((err) => console.error('[IPC] Research/categorization failed:', err));
});
```

`researchAll` is unchanged — it still emits `status: 'completed'` when research finishes. Categorize phases run silently after; `l1_l2_path` will be present when the user views the Suppliers page.

---

## Task 5: Classification Changes

**File:** `src/main/services/classification.ts`

### Remove Call 1
- Delete the `selectCategories` batch phase
- For each non-tail-spend supplier: read `l1_l2_path` from `project_suppliers`
- If null: log `[Classification] l1_l2_path missing for "${supplierName}" — marking as error`, mark all transactions `classification_error`, skip to next supplier

### Non-tail-spend Call 2
- Unchanged in structure
- Feed stored `l1_l2_path` as the category branch

### Tail spend Phase 3 (new)
- Collect all tail spend suppliers with `l1_l2_path != null`
- Group by L2 portion of `l1_l2_path`
- Per L2 group: `classifyL3ForTailSpend()` (max 10 suppliers, max 300 groups)
- Write returned `classificationPath` to all transactions for each supplier
- Tail spend with `l1_l2_path = null`: mark `classification_error`, log warning

---

## Task 6: Frontend

**File:** `src/renderer/pages/Suppliers.tsx`

- Display `l1L2Path` per supplier row
- Editable: dropdown or text input validated against taxonomy L1|L2 nodes (`taxonomy:getNodes`, filtered to `depth === 2`)
- Save via existing `suppliers:update` IPC
- Add `l1L2Path` to `IPCInvokeMap` update args if not already covered

---

## Testing

### Tests that will break and need updating

**`classification.test.ts` — `two-call architecture` describe block**
All tests in this block are obsolete. Replace with:
- `l1_l2_path present → selectCategories not called, classifyL3 receives stored path`
- `l1_l2_path null → transactions marked classification_error, classifyL3 not called, warning logged`
- `tail spend with l1_l2_path → classifyL3ForTailSpend called, grouped by L2`
- `tail spend with l1_l2_path null → classification_error, warning logged`

**`classification.test.ts` — `"should mark transactions as error when Call 1 returns no category"`**
Delete. Replaced by the `l1_l2_path null → classification_error` case above.

**`classification.test.ts` — `setupBasicMocks`**
Remove `selectCategories` mock. Tests should instead inject `l1_l2_path` on the supplier DB row so classification reads it directly.

**`supplier-research.test.ts` — constructor call**
Currently passes 4 args; real constructor takes 5 (`supplierService` missing). Needs fixing regardless; also add `classificationAgent` as 6th arg.

**`classifier-mock.test.ts` — Phase 5 and Phase 7**
Phase 5 researches suppliers but doesn't populate `l1_l2_path`. Phase 7 classifyAll would mark everything `classification_error`. Add Phase 5b: run `categorizeTailSpend` + `categorizeWithSupplierInfo`, assert `l1_l2_path` populated on `project_suppliers` before Phase 7. Update mock `ClassificationAgent` to include `selectCategoriesForTailSpend` and `classifyL3ForTailSpend`.

### New tests needed

**`classification-agent.test.ts`**
- `selectCategoriesForTailSpend`: prompt includes group blocks per supplier; parser extracts `supplierIndex → path`; missing/invalid path absent from result map
- `classifyL3ForTailSpend`: prompt shows L2 branch + L3s + groups; parser extracts assignments; retry re-sends only missing `supplierIndex` values; partial result returned after max retries

**`supplier-research.test.ts`**
- `categorizeWithSupplierInfo`: fetches correct supplier subset; calls `selectCategories` in batches of 10; validates before writing; skips null results with warning; emits progress
- `categorizeTailSpend`: batches by 10-supplier / 300-group limits; single supplier >300 groups gets own call; validates and writes

---

## Enhancements

### Progress bar coverage for categorize phases — implemented

The IPC handler (`src/main/ipc/supplier-research.ts`) now owns the full research→categorize lifecycle:

1. **Sequential phases in fire-and-forget IIFE:** `researchAll(ids, { suppressTerminal: true })` → `categorizeWithSupplierInfo()` → `categorizeTailSpend()` → single `'completed'` emit from the IPC handler via `eventBus`.
2. **`suppressTerminal` option on `researchAll`:** When true, skips the internal `'completed'` emit so the IPC handler controls the terminal event.
3. **Per-phase try/catch:** Each phase is individually caught (log and continue) so one failure doesn't skip subsequent phases. Outer `.catch()` emits `status: 'failed'`.

Additional fixes shipped alongside:

- **Classification `stop()` consistency (B1):** Changed `ClassificationRunner.stop()` to emit `status: 'cancelled'` (was `'stopped'`), matching research/QC pattern. Removed `'stopped'` from `ClassificationProgress.status` union. Simplified `ClassificationControls.handleCancel()` — removed manual store override, backend event handles it.
- **SuppliersPage terminal refresh (B2):** Auto-refresh on `'completed' | 'cancelled' | 'failed'` (was only `'completed'`).
- **Timer cleanup (B3):** `subscribeToResearchProgress` stores timeout ID, clears on new events and unsubscribe.
- **Dead channel removal (B4):** Removed `classification:cancel` from IPC contract and renderer (no handler existed).

### Phase 3 tail-spend parallelization — implemented

Phase 3 (tail-spend L3 classification) previously processed L2 categories sequentially. Since L2 groups are fully independent (different taxonomy branches, different suppliers), all batches across all L2 categories are now flattened into a single task array and processed via `runPool(tasks, concurrency)` — the same bounded concurrency pool used by Phase 2.

- **Preparation** (sequential): iterate L2 groups, fetch transactions, build dedup groups, create batches — all pushed into a flat `tailSpendTasks` array
- **Execution** (concurrent): all batches processed via worker pool with `DEFAULT_CONCURRENCY` (5, or `CLASSIFIER_CONCURRENCY` env override)
- Progress counter (`processedSuppliers`) incremented per-supplier inside each task — safe due to JS single-threaded async

#### Deferred: scoped categorization

`categorizeWithSupplierInfo` and `categorizeTailSpend` still operate on ALL eligible suppliers regardless of which `supplierIds` were passed to `researchAll`. Adding optional `supplierIds` scoping is a clean additive change deferred to future work. See `spec-progress-lifecycle.md` (archived in git history) for full analysis.

---

## Execution Order

```
Task 1 (schema/types) — first, everything depends on it
Task 2 (agent methods) — after Task 1
Task 3 (researcher methods) — after Task 2
Task 4 (IPC handler) — after Task 3
Task 5 (classification changes) — after Task 1; independent of Tasks 2–4
Task 6 (frontend) — after Task 1; can be done last
```

---

## Primary-Group Sampling (2026-03-29)

### Problem
Grouping by all priority columns (gl_description + memo + line_description) produced up to 540K
groups across 99 suppliers. `line_description` is nearly unique per transaction for high-volume
suppliers (amerisource bergen: 164K groups from 695K txns), causing excessive LLM calls and cost.

### Solution
Modified `buildDedupGroups` in-place to use primary-group sampling:
- Group by the **highest-priority column only** (primary key)
- Sample up to X values from each lower-priority column using **frequency weighting** (most-common
  first) as supporting context per group
- One classification per primary group — all transactions sharing that primary value get the result
- Applied uniformly to all callers: classification (Phase 2 + Phase 3), QC, and supplier research

### Result (03-29 test dataset, 99 suppliers)
- Before: 540,901 groups
- After (gl_description primary): 8,036 groups — 67× reduction

### Key design decisions
- **In-place modification of `buildDedupGroups`**: All callers automatically get the new behavior.
  No new function added.
- **`groups: { fields, count }[]` added to `DedupGroupResult`**: Allows tail-spend formatters to
  consume structured group data directly, replacing the manual `extractFields(firstTxn)` reconstruction.
- **Frequency-weighted sampling**: Full pass over group transactions, sort by occurrence count desc,
  take top X. Surfaces most representative values.
- **`DEFAULT_SAMPLE_COUNT = 3`**: Configurable per run via `config.json` → `sampleCount` →
  project setting `classification_sample_count`.
- **Fallback**: If `columnPriorities` is empty, original full-combination keying is preserved.
