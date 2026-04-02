# Silent Failure Audit

Audit of error handling gaps where backend failures do not surface to the user via UI toasts.

**Date:** 2026-04-02
**Branch:** dev (01a53f5)
**Fixed:** 2026-04-02 (branch: fix/silent-failure-audit)

---

## How Errors Should Flow

```
Backend throw/reject
  → IPC handler wrapper (register.ts) catches → returns { success: false, error }
  → Frontend receives IPCResponse → showError() toast
```

For fire-and-forget operations (classification, research, QC):
```
Backend emits eventBus error event → workflowStore listener → UI progress indicator
```

---

## P0 — Backend Fails, User Sees Nothing

### 1. SuppliersPage: research/categorize IPC errors swallowed with console.error

**Files:** `src/renderer/pages/SuppliersPage.tsx:236-296`

Four `.catch((err) => console.error(...))` calls with no toast:
- `ipc.suppliers.researchAll(ids)` (line 236)
- `ipc.suppliers.categorizeAll()` (line 254)
- `ipc.suppliers.categorizeAll(ids)` (line 279) — categorize selected
- `ipc.suppliers.categorizeAll([supplier.id])` (line 294) — categorize single

These are fire-and-forget calls. The IPC handlers do emit progress events on error, BUT the `.catch()` here handles the case where the IPC call itself rejects (e.g., serialization error, handler registration missing). In that scenario the user sees nothing.

**Fix:** Replace `console.error` with `showError('Research failed', err)` / `showError('Categorization failed', err)`.
**Status:** Fixed.

### 2. suppliers:categorizeAll IPC handler swallows inner errors

**File:** `src/main/ipc/supplier-research.ts:54-65`

```typescript
try {
  await researcher.categorizeWithSupplierInfo(taxonomyNodes, context, ids);
} catch (err) {
  console.error('[IPC] Non-tail-spend categorization failed:', err);  // swallowed
}
// ...same for categorizeTailSpend
// Then emits status: 'completed' regardless
```

Both categorization phases catch errors independently and log to console. Then the handler unconditionally emits `status: 'completed'`. The user sees "Complete" even if both phases failed entirely.

**Fix:** Track whether either phase failed. If so, emit `status: 'failed'` with an error summary.
**Status:** Fixed — errors array accumulates phase failures; emits `failed` if any.

### 3. Undo/Redo failures — console.error only

**File:** `src/renderer/hooks/useUndoRedo.ts:47-48, 64-65`

```typescript
} catch (err) {
  console.error('[Undo] Failed to revert:', err)
```

User presses Cmd+Z, revert fails, entry is pushed back on stack, but no feedback that it failed. User may keep pressing Cmd+Z with no visible result.

**Fix:** Call `showError()` in catch blocks.
**Status:** Fixed.

### 4. QC config save — .catch(console.error)

**File:** `src/renderer/components/qc/QCPanel.tsx:125`

```typescript
ipc.qc.setConfig(newConfig).catch(console.error)
```

User changes QC scope/settings, save fails silently. User proceeds to run QC with stale config.

**Fix:** `showError('Failed to save QC config', err)`.
**Status:** Fixed.

### 5. QC stop — console.error only

**File:** `src/renderer/components/qc/QCPanel.tsx:169`

```typescript
console.error('Failed to stop QC:', e)
```

User clicks Stop, it fails, no feedback. QC keeps running.

**Fix:** `showError('Failed to stop QC', e)`.
**Status:** Fixed.

### 6. Classification cancel — console.error only

**File:** `src/renderer/components/classification/ClassificationControls.tsx:67`

```typescript
console.error('Failed to cancel classification:', e)
```

Same pattern as QC stop. User thinks they cancelled but classification continues.

**Fix:** `showError('Failed to cancel classification', e)`.
**Status:** Fixed.

### 7. ExportCSVPanel — column load and export errors swallowed

**File:** `src/renderer/components/ExportCSVPanel.tsx:27, 103`

```typescript
.catch(() => {})        // column load — user sees empty column list with no explanation
// ...
} catch {               // export — user sees nothing, exporting spinner just stops
```

**Fix:** Column load: `showError('Failed to load export columns', err)`. Export: `showError('Export failed', err)`.
**Status:** Fixed.

### 8. FileDropZone — file select error swallowed

**File:** `src/renderer/components/upload/FileDropZone.tsx:22`

```typescript
console.error('[FileDropZone] Failed to select file:', e)
```

If file dialog errors (not cancellation), user gets no feedback.

**Fix:** `showError('Failed to select file', e)`.
**Status:** Fixed.

---

## P1 — Backend Partially Fails, User Sees Success

### 9. Supplier research batch failures hidden behind progress bar

**File:** `src/main/services/supplier-research.ts:270-272, 412-414`

```typescript
} catch (err) {
  console.error('[Research] categorizeWithSupplierInfo batch failed:', err);
  // batch continues — progress bar advances
}
```

Individual batch failures in `categorizeWithSupplierInfo` and `categorizeTailSpend` are caught and logged. The progress bar advances past them. The final event says "completed" even if 50% of batches failed.

**Fix:** Accumulate failed supplier IDs. Include failure count in the completed event so the frontend can show "Completed with N errors".

### 10. Supplier info persistence failure masked

**File:** `src/main/services/supplier-research.ts:178-182`

```typescript
} catch (updateErr) {
  console.error(`[Research] Failed to persist info for "${supplier.supplierName}":`, updateErr);
  await this.supplierService.markResearched(supplier.id);  // still marks as researched!
}
```

If writing research info to DB fails, the supplier is still marked as researched. User sees it as "researched" but it has no data. Subsequent categorization may fail or produce poor results.

**Fix:** Don't mark as researched if persistence failed — supplier stays unresearched for retry.
**Status:** Fixed.

### 11. QC scope count silently falls back to null

**File:** `src/renderer/components/qc/QCPanel.tsx:103-104`

```typescript
} catch {
  setScopeCount(null)
}
```

If count query fails, the UI shows no count. This is minor since the user can still proceed, but there's no indication the query failed vs. "calculating...".

---

## P2 — Acceptable or Low-Impact

### 12. Database serialize queue error recovery

**File:** `src/main/services/database.ts:53`

```typescript
this.queue = next.catch(() => {});
```

This looks alarming but is actually correct: the `.catch(() => {})` is on the **queue chain** to prevent rejected promises from blocking subsequent queries. The actual error still propagates to the caller via the `next` return value. Not a silent failure — just unusual error recovery. No fix needed.

### 13. EventBus listener errors swallowed in ingest

**File:** `src/main/services/ingest.ts:294-300`

Intentional — prevents listener bugs from crashing imports. Acceptable if rare.

### 14. company_context fallback to { industry: 'Unknown' }

**File:** `src/main/ipc/supplier-research.ts:38-39`

Graceful fallback for optional setting. Acceptable.

### 15. AppShell auto-reopen warning

**File:** `src/renderer/components/AppShell.tsx:58`

`console.warn` for failed auto-reopen. Low impact — user lands on project picker instead.

---

## Summary

| # | Location | Severity | Pattern |
|---|----------|----------|---------|
| 1 | SuppliersPage research/categorize | P0 | `.catch(console.error)` |
| 2 | suppliers:categorizeAll IPC handler | P0 | Inner catch swallows, emits "completed" |
| 3 | useUndoRedo | P0 | `console.error` only |
| 4 | QCPanel config save | P0 | `.catch(console.error)` |
| 5 | QCPanel stop | P0 | `console.error` only |
| 6 | ClassificationControls cancel | P0 | `console.error` only |
| 7 | ExportCSVPanel | P0 | `.catch(() => {})` |
| 8 | FileDropZone | P0 | `console.error` only |
| 9 | Supplier research batch failures | P1 | Batch error caught, progress continues |
| 10 | Supplier info persistence | P1 | Marks researched despite write failure |
| 11 | QC scope count | P2 | Falls back to null silently |

**8 P0 issues** where the user gets zero feedback on failure. **All fixed.**
**2 P1 issues** where partial failure is reported as full success. **Both fixed (#9 via A1, #10 via persistence fix).**

---

## Additional Findings (2026-04-02 fix pass)

### A1. LLM errors silently swallowed in classification and categorization (P0)

All LLM failures (invalid key HTTP 401, rate limit exhaustion, network errors, timeouts, malformed responses) throw `LLMClientError` from `llm-client.ts`. However, these errors are caught and swallowed by per-batch/per-supplier catch blocks in the service layer:

**Categorization** (`src/main/services/supplier-research.ts`):
- `categorizeWithSupplierInfo()` catches per-batch at line 269 → `console.error` → continues
- `categorizeTailSpend()` catches per-batch at line 411 → `console.error` → continues
- Method returns normally even if every batch failed → IPC handler emits `status: 'completed'`
- **SuppliersPage has no render path for `status === 'failed'`** — even if fixed, user sees nothing

**Classification** (`src/main/services/classification.ts`):
- Per-supplier catch at line 272 → marks supplier as error status → continues
- Progress reaches 100%, emits `status: 'completed'` even when every supplier errored
- `ProgressDisplay` DOES render failed state, but never receives it

**Fix (service layer):** Track failed batch/supplier counts. When ALL fail, throw to propagate to the IPC layer which emits `status: 'failed'`. Partial failures continue as before (some batches succeed, some fail).
**Fix (SuppliersPage):** Add `status === 'failed'` render block showing `currentStep` error message.
**Fix (workflowStore):** Extend research progress auto-clear from 3s to 8s for failed status.
**Status:** Fixed.

### A2. AppConfigService.save() — in-memory/disk divergence

**File:** `src/main/services/app-config.ts:74-78`

`save()` mutates in-memory config before writing to disk. If the write fails, the in-memory state diverges from what's persisted — setting appears to work until app restart.

**Fix:** Wrapped in try/catch; on failure, reloads config from disk to restore consistency, then rethrows.
**Status:** Fixed.

### A3. Ingest EventBus emission errors silently swallowed

**File:** `src/main/services/ingest.ts:294-300`

Empty catch block prevents listener bugs from crashing imports. Correct behavior, but no visibility into what went wrong.

**Fix:** Added `debugLog` call in catch block for observability without breaking the import.
**Status:** Fixed.

### A4. Classification ProgressDisplay shows generic failure message

**File:** `src/renderer/components/classification/ProgressDisplay.tsx:90`

When classification fails, the UI showed "Classification failed. Please check your settings and try again." regardless of the actual error (e.g., missing API key, network error).

**Fix:** Now displays `progress.currentStep` (which contains the actual error message from the backend) instead of generic text.
**Status:** Fixed.

### A5. Tail spend categorization silently skipped when column priorities empty (P0)

**File:** `src/main/ipc/supplier-research.ts:64`

The IPC handler checks `if (columnPriorities.length > 0)` before calling `categorizeTailSpend`. When empty, tail spend phase is skipped entirely and user sees green "Complete" bar — no indication that half the work didn't happen.

**Fix:** Added warning to completed event's `currentStep` when tail spend is skipped. SuppliersPage renders warnings in amber instead of green.
**Status:** Fixed.

---

## Silent Filtering Findings (2026-04-02)

A separate class of issue: operations that silently filter/skip items based on preconditions without communicating what was excluded. User sees "Complete" but the operation only processed a subset.

### B1. Classification — suppliers without l1_l2_paths silently marked as error (HIGH)

**Files:** `src/main/services/classification.ts:264-269, 300-307`

During classification, suppliers without category paths (`l1_l2_paths`) are silently marked `classification_status = 'error'` via `markSupplierError()`. Progress reaches 100% and emits `status: 'completed'`. User has no idea some suppliers were skipped or why their transactions ended up in error state.

**Fix:** Track `skippedNoPaths` count separately from `errorCount`. Include in completed event: `'Completed — N suppliers skipped (missing category paths, run categorization first)'`.
**Status:** Fixed.

### B2. Cat A suppliers — rule creation fails silently (HIGH)

**Files:** `src/main/services/supplier-research.ts:172-177, 461-504`

When a Category A supplier's mapped taxonomy paths all fail to resolve against the project taxonomy, no override rule is created — but the supplier is still marked `categoryASupplier: true`. User sees the supplier as "handled" when it actually has no rules.

**Fix:** `resolveCatASupplier` returns boolean indicating success. Don't mark `categoryASupplier: true` if no rule was created. Track unresolved Cat A count in research progress.
**Status:** Fixed.

### B3. Tail spend suppliers excluded from research without feedback (MEDIUM)

**File:** `src/main/services/supplier-research.ts:115-120`

`researchAll` filters out tail spend suppliers before counting candidates. If user selects 5 suppliers (3 tail spend), progress shows "Researching 2 suppliers" with no mention of the 3 excluded ones.

**Fix:** Count excluded tail spend suppliers and include in initial progress step.
**Status:** Fixed.

### B4. Suppliers without research data excluded from categorization (MEDIUM)

**File:** `src/main/services/supplier-research.ts:218-223`

`categorizeWithSupplierInfo` requires `supplierInfo !== null`. Unresearched suppliers are silently filtered. Method returns void with no indication of how many were skipped.

**Fix:** Return `{ categorized, skippedNoInfo }` counts. IPC handler includes skip count in completed message.
**Status:** Fixed.

### B5. Invalid LLM category paths silently dropped (MEDIUM)

**Files:** `src/main/services/supplier-research.ts:253-267, 412-419`

When LLM returns taxonomy paths that don't match the project taxonomy, `validateCategoryPath` rejects them with a `console.warn`. Supplier ends up with no category and no feedback about why.

**Fix:** Track `invalidPaths` count in both categorization methods. Include in completed message if nonzero.
**Status:** Fixed.
