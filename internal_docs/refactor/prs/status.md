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
- `tableLocalFilters` in `ReviewFilterContext` was set to `Record<string, Record<string, string[]>>` to match how the code *actually used* it, rather than the correct shared type `Record<string, FilterCondition[]>`. **This was a mistake.** The correct type per the architecture is `Record<string, FilterCondition[]>` (keyed by tableId, each table gets a `FilterCondition[]`). The old `Record<string, string[]>` shape is an ad-hoc structure. PR 2 will fix this — `tableLocalFilters` in the context will be updated to `Record<string, FilterCondition[]>` and all consumers updated.
- `PivotSettings` was dead code (not in `WorkflowState`). Deleted.

## PR 2: MultiTableSystem — SPEC REWRITTEN (v2), NOT STARTED

### Spec rewrite reason
Original spec focused on type contract only. Expanded after user audit to also
delete all client-side filtering and grouping (see `architectural-debt-audit.md`).
`tableLocalFilters` is eliminated entirely — not migrated to `FilterCondition[]`.

### Agent Guidance (learned during spec writing)

#### 0. DuckDB IPC is fast — no client-side processing needed
In Electron, `transactions:query` with `FilterCondition[]` is < 5ms even on 4M rows.
Any client-side `.filter()` / `.reduce()` on transaction arrays is wrong. The
`transactions` prop in MultiTableSystem is only the first 100 rows from
`useLightTransactions` — client-side filtering of those 100 rows is meaningless.
Delete all client-side filter evaluation. Trust what the server returns.

#### 1. `tableLocalFilters` is deleted, not migrated
Original spec planned to migrate `tableLocalFilters` from `Record<string, Record<string, string[]>>`
to `Record<string, FilterCondition[]>`. After user review, the concept is wrong:
per-table local filters bypass the server. Delete the entire concept. Drag-drop
calls `onAddFilter()` → `activeFilters` → IPC → DuckDB. No client-side state.

#### 2. `as any` is always a symptom, never a fix
Every `as any` cast at a component boundary means the types at that boundary are wrong.
Trace it back to the source and fix the type, don't cast around it. The `as any` casts in
Dashboard all traced to a single root cause: `MultiTableSystem` props were declared as
`React.Dispatch<SetStateAction<X>>`, which doesn't align with context-based setters.

#### 2. Never put `React.Dispatch<SetStateAction<X>>` in a component's prop interface
A component should not encode where its state comes from. Props should be plain typed callbacks:
```typescript
// WRONG — ties component to useState
setSelectedRows: React.Dispatch<React.SetStateAction<string[]>>

// RIGHT — works with useState, context, Zustand, anything
setSelectedRows: (updater: ((prev: string[]) => string[]) | string[]) => void
```
If a prop is declared as `Dispatch<SetStateAction>`, callers using context or any other state
source must cast with `as any`. Fix the prop, not the call site.

#### 3. Use shared types universally — never create local duplicates
`MultiTableSystem.tsx` defined `TableDef` and `FilterStateMap` locally that duplicate
`ReviewTableConfig` (from `ReviewFilterContext`) and `Record<string, string[]>`.
The rule: if a type exists in `src/shared/types/` or in a sibling context file, import it.
Local interface definitions in a component file are a red flag — they usually mean drift.

#### 4. `FilterCondition` is the universal filter type for this codebase
Per both architecture docs: `FilterCondition` from `src/shared/types/transactions.ts` is used
by OverrideRules, `transactions:query`, and any per-table local filters. Any `Record<string, string[]>`
or `Record<string, Record<string, string[]>>` that represents "conditions to filter by" should be
`FilterCondition[]` instead. Don't invent a new shape.

#### 5. Check `humanReviewed` boolean, not `classification_status === 'human_reviewed'`
`DashboardTransactionRow.humanReviewed` is a `boolean`. There is no `'human_reviewed'` value
in the `ClassificationStatus` union — the statuses are `unclassified`, `classified_by_rule`,
`classified_by_ai`, `classification_failed`. Any code checking `classification_status === 'human_reviewed'`
is a silent bug.

#### 6. How `tableLocalFilters` works with `FilterCondition[]`
`tableLocalFilters: Record<string, FilterCondition[]>` where key = tableId, value = conditions
for that table. To remove a filter value: find the condition by `condition.field === filterKey`,
filter the value out of `condition.value` (which is `string[]` when `operator === 'in_list'`),
remove the condition entirely if no values remain, remove the tableId entry if no conditions remain.
See `2-multitable-decomposition.md` for the exact implementation pattern.
## PR 1b: Store Persist Fix — COMPLETED
**Date:** 2026-03-05

### Problem Found
Code review of PR 1 commit revealed two bugs:
1. `partialize` used `{ filePath } as ProjectMetadata` — a type lie. On reload,
   all fields except `filePath` were `undefined` while TypeScript believed them fully typed.
2. `AppShell` initialized `reopening = false` then set it to `true` inside `useEffect`.
   This caused one render frame of wrong UI state (wrong `hasUploadedData`, `hasTaxonomy`)
   before the spinner appeared.

### Changes Made
- Added `projectFilePath: string | null` as a dedicated persisted field in `WorkflowState`
- `partialize` now persists `{ projectFilePath, lastRoute }` — no cast, correct types
- Bumped persist version to 4
- `AppShell` reads `projectFilePath` instead of `projectMetadata?.filePath`
- `AppShell` initializes `reopening` synchronously via `useState(() => !!getState().projectFilePath)`
  so the very first render shows the spinner if a project was persisted

### Files Modified
- `src/renderer/stores/workflowStore.ts`
- `src/renderer/components/AppShell.tsx`

---

## PR 2: MultiTableSystem — Delete Client-Side Processing + Fix Type Contract — COMPLETED
**Date:** 2026-03-05

### Changes Made

**Part 1: Deleted client-side filtering (D1, D2, D11)**
- Deleted `evaluateFilterConditions` function and associated helpers (`matchWithOperator`, `matchesActiveFilter`, `matchesFilterStateEntry`)
- Deleted `baseFilteredTransactions` useMemo (~94 lines of client-side filter evaluation on 100-row page)
- Deleted `filteredTransactions` useMemo (client-side L1-L4 taxonomy filter pass)
- Deleted `taxonomyTransactions` (was just `= transactions`, a no-op alias)
- All FilterTable instances now receive `data={transactions}` — the already-server-filtered data
- Deleted `fsKeyToBackendKey` useMemo (was only used in `baseFilteredTransactions`)

**Part 2: Deleted client-side grouping (D4, D5)**
- Deleted non-taxonomy client-side `data.reduce()` grouping fallback in FilterTable `tableData` useMemo — replaced with `return []` (empty table when server data not yet available)
- Deleted `getCurrentTableData` keyboard nav fallback (`sourceTransactions.reduce()`) — now returns `[]` if `renderedTableDataRef` not yet populated

**Part 3: Fixed taxonomy tree (D7)**
- FilterTable `tableData` useMemo for taxonomy now uses `groupedRows` (server-side grouped rows) to build `spendByPath`, instead of iterating `data` (100 rows)
- Updated Dashboard `groupedColumns` to include `classification_path` so `groupedData.get('classification_path')` is populated
- Updated FilterTable `groupedRows` prop in JSX: `groupedRows={groupedData?.get(table.column)?.rows || null}` for ALL tables (including taxonomy)

**Part 4: Deleted `filterOptions` useMemo (D6)**
- Deleted `filterOptions` useMemo that scanned 100 transactions — confirmed it was never passed to any component (unused dead code)

**Part 5: Fixed type contract**
- Deleted `TableDef` local interface — now uses `ReviewTableConfig` from `ReviewFilterContext`
- Deleted `FilterStateMap` local interface — now uses `Record<string, string[]>`
- Rewrote `MultiTableSystemProps` with all plain callbacks (no `Dispatch<SetStateAction>`)
- Fixed `transactionsByValue` Map type: `Map<string, DashboardTransactionRow[]>` (was `any[]`)

**Part 6: Dashboard call site cleanup**
- Removed all `as any` casts from Dashboard's `<MultiTableSystem>` call site
- Removed `allTransactions`, `tableLocalFilters`, `setTableLocalFilters`, `onRemoveLocalFilter` props
- Updated `keyboardFocus` state to `useState<'tree' | 'tables'>('tree')` for proper typing

**tableLocalFilters elimination (D3)**
- Deleted from `ReviewFilterContext.tsx`: `tableLocalFilters` field
- Deleted from `Dashboard.tsx`: `tableLocalFilters` state, `setTableLocalFilters`, `handleRemoveLocalFilter`
- Deleted from `ActiveFilters.tsx`: `tableLocalFilters` prop, `onRemoveLocalFilter` prop, local filter section in `combined` useMemo; also removed unused `tables` prop
- Deleted from `CurrentFiltersPanel.tsx`: `tableLocalFilters` prop, `onRemoveLocalFilter` prop, local filters section in `groupedFilters` useMemo, `allTransactions` prop
- Deleted from `Tabs.tsx`: `tableLocalFilters` prop, `onRemoveLocalFilter` prop

### Deviations from Plan
- **`ClassificationTree.tsx` type update**: The spec didn't mention ClassificationTree but `keyboardFocus: string` in its props caused a type error when Dashboard's `keyboardFocus` became `'tree' | 'tables'`. Updated `ClassificationTree.tsx` props to use `'tree' | 'tables'` (the actual domain values). This is a 2-line change and a safe narrow type improvement.
- **`filterState` default in MultiTableSystem**: Changed from a large object with all keys to `{}` since the type is now `Record<string, string[]>` (required prop, not optional). Internal code uses optional chaining/`|| []` where needed.
- **Taxonomy groupedRows via `groupedData.get(table.column)`**: The spec described a dedicated taxonomy groupedRows mechanism, but the cleanest implementation is: pass `groupedData?.get(table.column)?.rows || null` for ALL tables (including taxonomy). This also required updating `groupedColumns` in Dashboard to include `classification_path`. `serverSideMode` in FilterTable remains `!!groupedRows && !effectiveHierarchical` — so taxonomy table still falls through to the tree-building code (because `effectiveHierarchical = true` for taxonomy), but uses `groupedRows` for amounts instead of iterating `data`.
- **clearSelection unused callback**: There's an existing `clearSelection` useCallback that is never called (pre-existing unused code). Left as-is — not introduced by this PR.
- **`tsc --noEmit` passes**: Confirmed with `npx tsc -p tsconfig.renderer.json --noEmit` — zero errors.

### Files Modified
- `src/renderer/components/review/MultiTableSystem.tsx` — major cleanup
- `src/renderer/components/review/Dashboard.tsx` — remove tableLocalFilters, as any casts, groupedColumns fix
- `src/renderer/components/review/ReviewFilterContext.tsx` — remove tableLocalFilters
- `src/renderer/components/review/ActiveFilters.tsx` — remove tableLocalFilters, onRemoveLocalFilter, tables
- `src/renderer/components/review/CurrentFiltersPanel.tsx` — remove tableLocalFilters, onRemoveLocalFilter, allTransactions; import ReviewTableConfig
- `src/renderer/components/review/Tabs.tsx` — remove tableLocalFilters, onRemoveLocalFilter
- `src/renderer/components/review/ClassificationTree.tsx` — narrow keyboardFocus prop types

---

## PR 3: Dashboard Decomposition — SPEC REWRITTEN (v2), NOT STARTED

### Spec rewrite reason
Original spec only addressed tab extraction. Expanded to also fix MetricsTab and
SpendVisualizations which do all their aggregation client-side on the raw
transactions prop (which is 100 rows — meaningless). Both must call IPC directly.
`useHierarchicalPivotData.ts` is dead code after this — delete it.

### Spec updates applied
- `MetricsTab` stops receiving `transactions`/`filteredTransactions` — receives aggregated typed data from MetricsTabContainer
- `SpendVisualizations` stops receiving `transactions` — calls `pivotAggregation` IPC or receives pre-aggregated data
- `MetricsTabContainer` calls IPC directly using `useReviewFilterContext()` for current filters
- Tab components call `useReviewFilterContext()` directly — no filter props drilled from Dashboard
- No `Dispatch<SetStateAction>` in new tab component props
- `DashboardTransactionRow` everywhere — not `any[]`
- Added Type Checklist section

## PR 4: Classification Tree Split — SPEC UPDATED, NOT STARTED

### Spec updates applied (from PR 2 learnings)
- Added typed `DragItem` discriminated union (`src/renderer/types/dragItems.ts`) — no `any` for drag events
- Hook interfaces use `(updater: ((prev: X) => X) | X) => void` — no `Dispatch<SetStateAction>`
- `DashboardTransactionRow` for any transaction data passed to the tree
- Explicitly documents: `humanReviewed` is `boolean` — `classification_status === 'human_reviewed'` does not exist
- Added Type Checklist section

## PR 5: Type Safety Fixes — SPEC UPDATED, NOT STARTED

### Spec updates applied (from PR 2 learnings)
- ~~Fix `tableLocalFilters` in `ReviewFilterContext`~~ — DONE in PR 2: `tableLocalFilters` was deleted entirely (not migrated)
- Added: full audit of `React.Dispatch<SetStateAction<X>>` across all renderer components not touched by PRs 1-4
- Added: audit for `Record<string, Record<string, string[]>>` — always wrong, should be `FilterCondition[]`
- Added: search for `classification_status === 'human_reviewed'` as a bug sweep
- Added Type Checklist section

## PR 6: Test Infrastructure — SPEC UPDATED, NOT STARTED

### Spec updates applied (from PR 2 learnings)
- Mock factory return types must explicitly match service interfaces — no `any` in stubs
- `vi.fn()` calls need explicit generic type parameters for typed return values
- Test data uses real shared types (`FilterCondition[]`, `DashboardTransactionRow`) — no `as any`
- Added Type Checklist section

## PR 7: LLM Key UI — SPEC UPDATED, NOT STARTED

### Spec updates applied (from PR 2 learnings)
- IPC response type (`LLMConfigResponse`) defined in `ipc-contract.ts` first, before any implementation
- `SettingsFormState` typed interface — no `any` in form state
- Form event handlers typed as `React.ChangeEvent<HTMLInputElement>` — not `any`
- `ILLMConfigService` interface defined in `services.ts` before the implementation
- Added Type Checklist section
