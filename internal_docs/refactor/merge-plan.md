# Merge Plan: refactor/tanuj + v2-improvements → target state

**Goal:** Merge `refactor/tanuj` and `v2-improvements` into `v2-merge`, arriving at the
target architecture defined in `front-end-architecture.html` and `architecture.html`.

**Base branch:** `refactor/tanuj` — use this as the foundation. It has the correct DI
container, service interfaces, and architectural skeleton. `v2-improvements` has valuable
feature additions built on the old singleton architecture; those features need to be ported
into the new structure, not merged as-is.

---

## Current State Assessment

### What `refactor/tanuj` has right
- DI container (`container.ts`) + `EventBus` — correct
- Service interfaces in `shared/types/services.ts` — correct
- `FilterCondition` / `FilterOperator` in `shared/types/transactions.ts` — **this is the
  universal filter type** the whole stack should use
- `conditions?: FilterCondition[]` in `TransactionFilter` — correct approach
- `ingest:*` IPC namespace replacing old `upload:*` — correct
- `PivotPage.tsx` deleted (pivot is a sub-view of ReviewPage) — correct
- `scripts/full-run.ts` replacing `run-test-pipeline.ts` — correct

### What `v2-improvements` has that's worth keeping
- Four new server-side query methods: `queryGrouped`, `distinctValues`, `getIdsByValue`,
  `queryPivotAggregation` — useful, but built on the old singleton service; need porting
- New shared types: `GroupedRow`, `GroupedTransactionsResult`, `PivotAggregationRow`,
  `PivotAggregationResult` — keep these, remove `ColumnFilter` (duplicate of `FilterCondition`)
- DuckDB native CSV reader in `importCSV` (no Node.js memory limit) — port into `ingest.ts`
- `workflowStore` additions: `ReviewTableConfig`, `tables`, `selectedRows` — useful
  UI state, but `tableLocalFilters: Record<string, any>` and `cachedSuppliers: any[]`
  need proper types
- UI improvements: `fmtAbbrev` spend formatting, `% of Spend` column in SupplierTable,
  Sidebar `completed` fix, DataReviewPage nav button removal — all keep

### What neither branch has (gaps vs target)
1. `IPCInvokeMap` in `shared/types/ipc-contract.ts` — the compile-time IPC safety layer
2. `ipc.ts` facade still uses `invoke<T>(channel: string, ...)` — loose channel typing
3. `DashboardTransactionRow` + `transactionTransform.ts` — the one view model transform
4. `useReclassification`, `useUndoRedo`, `useReviewFilters` hooks
5. `FilterCondition` not wired end-to-end: frontend filter UI should construct
   `FilterCondition[]` and send them directly via `TransactionFilter.conditions` — no
   client-side re-filtering of data already fetched

### Type conflict to resolve
`v2-improvements` introduces `ColumnFilter` (`column`, `operator`, `values: string[]`)
which is a parallel type to `FilterCondition` (`field`, `operator`, `value`, `connector`)
from `refactor/tanuj`. These must be unified. **Use `FilterCondition` everywhere.** The
`ColumnFilter.values: string[]` multi-value pattern maps to `operator: 'in_list'` with
`value: string[]` in `FilterCondition`.

---

## Merge Strategy (Phased)

### Phase 0 — Git merge setup (resolve the 13 conflicts)

#### Modify/delete conflicts — keep refactor/tanuj's deletion in all five cases:

| File | Decision | Reason |
|------|----------|--------|
| `scripts/run-test-pipeline.ts` | **Delete** | Replaced by `scripts/full-run.ts` |
| `src/main/ipc/upload.ts` | **Delete** | IPC namespace moved to `ingest:*`; port `loadFullCSV` into `ipc/ingest.ts` as `ingest:importCSV` |
| `src/main/services/upload.ts` | **Delete** | Functionality moved into `services/ingest.ts`; port DuckDB native reader there |
| `src/main/services/canonicalization.ts` | **Delete** | Merged into new ingest pipeline |
| `src/renderer/pages/PivotPage.tsx` | **Delete** | Pivot is now a sub-view inside ReviewPage per architecture |

#### Content conflicts — resolution per file:

**`src/shared/types/transactions.ts`**
Take `refactor/tanuj` as base. Add from `v2-improvements`:
- `GroupedRow`, `GroupedTransactionsResult`, `PivotAggregationRow`, `PivotAggregationResult`
- `columnFilters` → **do not port**: `refactor/tanuj` already has `conditions: FilterCondition[]` which supersedes it
- `filterCombinator` / `filterConnectors` → the `connector` field on `FilterCondition` already handles per-pair logic; no need for separate fields

**`src/main/services/transactions.ts`**
Take `refactor/tanuj` as base (DI pattern, db passed via constructor). Add from `v2-improvements`:
- `queryGroupedByColumn(column, filters?)` → `GroupedTransactionsResult`
- `queryDistinctValues(column, limit?)` → `string[]`
- `getTransactionIdsByColumnValue(column, value, filters?)` → `string[]`
- `queryPivotAggregation(dimensions[], valueDimension, filters?)` → `PivotAggregationResult`
- The `buildFilterClauses` helper with L1/L2/L3/L4 virtual column support — port this, but
  using `FilterCondition[]` not `ColumnFilter[]`

**`src/main/ipc/transactions.ts`**
Take `refactor/tanuj` as base (DI, `transactions: TransactionStore`). Add new handlers:
```
transactions:queryGrouped
transactions:distinctValues
transactions:getIdsByValue
transactions:pivotAggregation
```

**`src/renderer/lib/ipc.ts`**
Take `refactor/tanuj` as base. Add to `transactions` namespace:
```ts
queryGrouped: (column: string, filters?: TransactionFilter) =>
  invoke<GroupedTransactionsResult>('transactions:queryGrouped', column, filters),
distinctValues: (column: string, limit?: number) =>
  invoke<string[]>('transactions:distinctValues', column, limit),
getIdsByValue: (column: string, value: string, filters?: TransactionFilter) =>
  invoke<string[]>('transactions:getIdsByValue', column, value, filters),
pivotAggregation: (dimensions: string[], valueDimension: string, filters?: TransactionFilter) =>
  invoke<PivotAggregationResult>('transactions:pivotAggregation', dimensions, valueDimension, filters),
```
Do NOT add `upload:loadFullCSV` — the equivalent is already `ingest:importCSV`.

**`src/renderer/stores/workflowStore.ts`**
Take `refactor/tanuj` as base. Add from `v2-improvements`:
- `ReviewTableConfig` interface (type the `column` and `isHierarchical` fields properly)
- `tables: ReviewTableConfig[]` in `ReviewFilterState` with default values
- `selectedRows: string[]` in `ReviewFilterState`
- `tableLocalFilters: Record<string, FilterCondition[]>` — **replace `any` with typed**
- `cachedSuppliers: ProjectSupplierView[] | null` — **replace `any[]` with typed**
- `setCachedSuppliers` action

**`src/renderer/components/Sidebar.tsx`**
Take `refactor/tanuj`, apply v2's one-liner fix:
```ts
completed: ws.hasReviewedData || ws.hasClassifiedData,
```

**`src/renderer/pages/DataReviewPage.tsx`**
Take `v2-improvements` version (cleaner — no inline nav button; navigation belongs in Sidebar).

**`src/renderer/components/data-review/SpendDistribution.tsx`**
Take `v2-improvements` (uses `fmtAbbrev`).

**`src/renderer/components/data-review/SupplierTable.tsx`**
Take `v2-improvements` (removed `categoryA` toggle, added `% of Spend`, uses `fmtAbbrev`,
simplified — component no longer self-fetches, receives props only — this is correct
per target architecture: "shared DTOs are the view model").

---

### Phase 1 — Add `IPCInvokeMap` (Tier 2 from front-end-architecture.html)

Create `src/shared/types/ipc-contract.ts` with the full typed map from the architecture doc.
This covers all channels in `refactor/tanuj`'s `ipc.ts` plus the four new transaction channels.

```ts
// src/shared/types/ipc-contract.ts
export interface IPCInvokeMap {
  // Project
  'project:new':               { args: [name: string, filePath?: string]; result: { filePath: string; name: string } | null };
  'project:open':              { args: [filePath?: string]; result: { filePath: string; name: string } | null };
  'project:close':             { args: []; result: void };
  'project:getSetting':        { args: [key: string]; result: unknown };
  'project:setSetting':        { args: [key: string, value: unknown]; result: void };
  'project:deleteSetting':     { args: [key: string]; result: void };
  'project:getAllSettings':    { args: []; result: Record<string, unknown> };
  'project:getMetadata':       { args: []; result: ProjectMetadata };
  'project:updateMetadata':    { args: [updates: ProjectMetadataUpdate]; result: void };
  // Ingest
  'ingest:selectFile':         { args: []; result: string | null };
  'ingest:parseCSV':           { args: [filePath: string]; result: CSVPreview };
  'ingest:suggestMappings':    { args: [columns: string[], sampleRows: Record<string, string>[]]; result: ColumnMappingResult };
  'ingest:importCSV':          { args: [filePath: string, mapping?: ColumnMapping]; result: { rowsInserted: number; uploadId: string } };
  'ingest:getUpload':          { args: []; result: UploadRecord | null };
  // Transactions
  'transactions:query':        { args: [filters?: TransactionFilter]; result: PaginatedTransactions };
  'transactions:stats':        { args: []; result: TransactionStats };
  'transactions:getColumns':   { args: []; result: string[] };
  'transactions:update':       { args: [update: TransactionUpdate]; result: void };
  'transactions:queryGrouped': { args: [column: string, filters?: TransactionFilter]; result: GroupedTransactionsResult };
  'transactions:distinctValues': { args: [column: string, limit?: number]; result: string[] };
  'transactions:getIdsByValue': { args: [column: string, value: string, filters?: TransactionFilter]; result: string[] };
  'transactions:pivotAggregation': { args: [dimensions: string[], valueDimension: string, filters?: TransactionFilter]; result: PivotAggregationResult };
  // Classification
  'classification:start':      { args: []; result: void };
  'classification:cancel':     { args: []; result: void };
  // Taxonomy
  'taxonomy:getNodes':         { args: []; result: TaxonomyNode[] };
  'taxonomy:addNode':          { args: [fullPath: string, description?: string]; result: TaxonomyNode };
  'taxonomy:updateNode':       { args: [nodeId: string, updates: Partial<TaxonomyNode>]; result: void };
  'taxonomy:deleteNode':       { args: [nodeId: string]; result: void };
  'taxonomy:importFromFile':   { args: [filePath: string]; result: { nodeCount: number } };
  // Suppliers
  'suppliers:list':            { args: []; result: ProjectSupplierView[] };
  'suppliers:update':          { args: [supplierId: string, input: SupplierUpdateInput]; result: void };
  'suppliers:confirm':         { args: [id: string, status: SupplierConfirmationStatus]; result: void };
  'suppliers:researchAll':     { args: []; result: void };
  'suppliers:researchSingle':  { args: [supplierName: string]; result: SupplierInfo };
  // Rules
  'rules:list':                { args: []; result: OverrideRule[] };
  'rules:create':              { args: [input: OverrideRuleCreate]; result: { id: string } };
  'rules:update':              { args: [ruleId: string, updates: OverrideRuleUpdate]; result: void };
  'rules:delete':              { args: [ruleId: string]; result: void };
  // Changelog
  'changelog:list':            { args: []; result: ChangeLog[] };
  'changelog:revert':          { args: [changeId: string]; result: void };
  // Export
  'export:csv':                { args: []; result: { rowsExported: number } | null };
}

export interface IPCEventMap {
  'classification:progress':       ClassificationProgress;
  'suppliers:research:progress':   ResearchProgress;
}

export type IPCChannel = keyof IPCInvokeMap;
export type IPCArgs<K extends IPCChannel> = IPCInvokeMap[K]['args'];
export type IPCResult<K extends IPCChannel> = IPCInvokeMap[K]['result'];
```

Update `src/renderer/lib/ipc.ts` to use the map:
```ts
async function invoke<K extends IPCChannel>(channel: K, ...args: IPCArgs<K>): Promise<IPCResult<K>>
```
Now every call site is compile-checked. Wrong channel name, wrong arg shape, or wrong
return type assumption → TypeScript error at build time.

**Also update `src/preload.ts`** to expose the bridge:
```ts
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: unknown[]) => void) => { ... },
})
```
The preload doesn't need the IPCInvokeMap — the type safety is on the renderer side.

---

### Phase 2 — `DashboardTransactionRow` + `transactionTransform.ts`

Create `src/renderer/utils/transactionTransform.ts` as specified in the architecture doc.
This is the **only** view model transform in the app.

Key points:
- `Transaction` from IPC has `canonicalFields: Record<string, unknown>` — the adapter
  extracts typed fields from this
- Derives `l1`, `l2`, `l3` from `classificationPath` (pipe-split)
- `humanReviewed` needs to be added to the shared `Transaction` type (it exists in the DB
  schema and export query but is missing from the shared contract)

```ts
// src/renderer/utils/transactionTransform.ts

export interface DashboardTransactionRow {
  id: string;
  supplierName: string;
  originalSupplierName: string;
  spendAmount: number;
  glDescription: string | null;
  classificationStatus: ClassificationStatus;
  humanReviewed: boolean;
  classificationPath: string | null;
  classificationReasoning: string | null;
  l1: string | null;
  l2: string | null;
  l3: string | null;
  taxonomyNodeId: string | null;
  glCode?: string;
  lineDescription?: string;
  costCenter?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
  [key: string]: unknown;
}

export function toRow(t: Transaction): DashboardTransactionRow { ... }
export function toRows(ts: Transaction[]): DashboardTransactionRow[] { ... }
```

**Impact:** All Review page components (`Dashboard.tsx`, `MultiTableSystem.tsx`,
`ClassificationTree.tsx`, `MetricsTab.tsx`) switch from `Record<string, unknown>` /
`any[]` to `DashboardTransactionRow[]`. This is the single type boundary.

---

### Phase 3 — Review page hooks (Tier 3 from front-end-architecture.html)

Extract the three hooks from `Dashboard.tsx`. Each hook has a clear contract:

**`src/renderer/hooks/useReclassification.ts`**
```ts
function useReclassification(onSuccess: () => void): {
  reclassify: (rowIds: string[], targetNodeId: string) => Promise<void>;
  isReclassifying: boolean;
}
```
Calls `ipc.transactions.update(...)`, logs `UndoEntry`.

**`src/renderer/hooks/useUndoRedo.ts`**
```ts
function useUndoRedo(): {
  push: (entry: UndoEntry) => void;
  undo: () => Promise<void>;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}
```
Calls `ipc.changelog.revert(changeId)` for undo.

**`src/renderer/hooks/useReviewFilters.ts`**
```ts
function useReviewFilters(): {
  filters: ReviewFilterState;
  setFilter: (field: string, values: string[]) => void;
  clearFilters: () => void;
  toFilterConditions: () => FilterCondition[];  // converts store state to IPC-ready conditions
  activeChips: ReviewFilterChip[];
}
```
Key: `toFilterConditions()` converts the UI filter state into `FilterCondition[]` that gets
passed directly into `TransactionFilter.conditions` on the next IPC call. **No client-side
re-filtering.** The backend evaluates the conditions against the DB.

---

### Phase 4 — Wire `FilterCondition` end-to-end (thin UI principle)

The target is: frontend builds `FilterCondition[]` → passes to backend via
`TransactionFilter.conditions` → backend evaluates in SQL. No client-side array filtering
of data after it's already been fetched.

Audit and fix these components:
- `Dashboard.tsx` — any local `.filter()` / `.reduce()` on `rows` that re-implements a
  query should instead re-fetch with updated `conditions`
- `HierarchicalPivotView.tsx` — client-side pivot aggregation (`useHierarchicalPivotData`)
  replaced by `ipc.transactions.pivotAggregation(dimensions, valueDimension, filters)`.
  The hook becomes a thin adapter: calls IPC, returns result. No in-memory aggregation.
  `usePivotTreeState` keeps managing expand/collapse on the already-aggregated result rows.
- `MetricsTab.tsx` — stats should come from `ipc.transactions.stats()` + optionally
  `ipc.transactions.queryGrouped('supplier_name', filters)` for top-N supplier breakdowns
- `ClassificationTree.tsx` — tree click should set a `FilterCondition` on
  `taxonomyNodeId` equals, not filter a local copy of rows

`v2-improvements`'s new IPC channels (`queryGrouped`, `distinctValues`, `pivotAggregation`)
exist precisely to enable this thin-UI pattern. Port them in Phase 0 so they're available.

---

### Phase 5 — Fix remaining P0 bugs (Tier 1 from front-end-architecture.html)

After the merge, address these known gaps:

| Bug | File | Fix |
|-----|------|-----|
| `suppliers:update` sends `(id, newName)` but suppliers page needs full patch | `ipc/suppliers.ts` + `pages/SuppliersPage.tsx` | Define `SupplierUpdateInput` properly, align both sides |
| `OverrideRulesPage` imports `RuleCondition` / `RuleOperator` / `RuleSource` (don't exist) | `pages/OverrideRulesPage.tsx` | Use `FilterCondition` / `FilterOperator`, remove `source` field |
| `MultiTableSystem.tsx` checks `classification_status === 'human_reviewed'` | `components/review/MultiTableSystem.tsx` | Use `humanReviewed` boolean from `DashboardTransactionRow` |
| `changelog:revert` typed as `Promise<string>` in `ipc.ts` | `lib/ipc.ts` | Type as `Promise<void>` (updated in `IPCInvokeMap`) |
| `useTransactions.ts` calls `ipc.transactions.queryPaginated` (doesn't exist) | `hooks/useTransactions.ts` | Use `ipc.transactions.query` with page/pageSize args |

---

## File-by-File Merge Checklist

### Resolve in Phase 0 (git merge conflicts)

- [ ] `src/shared/types/transactions.ts` — take refactor/tanuj base, add grouped/pivot result types
- [ ] `src/main/services/transactions.ts` — take refactor/tanuj DI base, add 4 new query methods
- [ ] `src/main/ipc/transactions.ts` — take refactor/tanuj DI base, add 4 new IPC handlers
- [ ] `src/renderer/lib/ipc.ts` — take refactor/tanuj base, add 4 new transaction methods
- [ ] `src/renderer/stores/workflowStore.ts` — take refactor/tanuj base, add typed ReviewTableConfig/cachedSuppliers
- [ ] `src/renderer/components/Sidebar.tsx` — take refactor/tanuj, apply `|| ws.hasClassifiedData` fix
- [ ] `src/renderer/pages/DataReviewPage.tsx` — take v2-improvements version
- [ ] `src/renderer/components/data-review/SpendDistribution.tsx` — take v2-improvements
- [ ] `src/renderer/components/data-review/SupplierTable.tsx` — take v2-improvements
- [ ] `scripts/run-test-pipeline.ts` — keep deleted
- [ ] `src/main/ipc/upload.ts` — keep deleted
- [ ] `src/main/services/upload.ts` — keep deleted; port DuckDB native reader into `services/ingest.ts`
- [ ] `src/main/services/canonicalization.ts` — keep deleted

### Post-merge additions

- [ ] `src/shared/types/ipc-contract.ts` — create `IPCInvokeMap` + `IPCEventMap`
- [ ] Update `src/renderer/lib/ipc.ts` — wire to `IPCInvokeMap`
- [ ] Add `humanReviewed: boolean` to `Transaction` in `shared/types/transactions.ts` and include it in `TransactionStore.queryTransactionsPaginated` SELECT
- [ ] `src/renderer/utils/transactionTransform.ts` — create `DashboardTransactionRow` + `toRow()`
- [ ] `src/renderer/hooks/useReclassification.ts` — extract from Dashboard.tsx
- [ ] `src/renderer/hooks/useUndoRedo.ts` — extract from Dashboard.tsx
- [ ] `src/renderer/hooks/useReviewFilters.ts` — extract from Dashboard.tsx; expose `toFilterConditions()`
- [ ] Update `src/renderer/components/review/Dashboard.tsx` — use the three hooks; populate `ReviewTableConfig.tables` from `ipc.transactions.getColumns()` on mount
- [ ] Update `src/renderer/components/review/MultiTableSystem.tsx` — use `DashboardTransactionRow`
- [ ] Update `src/renderer/hooks/useHierarchicalPivotData.ts` — replace client-side aggregation with `ipc.transactions.pivotAggregation(dimensions, valueDimension, filters)`; expand/collapse stays in `usePivotTreeState`
- [ ] Port DuckDB native CSV reader from v2's `canonicalization.ts` into `services/ingest.ts`
- [ ] Fix P0 bugs from Phase 5 table
- [ ] Refactor `useTransactions` to paginated (fetch current page only, no chunk accumulation)
- [ ] Replace `filterOptions` useMemo with `ipc.transactions.distinctValues()` calls on mount
- [ ] Delete `src/renderer/utils/filterEvaluation.ts` (client-side filter pass eliminated)
- [ ] Delete feedback system: `ipc.feedback.*` calls, `feedbackSuggestions` state, `SystemFeedbackModal`, `checkCategoryASuppliers` in Dashboard.tsx
- [ ] Remove `reclassificationHistory` Map; reclassification calls IPC then `refetch()`
- [ ] Collapse `type: 'filter'` and `type: 'table'` undo entries — `useUndoRedo` handles reclassify-only
- [ ] Update `ChangelogStore.revertChange` to return the new changelog entry ID (enables redo chain); update `IPCInvokeMap` `changelog:revert` result to `{ id: string }`
- [ ] Remove client-side date derivation from `transactionTransform.ts`; remove `year`/`quarter`/`month` from `DashboardTransactionRow` unless exposed as DB columns
- [ ] Delete `src/renderer/components/review/ClassificationTree.tsx` localStorage logic: remove `backendAvailable` flag, `getLocalStorageKey`, `mergeWithLocalCustomPaths`, `extractPathsFromTransactions`, all 7 `localStorage.*` calls; component calls `ipc.taxonomy.getNodes()` only
- [ ] Remove L4 (`newL4` state + UI) from ClassificationTree — taxonomy is 3 levels
- [ ] Delete `src/renderer/contexts/WorkflowStateContext.tsx`; update `ProtectedRoute`, `Sidebar`, `DataReviewPage` to use `useWorkflowStore` selectors directly; remove provider from `App.tsx`
- [ ] Fix `workflowStore` persist: keep only `lastRoute` + `projectMetadata.filePath`; re-fetch live metadata via `ipc.project.getMetadata()` immediately after project reopen
- [ ] Simplify `ReviewPage.tsx`: remove `localTransactions` / `setLocalTransactions` / `deferredTransactions` / `effectiveTransactions` layers; pass page data directly from `useTransactions`; remove `setTransactions` prop on Dashboard
- [ ] Replace hardcoded `filterState` keys in `defaultReviewFilters` with `FilterCondition[]` (done as part of Phase 3 `useReviewFilters`)
- [ ] Fix silent error suppression in `OverrideRulesPage.tsx` and `VersionHistoryPage.tsx`: replace `.catch(() => [])` with proper error state display

---

## What NOT to port from `v2-improvements`

| Item | Reason |
|------|--------|
| `ColumnFilter` type | Duplicate of `FilterCondition` — use `FilterCondition` throughout |
| `filterCombinator` / `filterConnectors` on `TransactionFilter` | `FilterCondition.connector` handles per-pair logic already |
| `upload:loadFullCSV` + `src/main/ipc/upload.ts` additions | `upload:*` namespace is gone; `ingest:importCSV` is the single upload path |
| `tableLocalFilters: Record<string, any>` | Use `Record<string, FilterCondition[]>` instead |
| `cachedSuppliers: any[]` | Type as `ProjectSupplierView[] | null` |
| `suppliers:update(name, { categoryA })` shape | `categoryA` is not in the backend contract |

---

## Additional Renderer Issues (Not Covered by Current Plan)

Reading the actual `Dashboard.tsx` (1642 lines) and related files reveals problems deeper
than the P0 contract bugs. These all stem from the same root cause: the renderer loaded all
rows into memory first, then did data work in JavaScript. The plan already addresses the
*architecture* for fixing this, but the specific code patterns need calling out explicitly
so nothing gets missed during implementation.

---

### Problem 1 — `useTransactions` loads ALL rows into memory

`useTransactions` fetches every transaction in 5000-row chunks and accumulates them into
a single in-memory array. For a 50k-row dataset that's 10 sequential IPC round-trips and
~50MB of objects held in the renderer heap.

**Root cause:** filtering and pivot aggregation currently run in the renderer (Problems 2
and 4), so all rows must be present.

**Fix:** Once filtering moves server-side (Phase 4), `useTransactions` becomes a paginated
hook — it fetches only the current page for the current `FilterCondition[]` state. No
chunk accumulation. No `loadingMore` state. The `CHUNK_SIZE = 5000` constant goes away.

---

### Problem 2 — `filterOptions` scans all rows to populate filter dropdowns

A 60-line `useMemo` (lines 383–435) iterates every loaded transaction to build distinct
value sets for 13 filter fields (`suppliers`, `L1`–`L4`, `glDescriptions`, `years`,
`quarters`, `months`, `costCenters`, `countries`, `lineDescriptions`). This runs in the
renderer on every render that changes `txnLength`.

**Fix:** Replace with `ipc.transactions.distinctValues(column, limit)` — already in the
new IPC contract from v2-improvements. Call once on mount (and after reclassification).
Results are stable between filter changes since they describe the full dataset, not the
filtered subset.

One call per column needed = ~13 parallel IPC calls on mount. Still faster than scanning
50k rows in JS.

---

### Problem 3 — Client-side filter pass re-implements SQL WHERE in the renderer

`evaluateFilterConditions` (in `filterEvaluation.ts`) + `transactions.filter(row => ...)`
(lines 842–875) evaluates every filter condition against every loaded row in JavaScript.
This is a complete re-implementation of the backend's SQL WHERE clause logic, with
its own AND/OR precedence rules, `matchesFilterStateEntry`, and `matchesActiveFilter`
helpers.

There are also **two parallel filter representations** flowing into this pass:
- `filterState: Record<string, string[]>` — one shape
- `activeFilters: Record<string, string[]>` — a second shape, with a `fsKeyToBackendKey`
  mapping to reconcile them

**Fix:** `useReviewFilters` (Phase 3) collapses both into a single `FilterCondition[]`.
That array is passed directly to `TransactionFilter.conditions` on the IPC call. The
`evaluateFilterConditions` utility, `filterEvaluation.ts`, `matchesFilterStateEntry`,
`matchesActiveFilter`, and `fsKeyToBackendKey` are all deleted. `useDeferredValue` on
the filtered result also goes away.

---

### Problem 4 — Reclassification mutates the in-memory array, creating local truth

`executeReclassification` (lines 965–1050) does two things:
1. Calls `ipc.transactions.update(...)` to write to the DB ✓
2. Immediately mutates the in-memory `transactions` array with the new path
   (`setTransactions(prev => prev.map(...))`) to avoid a round-trip ✗

The in-memory mutation uses `row_index` matching which has three fallback paths
(index, `__index`, supplier+spend_amount fuzzy match) — a sign it's fragile. It also sets
`L5: pathParts[4]` and `override_rule_applied: 'manual_reclassification'` — fields that
don't exist in the DB schema.

Once filtering is server-side (Problem 3 fix), reclassification becomes: call IPC → on
success → call `refetch()`. The current page re-loads from DuckDB with correct data. No
mutation logic needed. `reclassificationHistory` Map also goes away.

---

### Problem 5 — Undo/redo has three entry types; only one should exist

`UndoEntry` currently has three variants:
- `type: 'reclassify'` — calls `ipc.changelog.revert(changelogId)` ✓ correct
- `type: 'filter'` — snapshots and restores all filter state ✗ wrong
- `type: 'table'` — snapshots and restores table config ✗ wrong

Undoing a filter change is not a meaningful user operation — the user can just clear the
filter. Putting filter changes on the undo stack means Ctrl+Z unexpectedly jumps filter
state instead of undoing a classification. The `useUndoRedo` hook in Phase 3 should only
handle `type: 'reclassify'`.

**Redo chain issue:** Redo of a reclassification does
`const newRevertId = await ipc.changelog.revert(entry.changelogId)` and expects a new
changelogId back. But the decision in Resolved Decision 3 sets `changelog:revert` to
return `void`. These need to be reconciled: either revert returns the new changelogId (a
`ChangeLog` row is written for the revert), or redo is not supported for reclassification.
Recommendation: **revert writes a changelog entry and returns its ID**, enabling full
redo support. Update `ChangelogStore.revertChange` and `IPCInvokeMap` accordingly.

---

### Problem 6 — Dead code calling non-existent IPC channels

`refreshFeedbackSuggestions` calls `ipc.feedback.list()` — this channel does not exist
in `refactor/tanuj` and is not in the architecture spec. The entire feedback suggestion
system (`feedbackSuggestions` state, `showFeedbackModal`, `showFeedbackNotification`,
`newFeedbackCount`, `highlightFeedback`, `SystemFeedbackModal`, `checkCategoryASuppliers`)
is built on top of it. It should be removed entirely. It adds ~200 lines of state
and event handling that will never fire.

---

### Problem 7 — `transactionTransform.ts` derives temporal fields client-side

The existing `transactionToDashboardRow` computes `year`, `quarter`, `month` from
`invoice_date` in the renderer:
```ts
const d = new Date(String(dateValue))
year: String(d.getFullYear()),
quarter: `Q${Math.ceil((d.getMonth() + 1) / 3)}`,
month: String(d.getMonth() + 1),
```
These derived fields then power the "year / quarter / month" filter dropdowns and pivot
dimensions. The problem: `invoice_date` is a dynamic canonical field that may not exist
in every project, and the date parsing is fragile (timezone-naive).

**Fix:** The `DashboardTransactionRow` from Phase 2 should not derive these.
If year/quarter/month are useful pivot dimensions, expose them as proper canonical columns
in the DB (`YEAR(invoice_date) AS year` etc.) via a computed column or a view — not
client-side derivation. For the filter dropdowns, `distinctValues('year')` works once the
column exists server-side.

---

### Problem 8 — `ClassificationTree.tsx` has localStorage as primary taxonomy store

7 separate `localStorage` read/write calls, a `backendAvailable: boolean` flag, and an
`extractPathsFromTransactions` fallback that scans all loaded rows when IPC fails.
Every CRUD operation (add node, rename, delete) writes to both localStorage AND IPC (when
`backendAvailable`). The localStorage copy is treated as the source of truth for rendering.

In an Electron app with a DuckDB database, `ipc.taxonomy.getNodes()` always works. The
entire localStorage layer, the `backendAvailable` flag, `getLocalStorageKey`,
`mergeWithLocalCustomPaths`, and the transaction-scanning fallback are deleted.
ClassificationTree calls `ipc.taxonomy.getNodes()` on mount, shows an error if it fails.
Node CRUD calls the appropriate IPC method and calls `refetch()`. No local writes.

---

### Problem 9 — `ReviewPage.tsx` has three layers of the same data

ReviewPage wraps `useTransactions` output in three successive layers:
```
useTransactions → initialTransactions (useMemo transform)
               → localTransactions    (useState — allows reclassification to mutate)
               → deferredTransactions (useDeferredValue — smooths client-side filtering)
               → effectiveTransactions (raw vs deferred based on hasLoadedOnce)
```
`localTransactions` exists only so `setLocalTransactions` can be passed down to Dashboard
as `setTransactions` — the optimistic mutation escape hatch. `deferredTransactions` exists
only because client-side filtering on all rows is expensive. Both go away when:
- Filtering moves server-side (Problem 3 fix in Phase 4)
- Reclassification calls `refetch()` instead of mutating (Problem 4 fix in Phase 3)

After the fix, ReviewPage becomes:
```
useTransactions(filterConditions) → rows (current page only)
                                  → pass to Dashboard as read-only prop
```
No `setTransactions` prop. No `useDeferredValue`. No `localTransactions`.

---

### Problem 10 — `WorkflowStateContext` is used inconsistently

`DataReviewPage` imports both `useWorkflowStore` and `useWorkflowState()` simultaneously.
All other pages use only `useWorkflowStore` directly. The context is a read-only projection
of 7 Zustand booleans — it adds a layer without adding value.

Decision: **standardise on `useWorkflowStore` everywhere.** Delete
`WorkflowStateContext.tsx` and `WorkflowStateProvider`. Update `ProtectedRoute` and
`Sidebar` to use `useWorkflowStore` directly. Remove the provider from `App.tsx`.

---

### Problem 11 — `workflowStore` persists `projectMetadata` to localStorage

The Zustand `persist` middleware writes `projectMetadata` and `lastRoute` to localStorage
under key `c91-workflow`. `lastRoute` is reasonable (restores last tab on app restart).
`projectMetadata` is used to auto-reopen the last project on startup — but the metadata
(project name, stats) should be re-fetched from DuckDB after reopening, not trusted from
localStorage. The current flow reads stale metadata from storage and displays it before
the DB is open, which can show incorrect stats.

Fix: persist only `lastRoute` and the file path needed to reopen
(`projectMetadata.filePath`). Immediately after reopening, call
`ipc.project.getMetadata()` and overwrite the stored value with live data. All derived
booleans (`hasProject`, `hasTaxonomy`, etc.) recompute from the fresh metadata.

---

### Problem 12 — `defaultReviewFilters` has hardcoded field keys

`ReviewFilterState.filterState` is initialised with hardcoded keys:
`supplier`, `classificationL1`, `classificationL2`, `classificationL3`, `company`,
`costCenter`, `country`, `year`, `quarter`, `month`, `glDescription`, `lineDescription`.

These keys are referenced by string throughout Dashboard, creating a tight coupling between
the store shape and the column names. After Phase 3 (`useReviewFilters`), filter state is
`FilterCondition[]` — no hardcoded field names, no `filterState` / `activeFilters`
duality, no `fsKeyToBackendKey` mapping.

---

### Problem 13 — Silent error suppression on IPC calls in two pages

`OverrideRulesPage.tsx` (lines 48–49) and `VersionHistoryPage.tsx` (line 84) suppress IPC
errors with `.catch(() => [])`:
```ts
ipc.taxonomy.getNodes().catch(() => [] as TaxonomyNode[]),
ipc.transactions.getColumns().catch(() => [] as string[]),
```
When these fail, the user sees empty dropdowns with no explanation. In an Electron app
the only reasons these fail are: no project open (correct to show nothing) or a real DB
error (should surface to the user). Replace with proper error state — if the load fails,
show an error banner, not silently empty UI.

---

### Summary: What the merge plan phases address vs what needs adding

| Problem | Addressed by current plan? | Fix location |
|---------|---------------------------|-------------|
| All rows in memory | Partially (pivot fixed; filtering not) | Extend Phase 4: paginated useTransactions |
| `filterOptions` scanning all rows | No | Phase 4: replace with `distinctValues` IPC calls |
| Client-side filter pass | Yes (Phase 4) | Phase 4 |
| Two filter representations | Yes (Phase 3, useReviewFilters) | Phase 3 |
| Reclassify mutates in-memory array | No | Phase 3 (useReclassification): call refetch() instead |
| Undo/redo tracks filter changes | No | Phase 3 (useUndoRedo): reclassify-only entries |
| Redo chain needs changelogId | No | Fix ChangelogStore.revertChange to return new entry ID |
| Dead feedback IPC code | No (P0 bug list mentions it) | Phase 5: delete feedback system |
| Client-side date derivation | No | Phase 2 (DashboardTransactionRow): remove derived fields |
| ClassificationTree localStorage + fallback | No | Phase 5: delete entirely, IPC-only |
| ClassificationTree L4 taxonomy level | No | Phase 5: remove L4 UI and newL4 state |
| ReviewPage triple data shadow | No | Phase 3+4: eliminated by paginated hook + refetch() |
| WorkflowStateContext redundant layer | No | Phase 5: delete, use useWorkflowStore directly |
| workflowStore persists full metadata to localStorage | No | Phase 5: persist only filePath + lastRoute |
| defaultReviewFilters hardcoded field keys | No | Phase 3: replaced by FilterCondition[] |
| Silent `.catch(() => [])` error suppression | No | Phase 5: add proper error state |

---

## Resolved Decisions

1. **`ingest:importCSV` is the single upload path.** `upload:loadFullCSV` is not ported.
   Keep deleted. All CSV ingestion goes through `ingest:importCSV`.

2. **`ReviewTableConfig.tables` is dynamic.** On Review page mount, call
   `ipc.transactions.getColumns()` to get the available canonical columns, then build the
   table config from that list. Do not hardcode `supplier_name` / `line_description` /
   `gl_description`. The `workflowStore` should initialise `tables: []` and populate after
   the columns call resolves — either in the Review page's `useEffect` or in a
   `useReviewTables` hook. The `ReviewTableConfig` shape stays the same; only the
   initialisation changes.

3. **`humanReviewed` is a first-class field on `Transaction`.** Add to the shared type:
   ```ts
   humanReviewed: boolean;
   ```
   `TransactionStore.queryTransactionsPaginated` must include this field in its SELECT.
   It is not Review-page-only — any page that loads transactions gets it. `DashboardTransactionRow`
   maps it through directly (no transform needed; same name, same type).

4. **Pivot is fully server-side. No caching.** DuckDB on local disk is fast enough
   (sub-100ms) that adding a stale-data invalidation layer costs more than it saves in an
   Electron app. `useHierarchicalPivotData` becomes a thin hook: it calls
   `ipc.transactions.pivotAggregation(dimensions, valueDimension, filters)` and returns
   the result. Expand/collapse state (`usePivotTreeState`) remains client-side — it only
   controls which rows are visible in the rendered tree, not which data is fetched. When
   filters change, the hook re-fires the IPC call; no manual cache invalidation needed.
