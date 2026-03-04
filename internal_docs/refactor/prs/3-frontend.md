# PR 3: Frontend Alignment

**Goal:** Fix all renderer issues — IPC channel updates, progress type changes, remove pipeline/colabip references, update supplier page for FK-based model.

## 3a. IPC Channel Fixes

**Modify `src/renderer/lib/ipc.ts`** and all references:

| Old Channel | New Channel | Notes |
|---|---|---|
| `pipeline:start` | removed | No pipeline — use `classification:start` and `suppliers:researchAll` separately |
| `pipeline:cancel` | removed | Use `classification:cancel` and `suppliers:researchCancel` separately |
| `pipeline:approve` / `pipeline:resume` | removed | No checkpoints |
| `pipeline:progress` | removed | Replaced by separate `suppliers:research:progress` and `classification:progress` events |
| `colabip:*` | removed | No ColabipSync |
| `taxonomy:importFromColabip` | `taxonomy:importFromFile` | User picks file |

**Add new channels:**
- `suppliers:researchAll` — fire-and-forget, emits progress via event
- `suppliers:researchSingle` — returns SupplierInfo
- `suppliers:normalize` — trigger batch normalization
- `suppliers:addAlias` — register alias
- `suppliers:rename` — rename canonical supplier

## 3b. Progress Type Migration

**Modify:** `src/renderer/stores/workflowStore.ts`
- Replace old `ClassificationProgress` (with `phase`, `runId`) with separate `ResearchProgress` and `ClassificationProgress` types
- Remove `progress.phase` checks — research and classification are separate
- Add separate event listeners for `suppliers:research:progress` and `classification:progress`
- Update `isClassifying` derived state — check `classificationProgress?.status === 'running'`
- Add `isResearching` derived state — check `researchProgress?.status === 'running'`
- Remove all `awaiting_review`/`awaiting_approval` handling — no checkpoints

**Modify:** `src/renderer/components/review/ProgressDisplay.tsx`
- Show classification progress only (no research phase indicator during classification)
- Remove checkpoint display

**Modify:** `src/renderer/components/review/ClassificationBanner.tsx`
- Same progress type fixes

## 3c. Supplier Page Updates

**Modify:** Supplier page/components to work with FK-based model:
- Supplier list uses `project_supplier_id` not supplier name strings
- Show aliases for each canonical supplier
- "Rename" action updates `project_suppliers.supplier_name` only (no transaction updates)
- "Add Alias" action via `suppliers:addAlias`
- "Normalize All" button triggers `suppliers:normalize`

## 3d. Taxonomy Import UI

**Modify:** Taxonomy import component:
- Remove ColabipSync taxonomy picker
- Replace with file picker → `taxonomy:importFromFile`

## 3e. Column Priority UI

Column priorities are now a project setting, not part of import:
- Add column priority configuration to Data Review or Classification setup page
- Use `project:setSetting('column_priorities', ...)` / `project:getSetting('column_priorities')`
- Remove priority configuration from upload/import flow

## 3f. Shared Types Import Updates

Update any renderer files importing removed types to use new ones:
- `PipelineProgress` → `ResearchProgress` + `ClassificationProgress` (separate)
- `SupplierStore` → `SupplierService`
- Remove Pipeline-related imports

## Verify
- `npx tsc --noEmit` (renderer)
- Manual test: research suppliers → review → classify → review results
- Verify IPC calls land correctly (no channel mismatches)

## Files

| Action | Path |
|---|---|
| Modify | `src/renderer/lib/ipc.ts` |
| Modify | `src/renderer/stores/workflowStore.ts` |
| Modify | `src/renderer/pages/ClassificationPage.tsx` |
| Modify | `src/renderer/components/review/ProgressDisplay.tsx` |
| Modify | `src/renderer/components/review/ClassificationBanner.tsx` |
| Modify | Supplier page components |
| Modify | Taxonomy import component |
| Modify | `src/shared/types/ipc.ts` (channel type union) |
| Modify | Any other renderer files with old channel names or progress types |
