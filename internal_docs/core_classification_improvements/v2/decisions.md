# Implementation Decisions — Spec v2

Deviations and implementation choices made during development.

---

## 1. Database dependency added to SupplierResearcher

**Spec says:** SupplierResearcher receives `classificationAgent` via constructor (6th arg).

**Actual:** Also added `db: Database` as 7th constructor arg.

**Why:** `categorizeTailSpend` needs to fetch transaction rows per supplier to build dedup groups. The existing constructor dependencies (SupplierService, SupplierUniverse, etc.) don't expose transaction queries. Rather than expanding the SupplierService interface with a method only needed here, injecting `Database` directly is simpler and follows the existing pattern used by ClassificationRunner.

---

## 2. Tail spend L3 in classification (Phase 3) builds groups inline

**Spec says:** Phase 3 calls `classifyL3ForTailSpend()` per L2 group.

**Actual:** The classification runner builds dedup groups inline using `buildDedupGroups` + `extractFields`, same as `categorizeTailSpend` in SupplierResearcher. This duplicates the group-building logic slightly but avoids adding a shared "build supplier groups" utility for what is a straightforward sequence of existing utility calls.

---

## 3. L1|L2 Category field as text input (not taxonomy dropdown)

**Spec says:** "Editable: dropdown or text input validated against taxonomy L1|L2 nodes."

**Actual:** Implemented as a text input. A taxonomy-validated dropdown would require fetching taxonomy nodes in the renderer, building a filtered L1|L2 list, and wiring a typeahead/combobox component. The text input is functional for v1 — users can type the pipe-delimited path directly. The backend validates paths during classification anyway (null l1_l2_path = classification_error). A dropdown can be added as a follow-up enhancement.

---

## 4. Progress bar extended for categorize phases — implemented

**Spec Enhancement section says:** Extend the progress bar to cover categorize phases by changing `researchAll` terminal event and having IPC handler own the `completed` emit.

**Actual:** Implemented. The IPC handler now runs phases sequentially (`researchAll` → `categorizeWithSupplierInfo` → `categorizeTailSpend`) and emits a single `'completed'` event after all phases finish. `researchAll` accepts `{ suppressTerminal: true }` to skip its internal terminal emit. Per-phase try/catch prevents stuck progress bars. See spec-v2.md Enhancements section for full details.

---

## 5. Tests updated

All tests from the spec's testing section were implemented:

- **`classification.test.ts`**: Replaced `two-call architecture` block with `l1_l2_path-based classification` tests. Removed `selectCategories` mock from `setupBasicMocks`. Added tests for null `l1_l2_path` → error, tail spend with/without `l1_l2_path`.
- **`supplier-research.test.ts`**: Fixed constructor (was passing 4 args, now passes 7). Added tests for `categorizeWithSupplierInfo` and `categorizeTailSpend`.
- **`classification-agent.test.ts`**: Added tests for `buildTailSpendCategorySelectionSystemPrompt`, `buildTailSpendCategorySelectionUserPrompt`, `buildTailSpendL3SystemPrompt`, `buildTailSpendL3UserPrompt`, `parseTailSpendL3Response`.
- **`classifier-mock.test.ts`**: Fixed `SupplierResearcher` constructor, added Phase 5b, added `selectCategoriesForTailSpend` and `classifyL3ForTailSpend` to mock agent, fixed `IngestService` constructor (pre-existing missing `eventBus` arg).
- **`mock-services.ts`**: Added `selectCategoriesForTailSpend`, `classifyL3ForTailSpend` to mock agent. Added `categorizeWithSupplierInfo`, `categorizeTailSpend` to mock researcher. Fixed `SupplierService` mock to match current interface.

**Note:** The `classifier-mock.test.ts` integration test has pre-existing failures (Phase 1 cascading) that existed before this work and are unrelated to the spec changes.

---

## 6. Phase 3 tail-spend parallelization — flattened task approach

**Spec says:** Phase 3 processes L2 groups sequentially, batches within each L2 sequentially.

**Actual:** All batches across all L2 categories are flattened into a single `tailSpendTasks` array, then executed via `runPool(tasks, concurrency)`.

**Why:** L2 groups are fully independent (different taxonomy branches, different suppliers). Two alternatives were considered: (a) nested parallelism (parallelize L2s, then parallelize batches within each L2), or (b) flatten everything into one task pool. Option (b) is simpler — no nested concurrency limits to tune — and the single pool naturally load-balances across L2 groups of varying sizes. The preparation phase (fetching transactions, building dedup groups) remains sequential since it's fast CPU/DB work; only the LLM calls benefit from concurrency.
