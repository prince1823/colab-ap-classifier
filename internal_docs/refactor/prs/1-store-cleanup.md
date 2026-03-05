# PR 1: Store Cleanup — Slim Down workflowStore

## Problem
`workflowStore.ts` (409 lines) holds upload drafts, review filter state, cached suppliers,
pivot settings, table configs, and selected rows. The architecture doc says the store should
hold only workflow booleans, progress, and `lastRoute`. Data and transient UI state should
live in component state or hooks.

Additionally, `partialize` persists the full `projectMetadata` object to localStorage.
The plan says only `filePath` + `lastRoute` should persist — the rest must rehydrate from
`ipc.project.getMetadata()` on reload.

## Changes

### 1. Fix persistence scope
- Change `partialize` to only extract `{ filePath: state.projectMetadata?.filePath, lastRoute: state.lastRoute }`
- On app reload / rehydration, call `refreshMetadata()` to fill in the rest from the DB

### 2. Extract ReviewFilterState
- Move `ReviewFilterState`, `ReviewTableConfig`, filter actions, and `selectedRows` out of the store
- Create `useReviewState()` hook (or extend `useReviewFilters`) that holds this state locally
- Components in `review/` consume the hook instead of `useWorkflowStore`
- Reset on project close via hook cleanup (useEffect)

### 3. Extract UploadDraft
- Move `UploadDraft` and related actions out of the store
- Keep as local state in `UploadPage.tsx` or a `useUploadDraft()` hook
- If cross-tab persistence is needed, use a ref or context scoped to the upload flow

### 4. Extract PivotSettings
- Move `PivotSettings` and `defaultPivotSettings` out of the store
- Keep in the pivot components or a `usePivotSettings()` hook

### 5. Remove cachedSuppliers
- Replace with `useIPC('suppliers:list')` calls at the component level
- No global caching — let the IPC hook manage freshness

## Result
Store should be ~150 lines: workflow booleans, progress state, project metadata (non-persisted),
`lastRoute`, and lifecycle actions (create/load/close/refresh).

## Files touched
- `src/renderer/stores/workflowStore.ts`
- `src/renderer/hooks/useReviewFilters.ts` (or new `useReviewState.ts`)
- `src/renderer/pages/UploadPage.tsx`
- `src/renderer/components/review/Dashboard.tsx`
- `src/renderer/components/review/MultiTableSystem.tsx`
- Any component reading filter/upload/pivot state from the store
