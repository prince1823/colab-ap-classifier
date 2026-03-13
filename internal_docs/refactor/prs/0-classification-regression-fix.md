# PR 0: Fix Classification Regression — Errors Silently Swallowed

## Symptoms
User can't get past the classify step. Classification appears to start but nothing happens,
or it "completes" but the Review tab stays disabled.

## Root Causes Found (multiple compounding issues)

### Bug 1 (CRITICAL): IPC handler swallows errors — user never sees failures
**File:** `src/main/ipc/classification.ts:5-10`

The handler is fire-and-forget with a `.catch()` that only logs to main process console:
```typescript
classifier.classifyAll().catch((err) => {
  console.error('[IPC] Classification failed:', err);  // user never sees this
});
```

If `classifyAll()` throws before emitting any progress event (e.g., missing column_priorities,
missing taxonomy, missing suppliers), the renderer gets `{ success: true, data: undefined }`
and never learns about the error. The ClassificationPage shows "No classification in progress"
with no error message.

**Fix:** Emit a `failed` progress event in the `.catch()` so the renderer is notified:
```typescript
classifier.classifyAll().catch((err) => {
  console.error('[IPC] Classification failed:', err);
  eventBus.emit('classification:progress', {
    status: 'failed',
    totalSuppliers: 0,
    processedSuppliers: 0,
    percentage: 0,
    currentSupplier: null,
    currentStep: err instanceof Error ? err.message : String(err),
  });
});
```

### Bug 2 (HIGH): Early throws bypass progress events entirely
**File:** `src/main/services/classification.ts:106-117`

If `column_priorities` is not set or contains invalid columns, the service throws.
The outer `catch` at line 179 DOES emit a `failed` progress event — but only if
`!this.isCancelled`. However, the throw from column validation happens BEFORE
`this.isRunningFlag = true` is set in some code paths, and crucially, the IPC handler's
`.catch()` eats the re-thrown error (Bug 1). So the `failed` event from line 181 IS emitted
to the EventBus, but only if we actually reach it. Double-check this path.

**Fix:** Verify the outer try/catch properly wraps the column_priorities validation.
The code at line 179 should handle this correctly already, but Bug 1 prevents any
error from surfacing to the user if it doesn't.

### Bug 3 (HIGH): Taxonomy node lookup silently produces null taxonomyNodeId
**File:** `src/main/services/classification.ts:279-288`

After LLM returns a classification, `taxonomy.find(n => n.fullPath === result.classificationPath)`
can return `undefined` if the LLM's path doesn't exactly match any node's `fullPath`.
When this happens, `taxonomyNodeId` is `undefined`, so transactions get status
`classified_by_ai` but no taxonomy node — making them half-classified ghosts that
count in stats but may not display properly in Review.

**Fix:** Log a warning when lookup fails, and consider falling back to the closest
matching node. At minimum, include the attempted path in the reasoning field so
users can see what went wrong.

### Bug 4 (MEDIUM): Individual supplier failures don't update classification_status
**File:** `src/main/services/classification.ts:131-150`

When a supplier fails, the catch block writes a `classificationReasoning` message
but does NOT update `classificationStatus`. The transaction stays `unclassified`,
which means the loop finishes, emits `completed`, but some transactions are still
unclassified with no visible indication of why.

**Fix:** Set `classificationStatus: 'failed'` (or a new status) on failed transactions
so the user can see in Review which ones failed and why.

## Likely scenario for the user's regression

1. User starts classification
2. `column_priorities` is missing or invalid → throws at line 108
3. Outer catch (line 179) emits `failed` progress event to EventBus
4. EventBus emits to renderer via `webContents.send`
5. BUT: IPC handler's `.catch()` also fires, logging the error silently
6. Renderer receives the `failed` progress event and shows error briefly
7. OR: the outer catch never fires because the throw happens in a code path
   that isn't wrapped — need to verify

Most likely: The `failed` event IS emitted by line 181, but the user doesn't understand
the error message ("Column priorities must be configured..."). The fix is:
- Make error messages user-friendly
- Show the error prominently in the ClassificationPage UI
- Add a pre-flight check before starting that validates all prerequisites

## Changes

### 1. Fix IPC handler to forward errors to renderer
- `src/main/ipc/classification.ts` — emit `failed` progress in `.catch()`
- Pass `eventBus` to `registerClassificationHandlers()`

### 2. Add pre-flight validation with clear error messages
- Before calling `classifyAll()`, check prerequisites in the UI or add a
  `classification:preflight` IPC channel that returns a checklist:
  - Has taxonomy? Has column priorities? Has unclassified transactions?
- Show missing prerequisites as actionable messages in ClassificationPage

### 3. Handle taxonomy node lookup failures
- `src/main/services/classification.ts:279` — warn and include path in reasoning
- Consider fuzzy matching or at least case-insensitive comparison

### 4. Mark failed transactions with a proper status
- `src/main/services/classification.ts:140-148` — set `classificationStatus: 'classification_failed'`
  or similar so they're visible in Review

## Files touched
- `src/main/ipc/classification.ts`
- `src/main/services/classification.ts`
- `src/renderer/pages/ClassificationPage.tsx` (show preflight errors)
- `src/renderer/components/classification/ClassificationControls.tsx` (preflight check)
- `src/shared/types/classification.ts` (add preflight types if needed)
- `src/shared/types/ipc-contract.ts` (add `classification:preflight` channel)
