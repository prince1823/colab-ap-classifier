# Architectural Debt Audit
_All client-side data processing that belongs in DuckDB._

## Principle

This is an Electron app with an embedded DuckDB. IPC calls are in-process.
A `transactions:query` with `FilterCondition[]` round-trips in < 5ms even on
4M rows. Any client-side `.filter()` / `.reduce()` on transaction arrays is:

1. **Wrong** — MultiTableSystem receives only the first 100 rows from `useLightTransactions`
   (see `ReviewPage.tsx:17`). Filtering those 100 rows produces meaningless results.
2. **Redundant** — the server already applies filters before returning data.
3. **A maintenance hazard** — the custom `evaluateFilterConditions` must be kept
   in sync with DuckDB's `buildWhereClause`. They will drift.

**Rule:** Renderer components are views. They render what the server returns.
All filtering, grouping, and aggregation goes through `FilterCondition[]` → IPC → DuckDB.

---

## Debt Inventory

### D1 — `MultiTableSystem.tsx`: `baseFilteredTransactions` (~lines 1507–1600) ❌
**What it does:** 94-line client-side filter evaluation. Reads `transactions`,
`activeFilters`, `filterState`, `filterConnectors`, `filterGroupOperators`
and implements a custom AND/OR evaluator (`evaluateFilterConditions`).

**Why it's wrong:** `transactions` is 100 rows (first page from `useLightTransactions`).
The filter is applied to those 100 rows, not the full dataset.
The server already applies these exact conditions via `FilterCondition[]`.

**Fix:** Delete entirely. `transactions` is already server-filtered when it arrives.

---

### D2 — `MultiTableSystem.tsx`: `filteredTransactions` for taxonomy L1-L4 (~lines 1609–1637) ❌
**What it does:** Second client-side pass applying `classificationL1–L4` filterState
as a path substring match on the already-filtered 100 rows.

**Fix:** Delete. `classificationL1–L4` filters become `FilterCondition[]` fields
sent to IPC like every other filter. No special client-side handling.

---

### D3 — `MultiTableSystem.tsx`: `tableLocalFilters` (entire concept) ❌
**What it does:** Per-table `Record<string, Record<string, string[]>>` filter state
applied client-side, separate from the global filter conditions.

**Why it exists:** Drag-drop applied a filter to just one table rather than globally.
**Why it's wrong:** Arbitrary per-table filtering that bypasses the server.

**Fix:** Delete. Drag-drop onto a table → calls `onAddFilter(column, values)` →
adds to `activeFilters` → triggers new `transactions:query`. Same as any other filter.
The distinction between "global" and "per-table" filters doesn't exist at the DB level.

---

### D4 — `MultiTableSystem.tsx`: Non-taxonomy client-side grouping (~lines 867–890) ❌
**What it does:** `data.reduce()` grouping by column value to build `tableData`
for non-taxonomy tables.

**Fix:** This code path should never run. Server-side mode (`groupedData` from
`useGroupedTransactions`) is already the primary path. The client-side fallback
at line ~867 should be deleted. If `groupedData` is null, show a loading state.

---

### D5 — `MultiTableSystem.tsx`: Keyboard nav client-side grouping fallback (~lines 1851–1873) ❌
**What it does:** When `renderedTableDataRef` is empty, falls back to a
`sourceTransactions.reduce()` grouping to compute table data for keyboard nav.

**Fix:** Delete fallback. Keyboard nav uses `renderedTableDataRef` exclusively —
populated by `onTableDataComputed` from each `FilterTable`. If not yet populated,
keyboard nav simply doesn't move (state is initializing).

---

### D6 — `MultiTableSystem.tsx`: `filterOptions` useMemo (~lines 1466–1490) ❌
**What it does:** Scans all `transactions` to compute unique confidence levels,
suppliers, and classifications for filter dropdowns.

**Fix:** If filter dropdowns need distinct values, call a
`transactions:getDistinctValues(column, FilterCondition[])` IPC channel.
Or: if the dropdowns are only used in `CurrentFiltersPanel`, remove them entirely
(the panel already shows active filters, not all possible values).

Audit `CurrentFiltersPanel` to determine if `filterOptions` is even used.

---

### D7 — `MultiTableSystem.tsx`: Taxonomy tree spend overlay (~lines 799–863) ❌ (partial)
**What it does:** Builds a client-side tree from `taxonomyNodes` (list of taxonomy
paths), then overlays spend amounts by iterating `data` (the 100-row page).

**Why it's wrong:** The spend amounts come from 100 rows — wrong totals.

**Fix:** The taxonomy table uses `classification_path` grouping. The `groupedData`
prop already provides server-side GROUP BY `classification_path`. Use that to
build the tree (same pattern as non-taxonomy tables in server-side mode).
Node structure still comes from `taxonomyNodes`; amounts come from `groupedData`.

---

### D8 — `useHierarchicalPivotData.ts`: Entire hook ❌
**What it does:** Takes full `transactions` array and builds a pivot tree
client-side with `useMemo`. O(n) on all transactions.

**Current callers:** Check — probably MetricsTab or SpendVisualizations.
If `useServerPivotData` is already the replacement, this hook is dead code.

**Fix:** Delete the hook. All callers use `useServerPivotData`.

---

### D9 — `MetricsTab.tsx`: All aggregation is client-side ❌
**What it does:**
- `totals` — `.reduce()` + `.filter()` for totalSpend, totalRows, suppliers, lowConf
- `chartData` — L1 grouping + dimension grouping via `Map.forEach()` on `filteredTransactions`
- `topSuppliers` — grouping by supplier with `Map`
- `monthlySeries` — grouping by month with `Map`
- `supplierGainersDecliners` — month-over-month comparison

All of this runs on `filteredTransactions` (a prop — actually 100 rows again).

**Fix:** MetricsTab should call its own IPC endpoints:
- `ipc.transactions.stats()` → totals (already exists, already returns the right shape)
- `ipc.transactions.pivotAggregation(['L1'], 'spend_amount', 'sum', filters)` → L1 chart data
- `ipc.transactions.pivotAggregation(['supplier_name'], 'spend_amount', 'sum', filters)` → top suppliers
- `ipc.transactions.pivotAggregation(['year', 'month'], 'spend_amount', 'sum', filters)` → monthly series

MetricsTab should NOT receive `transactions` or `filteredTransactions` as props.
It should be self-sufficient, calling IPC directly and reading `useReviewFilterContext()`
for current filter state (per the PR 3 spec: tab components call the hook directly).

---

### D10 — `SpendVisualizations.tsx`: Client-side filtering + grouping ❌
**What it does:**
- Line 26: `filteredTransactions = transactions.filter(...)` — client-side filter
- `topSuppliersData` — `.forEach()` + `Map` grouping by supplier
- `taxonomySpend` — `.forEach()` building per-level spend Maps

**Fix:** Same as MetricsTab. Use `ipc.transactions.pivotAggregation()` for each
chart. `SpendVisualizations` should call IPC directly, not receive `transactions`.

---

### D11 — `evaluateFilterConditions` function in `MultiTableSystem.tsx` ❌
Custom AND/OR filter evaluator in the renderer. This is a duplicate of the
server's `buildWhereClause` logic. Deleting D1 and D2 makes this dead code.

**Fix:** Delete the function.

---

## What Is Legitimately Client-Side (Keep)

These are acceptable because they operate on **already-aggregated data** (hundreds of rows, not millions):

| Hook / Code | Why OK |
|---|---|
| `useServerPivotData.ts` — tree building from flat rows | Input is compact aggregated result from `pivotAggregation`, not raw transactions |
| `useGroupedTransactions.ts` — passing result to tables | Server returns grouped rows; client just renders them |
| `transactionsByValue` Map in FilterTable | Built from 100-row page; used only for classification display in tree rows, not for filtering |
| `useReviewFilters.toFilterConditions()` | Converts UI state → `FilterCondition[]` for IPC; this is building the query, not executing it |
| Sort order for display | OK |

---

## Impact on PR Plan

| PR | Impact |
|---|---|
| PR 2 (MultiTableSystem) | Delete D1, D2, D3, D4, D5, D6, D7 (partial), D11. Props interface simplifies: no `tableLocalFilters`, no `filterState`/`activeFilters` for client-side eval (they're still passed for `CurrentFiltersPanel` display) |
| PR 3 (Dashboard Decomp) | MetricsTabContainer calls own IPC — no `transactions` prop drilled. SpendVisualizations same. D8, D9, D10 fixed here. |
| PR 4 (ClassificationTree) | Tree receives server-side node data, not client-grouped taxonomy tree |
| PR 5 (Type Safety) | Delete `useHierarchicalPivotData.ts` (dead code after D8 fix) |
