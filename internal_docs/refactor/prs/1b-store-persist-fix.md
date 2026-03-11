# PR 1b: Store Persist Fix — Remove `as ProjectMetadata` Cast

## Problem

PR 1 changed `workflowStore` to persist only `filePath` from `projectMetadata`,
but used an unsafe cast:

```typescript
partialize: (state) => ({
  projectMetadata: state.projectMetadata
    ? ({ filePath: state.projectMetadata.filePath } as ProjectMetadata)
    : null,
  lastRoute: state.lastRoute,
}),
```

This causes two problems:

### 1. Type lie
The persisted object has only `{ filePath }` but TypeScript believes it is a full
`ProjectMetadata`. On app reload from localStorage, `projectMetadata` in the store is
`{ filePath: '...' }` with all other fields (`projectName`, `columnMapping`, `taxonomyName`,
`createdAt`, `id`, etc.) as `undefined`. Any future code that reads those fields
on startup will get `undefined` silently — no type error, silent wrong value.

### 2. First-render flash of wrong UI state
On reload:
1. Store hydrates — `projectMetadata = { filePath }`, `deriveState` runs:
   - `hasProject: true` (metadata is not null) ✓
   - `hasUploadedData: false` — because `metadata.columnMapping` is `undefined` ✗
   - `hasTaxonomy: false` — because `taxonomyNodeCount` defaults to 0 ✗
2. First render fires — `hasUploadedData: false` → UploadPage shows file drop zone
3. `useEffect` in AppShell runs → `setReopening(true)` → re-render with spinner
4. `loadProject` resolves → full metadata → correct state

The flash is one render frame but it's a real behavioral bug on every app reload
when a project was previously open.

---

## Fix

### 1. Add `projectFilePath` as a dedicated persisted field in `WorkflowState`

```typescript
interface WorkflowState {
  // ... existing fields ...

  // Persisted for auto-reopen only. Separate from projectMetadata so the
  // persisted slice never needs a type cast.
  projectFilePath: string | null
}
```

Initialize to `null`. Set it whenever `projectMetadata` is set in `loadProject`,
`createProject`, `reset`, etc. (mirror the same places `projectMetadata` is set).

### 2. Fix `partialize` — no cast, correct types

```typescript
partialize: (state) => ({
  projectFilePath: state.projectFilePath,
  lastRoute: state.lastRoute,
}),
```

`projectMetadata` is NOT in the persisted slice. It starts as `null` on every boot
and is only set once `loadProject` resolves with real data from the DB.

Bump persist version to 4 (breaking change from version 3).

### 3. Fix AppShell — read `projectFilePath`, not `projectMetadata.filePath`

```typescript
// Before
const { projectMetadata, lastRoute } = useWorkflowStore.getState()
if (!projectMetadata?.filePath) return
loadProject(projectMetadata.filePath)

// After
const { projectFilePath, lastRoute } = useWorkflowStore.getState()
if (!projectFilePath) return
loadProject(projectFilePath)
```

### 4. Fix AppShell first-render flash — initialize `reopening` eagerly

```typescript
// Before — setReopening(true) only fires after first render (useEffect)
const [reopening, setReopening] = useState(false)

// After — initialize synchronously so first render already shows spinner
const [reopening, setReopening] = useState(
  () => !!useWorkflowStore.getState().projectFilePath
)
```

This means: if a `projectFilePath` exists in localStorage, the very first render
shows the loading spinner — no flash of wrong UI state.

---

## Files Touched
- `src/renderer/stores/workflowStore.ts` — add `projectFilePath` field, fix `partialize`, set field in all project lifecycle actions, bump version to 4
- `src/renderer/components/AppShell.tsx` — read `projectFilePath`, eager `reopening` init

## Scope
Small, low-risk. Both files are self-contained. No other files need to change.
