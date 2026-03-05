# PR Implementation Status

## PR 0: Fix Classification Regression — COMPLETED
**Date:** 2026-03-05

### Changes Made
All 4 bugs from the PR spec were fixed:

1. **Bug 1 (IPC handler swallows errors):** Updated `src/main/ipc/classification.ts` to accept `eventBus` and emit a `failed` progress event in the `.catch()` handler. Updated `src/main/ipc/index.ts` to pass `services.eventBus` to `registerClassificationHandlers()`.

2. **Bug 2 (Early throws):** Verified the outer try/catch at line 179 already wraps column_priorities validation. Bug 1 fix ensures the renderer always gets notified even if the service's failed event is somehow missed.

3. **Bug 3 (Taxonomy node lookup):** Added a `console.warn` when taxonomy node lookup fails, and appends a warning with the attempted path to the classification reasoning so users can see what went wrong in Review.

4. **Bug 4 (Failed transactions missing status):** Added `classificationStatus: 'classification_failed'` to the failed transaction update. Added `'classification_failed'` to the `ClassificationStatus` type union. Updated the stats query in `transactions.ts` to count `classification_failed` as unclassified (not classified).

### Deviations from Plan
- **Skipped preflight validation UI (PR spec item #2):** The PR spec suggested a `classification:preflight` IPC channel and UI preflight checks. This was not implemented as Bug 1's fix (emitting failed events to the renderer) already surfaces the missing prerequisites error messages to the user. Adding a full preflight system is a larger feature that could be a separate PR.
- **No fuzzy matching for taxonomy paths:** The PR spec mentioned considering fuzzy/case-insensitive matching. Only the warning + reasoning append was implemented — fuzzy matching is out of scope for a regression fix.
- **Stats query updated:** Not mentioned in PR spec, but the stats query was counting `!= 'unclassified'` as classified, which would incorrectly count `classification_failed` transactions. Fixed to explicitly check for `IN ('classified_by_ai', 'classified_by_rule')`.

### Files Modified
- `src/main/ipc/classification.ts` — emit failed event in catch, accept eventBus param
- `src/main/ipc/index.ts` — pass eventBus to registerClassificationHandlers
- `src/main/services/classification.ts` — taxonomy warning, failed status on errors
- `src/shared/types/classification.ts` — add `classification_failed` status
- `src/main/services/transactions.ts` — fix stats query for new status

## PR 1: Store Cleanup — COMPLETED
**Date:** 2026-03-05

### Agent Guidance (learned during planning)
**DO NOT reach for a separate Zustand store as a "safe" alternative to React context.**

When moving state out of `workflowStore`, the temptation is to create a second Zustand store (e.g., `reviewFilterStore.ts`) because it preserves the `.getState()` pattern used in Dashboard's functional updater callbacks. This reasoning is flawed:
- It just moves the problem rather than solving it — two global stores is not "local state"
- The `.getState()` pattern in Dashboard exists because of the store; removing the store removes the need for `.getState()`
- The correct fix is to refactor Dashboard's callbacks to use functional `setState` from React context: `setFilters(prev => ({ fieldName: typeof updater === 'function' ? updater(prev.fieldName) : updater }))`
- React's `useState` functional updater always receives the current state — no `.getState()` needed

Follow the PR spec: use React context (`ReviewFilterContext.tsx`), proper `useCallback` with deps, and functional setState. The refactor is more invasive but cleaner.

### Changes Made
1. **Created `src/renderer/components/review/ReviewFilterContext.tsx`** — React context with `useState`, exports `ReviewFilterProvider` + `useReviewFilterContext`. Holds `ReviewFilterState` (moved from store). `ReviewFilterProvider` mounted in `ReviewPage` with `key={projectFilePath}` so state resets when project changes.

2. **Slimmed `workflowStore.ts`** — removed `uploadDraft`, `reviewFilters`, `cachedSuppliers`, `PivotSettings` (dead code). Removed 8 actions. Fixed `partialize` to only persist `{ filePath }` from metadata + `lastRoute`. Bumped persist version to 3.

3. **Updated `useReviewFilters.ts`** — reads from context. Fixed `toFilterConditions` to include filter values as `useCallback` deps.

4. **Updated `Dashboard.tsx`** — all filter reads/writes via `useReviewFilterContext`. All setters use functional `setFilters(prev => ...)` — no `getState()` anywhere.

5. **Updated `UploadPage.tsx`** — `uploadDraft` replaced with individual `useState` hooks. Resets on navigation (accepted per spec).

6. **Updated `SuppliersPage.tsx`** — removed `cachedSuppliers`. Always loads fresh on mount.

### Deviations from Plan
- `tableLocalFilters` was typed as `Record<string, FilterCondition[]>` in old store but actually used as `Record<string, Record<string, string[]>>`. Fixed type in context to match actual usage.
- `PivotSettings` was dead code (not in `WorkflowState`). Deleted.

## PR 2: MultiTable Decomposition — NOT STARTED
## PR 3: Dashboard Decomposition — NOT STARTED
## PR 4: Classification Tree Split — NOT STARTED
## PR 5: Type Safety Fixes — NOT STARTED
## PR 6: Test Infrastructure — NOT STARTED
## PR 7: LLM Key UI — NOT STARTED
