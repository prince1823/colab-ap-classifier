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

## PR 1: Store Cleanup — NOT STARTED
## PR 2: MultiTable Decomposition — NOT STARTED
## PR 3: Dashboard Decomposition — NOT STARTED
## PR 4: Classification Tree Split — NOT STARTED
## PR 5: Type Safety Fixes — NOT STARTED
## PR 6: Test Infrastructure — NOT STARTED
## PR 7: LLM Key UI — NOT STARTED
