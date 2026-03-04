# PR 3: Frontend Alignment

**Goal:** Fix all renderer issues — IPC channel mismatches, progress type updates, add checkpoint/review UI.

## 3a. IPC Channel Fixes

**Modify:** Find all references to `classification:*` channels in `src/renderer/` and replace with `pipeline:*`:
- `classification:start` → `pipeline:start`
- `classification:cancel` → `pipeline:cancel`
- Add `pipeline:resume` (new — for checkpoint approval)

## 3b. Progress Type Migration

**Modify:** `src/renderer/stores/workflowStore.ts`
- Replace `ClassificationProgress` with `PipelineProgress`
- Replace `progress.phase` → `progress.currentService`
- Replace `progress.total/processed` → `progress.totalSuppliers/processedSuppliers`
- Add handling for `status === 'awaiting_review'`

**Modify:** `src/renderer/components/review/ProgressDisplay.tsx`
- Replace `progress.phase === 'researching'` → `progress.currentService === 'research'`
- Add checkpoint display when `progress.checkpoint` is set
- Add amber state for `awaiting_review`

**Modify:** `src/renderer/components/review/ClassificationBanner.tsx`
- Same progress type fixes

## 3c. Checkpoint/Review UI

**Modify:** `src/renderer/pages/ClassificationPage.tsx` (or equivalent)
- Add `awaiting_review` branch:
  - Show supplier research summary table
  - Show checkpoint number (1/2/3) and percentage
  - "Continue Classification" button → calls `pipeline:resume`
  - "Cancel" button → calls `pipeline:cancel`
- Fix `isClassifying` logic — check for `status === 'running'`

## 3d. Shared Types Import Updates

Update any renderer files importing `ClassificationProgress` to use `PipelineProgress`.

**Modify:** `src/shared/types/ipc.ts` — update channel type union (`pipeline:approve` → `pipeline:resume`)

## Verify
- `npx tsc --noEmit` (renderer)
- Manual test: start pipeline → research progress → 25% checkpoint → review UI → resume → complete
- Verify IPC calls land correctly

## Files

| Action | Path |
|---|---|
| Modify | `src/renderer/stores/workflowStore.ts` |
| Modify | `src/renderer/pages/ClassificationPage.tsx` |
| Modify | `src/renderer/components/review/ProgressDisplay.tsx` |
| Modify | `src/renderer/components/review/ClassificationBanner.tsx` |
| Modify | `src/shared/types/ipc.ts` |
| Modify | Any other renderer files with old channel names or progress types |
