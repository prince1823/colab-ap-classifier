# Silent Failure Audit

Audit of error handling gaps where backend failures do not surface to the user via UI toasts.

**Date:** 2026-04-02
**Branch:** dev (01a53f5)

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

**Fix:** Track whether either phase failed. If so, emit `status: 'failed'` or `status: 'completed'` with an error summary.

### 3. Undo/Redo failures — console.error only

**File:** `src/renderer/hooks/useUndoRedo.ts:47-48, 64-65`

```typescript
} catch (err) {
  console.error('[Undo] Failed to revert:', err)
```

User presses Cmd+Z, revert fails, entry is pushed back on stack, but no feedback that it failed. User may keep pressing Cmd+Z with no visible result.

**Fix:** Accept an `onError` callback in `UseUndoRedoOptions` and call `showError()`.

### 4. QC config save — .catch(console.error)

**File:** `src/renderer/components/qc/QCPanel.tsx:125`

```typescript
ipc.qc.setConfig(newConfig).catch(console.error)
```

User changes QC scope/settings, save fails silently. User proceeds to run QC with stale config.

**Fix:** `showError('Failed to save QC config', err)`.

### 5. QC stop — console.error only

**File:** `src/renderer/components/qc/QCPanel.tsx:169`

```typescript
console.error('Failed to stop QC:', e)
```

User clicks Stop, it fails, no feedback. QC keeps running.

**Fix:** `showError('Failed to stop QC', e)`.

### 6. Classification cancel — console.error only

**File:** `src/renderer/components/classification/ClassificationControls.tsx:67`

```typescript
console.error('Failed to cancel classification:', e)
```

Same pattern as QC stop. User thinks they cancelled but classification continues.

**Fix:** `showError('Failed to cancel classification', e)`.

### 7. ExportCSVPanel — column load and export errors swallowed

**File:** `src/renderer/components/ExportCSVPanel.tsx:27, 103`

```typescript
.catch(() => {})        // column load — user sees empty column list with no explanation
// ...
} catch {               // export — user sees nothing, exporting spinner just stops
```

**Fix:** Column load: `showError('Failed to load columns', err)`. Export: distinguish cancellation (user closed dialog, no error needed) from real failure.

### 8. FileDropZone — file select error swallowed

**File:** `src/renderer/components/upload/FileDropZone.tsx:22`

```typescript
console.error('[FileDropZone] Failed to select file:', e)
```

If file dialog errors (not cancellation), user gets no feedback.

**Fix:** `showError('Failed to select file', e)`.

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

**Fix:** Don't mark as researched if persistence failed. Or mark with a distinct error state.

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

**8 P0 issues** where the user gets zero feedback on failure.
**2 P1 issues** where partial failure is reported as full success.
