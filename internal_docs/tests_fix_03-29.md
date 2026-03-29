# Test Suite Failures — Root Cause Analysis & Fix Plan

> Generated 2026-03-29. Originally 51 failed tests across 13 test files.
> Organized into 11 root causes. **All fixes applied — 525/525 tests passing.**

---

## Cause 1 — `parseCSVPreview` is async; tests call it synchronously

**Files affected:** `tests/unit/services/ingest.test.ts` (12 failures)

**Root cause:** `IngestService.parseCSVPreview` was changed from a sync method to `async` (it now calls `parseSampleRows` and `countLines`, both async). All 12 test cases called it without `await`.

**Fix applied:** Added `await` to every `parseCSVPreview` call; changed sync `.toThrow()` guards to `await expect(...).rejects.toThrow(...)`.

---

## Cause 2 — Mock `supplierUniverse.open()` returns `undefined`; real `open()` throws for missing file

**Files affected:** `tests/unit/services/project.test.ts` (11 failures), `tests/integration/ipc-workflow.test.ts` Phase 1a (1 failure cascade), `classifier-mock.test.ts` + `classifier-real-run.test.ts` (16 failures each)

**Root cause (mock tests):** `createMockSupplierUniverse()` declared `open` as a bare `vi.fn()` returning `undefined`. `ProjectStore.createProject` destructures `{ created } = await this.supplierUniverse.open()`.

**Fix applied (mock):** Changed to `open: vi.fn().mockResolvedValue({ created: false })` in `tests/helpers/mock-services.ts`.

**Root cause (real tests):** `DuckDBSupplierUniverse.open()` has an `existsSync` guard that throws `SupplierUniverseFileMissingError` for non-existent files.

**Fix applied (real):** Added `supplierUniversePreCreate` helper in both classifier test files that calls `DuckDBInstance.create()` to pre-create the universe file in `beforeAll`.

---

## Cause 3 — `getColumns()` now includes virtual columns; test expected only physical

**Files affected:** `tests/unit/services/transactions.test.ts` — `getColumns` (1 failure)

**Fix applied:** Updated test expected value to include all 7 virtual columns (`supplier_name`, `is_tail_spend`, `classification_l1`, `classification_l2`, `classification_l3`, `classification_path`, `applied_rule_name`).

---

## Cause 4 — `applyRule` no longer throws when rule doesn't exist

**Files affected:** `tests/unit/services/transactions.test.ts` — `applyRule throws if the rule id does not exist` (1 failure)

**Fix applied:** Added rule existence guard at the top of `applyRule` in `src/main/services/transactions.ts`.

---

## Cause 5 — `revertChange` uses toggle semantics; test expects append semantics

**Files affected:** `tests/unit/services/changelog.test.ts` — `revertChange > should revert a change and restore affected rows` (1 failure)

**Root cause:** `ChangelogStore.revertChange` only toggles `is_reverted` on the existing row (no new row inserted). Test expected 2 entries.

**Fix applied:** Updated test to expect 1 entry with `isReverted: true` (toggle semantics). Decision documented in `internal_docs/remaining_fixes/changelog_revert.md`.

---

## Cause 6 — Backend-workflow rules test uses old field name `conditions`

**Files affected:** `tests/integration/backend-workflow.test.ts` — `should list rules with parsed conditions` (1 failure)

**Root cause:** Schema migrated from flat `conditions` to nested `grouped_conditions` (`GroupedFilter` type). Test mock and assertion path were outdated.

**Fix applied:** Updated mock to use `grouped_conditions` JSON and assertion path to `result[0].groupedConditions.groups[0].conditions[0].field`.

---

## Cause 7 — Research-agent test uses `CompanyContext` fields that don't exist in the type

**Files affected:** `tests/unit/agents/research-agent.test.ts` — 2 failures

**Fix applied:** Updated `SAMPLE_COMPANY_CONTEXT` to use existing fields (`industry`, `description`, `sisterCompanies`, `additionalDetails`). Updated assertions accordingly.

---

## Cause 8 — Export test mock causes infinite loop; batched export not accounted for

**Files affected:** `tests/unit/services/export.test.ts` — `should export transactions to CSV` (1 failure, timeout)

**Root cause:** `ExportService.exportCSV` uses a batched while-loop. The test mock always returned 1 row, so the loop never terminated.

**Fix applied:** Added `dataCallCount` tracking — first call returns 1 row, subsequent calls return empty array. Export backend investigation tracked in `internal_docs/remaining_fixes/export_csv.md`.

---

## Cause 9 — IPC `changelog:list` returns `PaginatedChangelog`, test expects array

**Files affected:** `tests/integration/ipc-workflow.test.ts` — Phase 4a (1 failure)

**Fix applied:** Updated test assertion to check paginated shape (`res.data.rows`, `totalCount`, etc.).

---

## Cause 10 — `AppConfigService` constructor calls `app.getPath()` at construction time

**Files affected:** `tests/unit/services/container.test.ts` (2 failures)

**Fix applied:** Added full Electron mock (`app.getPath`, `safeStorage`, `dialog`, `ipcMain`, `BrowserWindow`). Updated container key count assertion from 18 to 22.

---

## Cause 11 — `review-page.integration.test.ts` imports non-existent file

**Files affected:** `tests/integration/review-page.integration.test.ts` (1 file-level failure)

**Root cause:** Test imports `transactionTransform.ts` which was deleted in the v2 refactor.

**Fix applied:** Deleted the test file entirely — the transformation it tested no longer exists as a standalone utility.

---

## Additional: exa-search `isAvailable` accepts empty key

**Files affected:** `tests/unit/services/exa-search.test.ts` — 1 failure

**Fix applied:** Changed `getApiKey()` to `return key?.trim() || null` so empty strings are treated as missing.

---

## Additional: classifier-real-run missing Phase 5b

**Files affected:** `tests/integration/classifier-real-run.test.ts` — Phase 8 (1 failure)

**Root cause:** Tail spend suppliers (`amazon.com`, `cintas`) lacked `l1_l2_path`, causing classification to mark them as errors. The real-run test was missing Phase 5b (categorize suppliers to populate `l1_l2_path`) that the mock test already had.

**Fix applied:** Added Phase 5b test step calling `researcher.categorizeWithSupplierInfo()` and `researcher.categorizeTailSpend()` before classification.

---

## Additional: classifier tests Phase 6 `listRules` → `listRulesPaginated`

**Files affected:** `classifier-mock.test.ts`, `classifier-real-run.test.ts` — Phase 6 assertions

**Root cause:** `listRules()` only returns rules with `group_id IS NOT NULL`. Tests create ungrouped rules, so `listRules()` returned empty.

**Fix applied:** Changed to `listRulesPaginated({ limit: 100, offset: 0 })` which returns all rules.

---

## Additional: classifier-real-run Phase 6 `createRule` used old schema

**Files affected:** `tests/integration/classifier-real-run.test.ts` — Phase 6

**Root cause:** Used old `conditions`/`priorityScore` fields instead of `groupedConditions`.

**Fix applied:** Updated to use `groupedConditions` format matching `GroupedFilter` type.

---

## Summary Table

| # | Root Cause | Failures | Status |
|---|-----------|---------|--------|
| 1 | `parseCSVPreview` async/sync mismatch | 12 | **Fixed** |
| 2 | Mock `open()` returns `undefined`; real `open()` throws | 28 | **Fixed** |
| 3 | `getColumns()` appends virtual columns | 1 | **Fixed** |
| 4 | `applyRule` dropped rule-existence guard | 1 | **Fixed** |
| 5 | `revertChange` toggle vs append semantics | 1 | **Fixed** |
| 6 | Rules test uses old `conditions` field | 1 | **Fixed** |
| 7 | `CompanyContext` missing fields in test | 2 | **Fixed** |
| 8 | Export mock infinite loop | 1 | **Fixed** |
| 9 | `changelog:list` returns paginated object | 1 | **Fixed** |
| 10 | `AppConfigService` needs Electron mock | 2 | **Fixed** |
| 11 | `transactionTransform.ts` deleted | 1 | **Fixed** (test removed) |
| + | `isAvailable()` truthy for empty string | 1 | **Fixed** |
| + | classifier-real-run missing Phase 5b | 1 | **Fixed** |
| + | `listRules` → `listRulesPaginated` | 2 | **Fixed** |
| + | `createRule` old schema | 1 | **Fixed** |
| **Total** | | **~57** | **All fixed** |
