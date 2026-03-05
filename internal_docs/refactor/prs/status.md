# PR Implementation Status

## Architecture Conventions (learned across PRs)

### Type locations
- **`src/shared/types/`** — IPC-shared types used by both main process and renderer (DB models, IPC contracts, FilterCondition, TransactionStats, etc.)
- **`src/renderer/types/`** — renderer-only types that the main process never needs (e.g., `pivot.ts` for PivotTreeNode/HierarchicalPivotData, `dragItems.ts` for drag-drop DragItem union)
- Never put renderer-only types in `src/shared/types/`. Never create local interface duplicates inside component files.

### State and callbacks
- **No `React.Dispatch<SetStateAction<X>>` in prop interfaces.** Use plain updater callbacks: `(updater: ((prev: X) => X) | X) => void`. Dispatch ties a component to useState; plain callbacks work with context, Zustand, or anything.
- **No `as any` at component boundaries.** Every cast traces to a wrong type at that boundary — fix the type, don't cast around it.
- **No separate Zustand store as a "safe" alternative to React context.** Filter state belongs in `ReviewFilterContext`, not a second store.

### Data flow
- **DuckDB IPC is fast (< 5ms on 4M rows).** All filtering, grouping, and aggregation goes through `FilterCondition[]` → IPC → DuckDB. Client-side `.filter()` / `.reduce()` on transaction arrays is wrong — the transactions prop is only 100 rows.
- **`FilterCondition` is the universal filter type.** Any `Record<string, string[]>` that represents filter conditions should be `FilterCondition[]`.
- **`humanReviewed` is a boolean.** There is no `'human_reviewed'` ClassificationStatus value. Statuses are: `unclassified`, `classified_by_rule`, `classified_by_ai`, `classification_failed`.
- **Tab components call `useReviewFilterContext()` directly** — no filter props drilled from Dashboard.

---

## PR 0: Fix Classification Regression — COMPLETED
**Date:** 2026-03-05

Fixed 4 bugs: IPC handler swallowing classification errors (now emits `failed` progress event), taxonomy node lookup silently failing (now warns + appends to reasoning), failed transactions missing `classification_failed` status, and stats query incorrectly counting failed rows as classified.

### Deviations
- Preflight validation UI (`classification:preflight`) skipped — emitting the failed event to the renderer already surfaces the error. Full preflight is a separate feature.
- No fuzzy taxonomy path matching — warning + reasoning append only.
- Stats query fix was not in spec but was necessary: changed from `!= 'unclassified'` to `IN ('classified_by_ai', 'classified_by_rule')`.

---

## PR 1: Store Cleanup — COMPLETED
**Date:** 2026-03-05

Moved filter state out of `workflowStore` into `ReviewFilterContext` (React context + useState). Removed `uploadDraft`, `reviewFilters`, `cachedSuppliers`, dead `PivotSettings`. `workflowStore` now persists only `{ projectFilePath, lastRoute }` (version 4). UploadPage uses local useState. SuppliersPage loads fresh on mount.

### Deviations
- `tableLocalFilters` was initially typed as `Record<string, Record<string, string[]>>` — a mistake. Corrected in PR 2 by deleting the concept entirely.

---

## PR 1b: Store Persist Fix — COMPLETED
**Date:** 2026-03-05

Fixed type lie in `partialize` (`{ filePath } as ProjectMetadata`). Added `projectFilePath: string | null` as a dedicated persisted field. Fixed `AppShell` to initialize `reopening` synchronously from `getState()` so the first render is correct (no flicker frame).

---

## PR 2: MultiTableSystem — Delete Client-Side Processing + Fix Type Contract — COMPLETED
**Date:** 2026-03-05

Deleted all client-side filter evaluation (`evaluateFilterConditions` + helpers, `baseFilteredTransactions`, `filteredTransactions`, `taxonomyTransactions`). Deleted client-side grouping fallbacks in FilterTable and keyboard nav. Fixed taxonomy tree to use server-side `groupedRows` for spend amounts. Deleted unused `filterOptions` useMemo. Eliminated `tableLocalFilters` entirely from Context, Dashboard, ActiveFilters, CurrentFiltersPanel, Tabs. Fixed `MultiTableSystemProps` to use plain callbacks and shared types (`ReviewTableConfig`, no `Dispatch<SetStateAction>`). Removed all `as any` casts at Dashboard call site.

### Deviations
- `ClassificationTree.tsx` `keyboardFocus` prop narrowed from `string` to `'tree' | 'tables'` — not in spec but required for type correctness.
- Taxonomy `groupedRows` uses `groupedData.get(table.column)` for all tables (including taxonomy), not a dedicated mechanism. Required adding `classification_path` to `groupedColumns`.
- `clearSelection` useCallback left as pre-existing dead code — not introduced by this PR.

---

## PR 3: Dashboard Decomposition — COMPLETED
**Date:** 2026-03-05

Extracted `TablesTab.tsx` (all filter logic, grouped data, filter panel, MultiTableSystem + ClassificationTree). Created `MetricsTabContainer.tsx` (calls `ipc.transactions.stats` + `pivotAggregation` for l1/supplier/monthly data with active filters; implements drill-to-filter via context). Refactored `MetricsTab` to receive pre-aggregated typed props — no `TransactionRow[]`. Refactored `SpendVisualizations` to call IPC instead of client-side grouping. Slimmed Dashboard from ~975 to ~165 lines (reclassification, undo/redo, toast, modal only). Moved `PivotTreeNode`/`HierarchicalPivotData`/`FlattenedPivotRow`/`Aggregation` types from dead `useHierarchicalPivotData.ts` hook to `src/renderer/types/pivot.ts`; deleted the hook file.

### Deviations
- `supplierGainersDecliners` removed — required per-supplier-per-month pivot data not available without a new IPC endpoint.
- `selectedBenchmark` toggle (overall vs top-supplier) removed — monthly pivot only returns total spend, not per-supplier monthly breakdown.
- `ipc.transactions.stats()` returns global (unfiltered) totals — no filter parameter exists. MetricsTab header shows global stats; chart data is filtered correctly via pivotAggregation.
- `refetchGrouped` registration pattern: TablesTab owns `useGroupedTransactions` and registers its `refetch` into a Dashboard ref via `onRegisterRefetchGrouped` prop, so `executeReclassification` can trigger a refresh without Dashboard owning the grouped data hook.

---

## PR 4: Classification Tree Split — COMPLETED
**Date:** 2026-03-05

Split 1205-line ClassificationTree into focused pieces. Created `src/renderer/types/dragItems.ts` (shared DragItem), `useTreeDragDrop.ts` (useDrop + server ID resolution), `useTreeKeyboard.ts` (keyboard nav + shortcuts). ClassificationTree reduced from 1205 → 684 lines (target was ~400, difference is CRUD modal verbosity). Extended `buildTaxonomyTree` with optional `pathCounts` for bottom-up count aggregation from server data. Added `queryGroupedByClassificationPath` to backend so `classification_path` is a valid groupable column.

### Deviations
- `DragItem` was not actually referenced in MultiTableSystem.tsx (the interface was defined but unused), so no import was added there — just removed the dead local interface.
- ClassificationTree is 684 lines not ~400; the difference is CRUD modals (add/rename/delete) which are JSX-heavy. Architectural concerns are all addressed.
- `queryGroupedByClassificationPath` added to `src/main/services/transactions.ts` to handle the `classification_path` virtual column (JOIN with taxonomy table), matching the pattern of `queryGroupedByClassificationLevel` for L1-L4.
- `localSuccess` toast state removed (was dead code — never wired up in the original).

## PR 5: Type Safety Fixes — SPEC UPDATED, NOT STARTED

Key notes from spec:
- `tableLocalFilters` already deleted in PR 2 — skip that item
- Audit remaining renderer components for `Dispatch<SetStateAction<X>>` and `Record<string, Record<string, string[]>>`
- Sweep for `classification_status === 'human_reviewed'` silent bugs

## PR 6: Test Infrastructure — SPEC UPDATED, NOT STARTED

Key notes from spec:
- Mock factory return types must match service interfaces explicitly — no `any` in stubs
- `vi.fn()` needs explicit generic type parameters
- Test data uses `FilterCondition[]`, `DashboardTransactionRow` — no `as any`

## PR 7: LLM Key UI — SPEC UPDATED, NOT STARTED

Key notes from spec:
- Define `LLMConfigResponse` in `ipc-contract.ts` and `ILLMConfigService` in `services.ts` before implementation
- `SettingsFormState` typed interface, form event handlers typed as `React.ChangeEvent<HTMLInputElement>`
