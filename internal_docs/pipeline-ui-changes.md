# Pipeline UI Changes

UI work needed to support the current pipeline flow: **research all suppliers → user reviews & approves → classify all**.

---

## 1. Supplier Review & Approval Section (new)

The main new UI surface. After the pipeline finishes researching all suppliers, it emits `status: 'awaiting_approval'` and blocks until the user approves. The user needs a place to review research results, edit anything wrong, and click "Approve" to trigger classification.

### What already exists

`SuppliersPage.tsx` is a standalone page with a full editable table — supplier name, type, industry, products/services, NAICS, confidence, sources, etc. All fields save inline via `ipc.suppliers.update()`. This page works independently of the pipeline.

### What's needed

A **review section** on the ClassificationPage that appears when `progress.status === 'awaiting_approval'`. This is the approval gate — the user must act here before classification starts.

**Contents:**

- **Status banner** — "Research complete. Review suppliers before continuing."
- **Supplier summary table** — embedded version of the supplier data (or a link to the Suppliers tab). Show supplier name, type, industry, confidence, transaction count. Editable inline like SuppliersPage, or simply link to SuppliersPage for edits.
- **"Approve & Classify" button** → calls `ipc.classification.approve()` — resolves the pipeline's approval gate, classification begins
- **"Cancel" button** → calls `ipc.classification.cancel()` — rejects the gate, pipeline stops

**State derivation:**

```typescript
const isAwaitingApproval = localProgress?.status === 'awaiting_approval'
```

**Design options** (for frontend engineer to decide):

| Option | Pros | Cons |
|---|---|---|
| Inline table on ClassificationPage | Everything in one place, no tab switching | Duplicates SuppliersPage code |
| Read-only summary + "Edit in Suppliers tab" link | No duplication, simpler | User has to switch tabs to edit |
| Render SuppliersPage as embedded component | Full editing, no duplication | Needs refactor to make SuppliersPage embeddable |

Recommendation: start with read-only summary + link. The supplier table is complex (14 columns, inline editing, search, filters) — duplicating it isn't worth it for v1.

---

## 2. IPC Breakages

The backend registers `pipeline:*` channels. The renderer's `ipc.ts` was recently updated to call `classification:*` channels. These don't match — every IPC call will fail at runtime until one side is aligned.

### Channel mismatch

| Backend (main process) | Renderer (`ipc.ts`) | Status |
|---|---|---|
| `pipeline:start` | `classification:start` | **Mismatched** |
| `pipeline:approve` | `classification:approve` | **Mismatched** |
| `pipeline:cancel` | `classification:cancel` | **Mismatched** |
| `pipeline:progress` (event) | `classification:progress` (event) | **Mismatched** |

**Resolution:** pick one namespace and align both sides. The renderer was updated to `classification:*` — either update the backend handlers to match, or revert the renderer. The shared type in `ipc.ts` still lists `pipeline:*`.

### Progress type — `total` / `processed` vs `totalSuppliers` / `processedSuppliers`

The `ClassificationProgress` type has both:
- `totalSuppliers` / `processedSuppliers` (always present)
- `total?` / `processed?` (optional, legacy)

Two components read the optional fields:

| File | Line | Reads |
|---|---|---|
| `ProgressDisplay.tsx` | 28, 52 | `progress.processed`, `progress.total` |
| `ClassificationBanner.tsx` | 34 | `progress.processed`, `progress.total` |

If the backend stops setting `total`/`processed`, these show `undefined`. Switch to `totalSuppliers`/`processedSuppliers`.

### `phase` field references

`ClassificationProgress.phase` is `'researching' | 'classifying'`. Three components branch on it:

| File | Line | Code |
|---|---|---|
| `ProgressDisplay.tsx` | 24 | `progress.phase === 'researching'` |
| `ClassificationBanner.tsx` | 22 | `progress.phase === 'researching'` |
| `ClassificationControls.tsx` | 43 | Hardcoded `phase: 'researching'` in manual cancelled state |

These work today but will break if `phase` is ever removed or renamed.

### Status value references

Components check specific status strings that must stay in sync with the backend:

| File | Line | Status values checked |
|---|---|---|
| `workflowStore.ts` | 96-97 | `'pending' \| 'researching' \| 'classifying'` for `isClassifying` |
| `workflowStore.ts` | 265 | Same three for stale event filter |
| `ClassificationPage.tsx` | 39 | `'pending' \| 'researching' \| 'classifying'` for `wasActive` |
| `ClassificationPage.tsx` | 53-57 | Same three for `isRunning` |

The backend currently emits `status: 'running'` (not `'researching'` or `'classifying'`). This means **`isClassifying` is already broken** — the store never sees `'researching'` or `'classifying'` in the status field (those were v1 values). The backend uses `phase` to distinguish research vs classification, and `status: 'running'` for both.

**Fix:** change all `isRunning`/`isClassifying` checks to:

```typescript
const isClassifying = progress !== null &&
  (progress.status === 'pending' || progress.status === 'running')
```

And include `'awaiting_approval'` if you want the UI to still show as "in progress" during the approval gate.

---

## 3. Other Recommended UI Changes

### 3a. ProgressDisplay — `awaiting_approval` state

The progress bar handles `completed`, `failed`, `cancelled` with colored banners. It has no handling for `awaiting_approval`. When research finishes and the pipeline waits for approval:

- The progress dot should turn amber (not pulsing blue — it's paused, not active)
- The label should say "Research complete — review suppliers"
- The progress bar should be at 100% (research is done) with amber color

### 3b. ClassificationBanner — hide or change during approval gate

The global banner in the app shell shows a spinner and "Researching suppliers" / "Classifying transactions". During `awaiting_approval`:

- Either hide the banner (the ClassificationPage's review section handles it)
- Or swap the spinner for a pause icon and show "Waiting for approval — review suppliers"

### 3c. ClassificationControls — hide during approval gate

The start/cancel controls should be hidden or disabled while `status === 'awaiting_approval'`, since the user should interact with the review section's Approve/Cancel buttons instead. Showing two sets of controls is confusing.

### 3d. ClassificationControls — fix hardcoded cancelled state shape

Line 40-48 creates a manual progress object on cancel. It hardcodes `phase: 'researching'` and uses `total`/`processed` instead of `totalSuppliers`/`processedSuppliers`. Update to match the actual type:

```typescript
useWorkflowStore.getState().setClassificationProgress({
  runId,
  status: 'cancelled',
  phase: 'researching',
  totalSuppliers: 0,
  processedSuppliers: 0,
  percentage: 0,
  currentStep: 'Cancelled',
  currentSupplier: null,
})
```

### 3e. ClassificationPage — no `awaiting_approval` handling

`ClassificationPage.tsx` has no branch for `localProgress?.status === 'awaiting_approval'`. When the backend emits this status, the page shows the generic `ProgressDisplay` with no action buttons. The user has no way to approve. This is the most critical gap — without it, the pipeline blocks forever.

---

## Summary

| Change | Type | Priority |
|---|---|---|
| Supplier review & approve section on ClassificationPage | New UI | **Critical** — pipeline blocks without it |
| IPC channel alignment (`pipeline:*` vs `classification:*`) | Bug fix | **Critical** — all calls fail |
| `isClassifying` / `isRunning` status checks | Bug fix | High — already broken |
| `progress.processed/total` → `processedSuppliers/totalSuppliers` | Field fix | High |
| `awaiting_approval` state in ProgressDisplay | New branch | Medium |
| ClassificationBanner during approval gate | Styling | Low |
| ClassificationControls visibility during approval | UX | Low |
| Hardcoded cancelled state shape | Cleanup | Low |
