# PR 2: MultiTableSystem — Delete Client-Side Processing + Fix Type Contract

## Core Principle

Renderer components are views. DuckDB IPC calls are < 5ms in Electron.
Everything that is currently a client-side `.filter()` / `.reduce()` on
`transactions` goes away — the server already did that work before the
data arrived. See `architectural-debt-audit.md` for the full inventory.

---

## Part 1: Delete Client-Side Filtering (D1, D2, D11)

### Delete `baseFilteredTransactions` and `filteredTransactions`

`transactions` prop is already server-filtered (comes from `transactions:query`
with `FilterCondition[]` in Dashboard). The client-side re-filter is running on
100 rows (first page) — wrong data, redundant work.

Delete:
- `baseFilteredTransactions` useMemo (~lines 1507–1600)
- `filteredTransactions` useMemo for L1-L4 taxonomy filters (~lines 1609–1637)
- `evaluateFilterConditions` function (~lines 78–102)
- `matchWithOperator`, `matchesActiveFilter`, `matchesFilterStateEntry` helpers

What replaces them: nothing. `transactions` IS the filtered data. All filter
changes → `FilterCondition[]` → IPC → new `transactions` prop.

The `classificationL1–L4` filterState entries must become `FilterCondition[]`
fields sent to the server like every other filter. Dashboard's `serverSideFilter`
useMemo (which builds `FilterCondition[]` for the query) already reads `filterState`
— add the L1-L4 keys there with appropriate column names (`classification_l1`, etc.).

### Remove `tableLocalFilters` (D3)

Delete from `MultiTableSystemProps`:
- `tableLocalFilters` prop
- `setTableLocalFilters` prop
- `onRemoveLocalFilter` prop

Delete from `ReviewFilterContext.tsx`:
- `tableLocalFilters` field from `ReviewFilterState`
- `tableLocalFilters: {}` from `defaultReviewFilters`

Delete from `Dashboard.tsx`:
- `tableLocalFilters` state binding
- `setTableLocalFilters` callback
- `handleRemoveLocalFilter` function (and its call site)

Delete from `ActiveFilters.tsx`:
- `tableLocalFilters` prop
- `onRemoveLocalFilter` prop
- The local filter section in `combined` useMemo

Delete from `Tabs.tsx`:
- `tableLocalFilters` prop
- `onRemoveLocalFilter` prop

Delete from `CurrentFiltersPanel.tsx`:
- `tableLocalFilters` prop (if present)

Drag-drop onto a table now calls `onAddFilter(column, [value])` → adds to
`activeFilters` → triggers new server query. No per-table state needed.

---

## Part 2: Delete Client-Side Grouping (D4, D5)

### Delete non-taxonomy client-side grouping

The `data.reduce()` grouping for non-taxonomy tables (~lines 867–890) is
a fallback that should never run — server-side mode already handles it.
Delete the fallback. If `groupedRows` is null, render a loading/empty state.

### Delete keyboard nav grouping fallback (D5)

The `sourceTransactions.reduce()` fallback in `getCurrentTableData` (~lines 1851–1873)
should be deleted. Keyboard nav uses only `renderedTableDataRef` (reported by
`onTableDataComputed` from each FilterTable). If not yet populated, return `[]`.

---

## Part 3: Fix Taxonomy Tree (D7)

The taxonomy tree currently overlays spend amounts by iterating `data`
(100-row page) — wrong totals. Fix:

`groupedData` already contains a `Map<string, GroupedTransactionsResult>` where
the `classification_path` key gives server-side grouped rows for the taxonomy table.
Use that result for spend amounts in the tree. Node structure still comes from
`taxonomyNodes`; amounts come from `groupedData.get('classification_path')?.rows`.

Remove the `spendByPath` accumulation loop from `data`.

---

## Part 4: Delete `filterOptions` (D6)

The `filterOptions` useMemo (~lines 1466–1490) scans `transactions` to build
confidence/supplier/classification dropdown options. Audit whether `CurrentFiltersPanel`
or any other component actually uses this. If it does, replace with an IPC call
to a new `transactions:getDistinctValues(column, FilterCondition[])` channel.
If it doesn't, delete it.

---

## Part 5: Fix Type Contract

### Root cause of `as any` in Dashboard

Every setter prop on `MultiTableSystem` is declared as `React.Dispatch<SetStateAction<X>>`.
Since Dashboard sources state from `ReviewFilterContext` (plain callbacks), types don't
align — hence `as any`. Fix the prop, not the call site.

### Target Props Interface

```typescript
import type { ReviewTableConfig } from './ReviewFilterContext'
import type { DashboardTransactionRow } from '../../utils/transactionTransform'
import type { GroupedTransactionsResult } from '../../../shared/types/transactions'

interface TableNavState {
  tableIndex: number
  rowIndex: number
}

interface MultiTableSystemProps {
  // ── Data ──────────────────────────────────────────────────────────────────
  transactions: DashboardTransactionRow[]        // first-page rows for tree/display
  groupedData: Map<string, GroupedTransactionsResult> | null  // server-side aggregates

  // ── Filter state (read-only in MultiTableSystem — for display in panels) ──
  activeFilters: Record<string, string[]>
  filterState: Record<string, string[]>
  filterCombinator: 'AND' | 'OR'
  filterConnectors: Record<string, 'AND' | 'OR'>
  filterGroupOperators: Record<string, string>

  // ── Filter state setters (plain callbacks, not Dispatch<SetStateAction>) ──
  setActiveFilters: (updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => void
  setFilterState: (updater: ((prev: Record<string, string[]>) => Record<string, string[]>) | Record<string, string[]>) => void

  // ── Row selection ─────────────────────────────────────────────────────────
  selectedRows: string[]
  setSelectedRows: (updater: ((prev: string[]) => string[]) | string[]) => void

  // ── Table config ──────────────────────────────────────────────────────────
  tables: ReviewTableConfig[]
  setTables: (updater: ((prev: ReviewTableConfig[]) => ReviewTableConfig[]) | ReviewTableConfig[]) => void
  onReorderTables?: (updater: ((prev: ReviewTableConfig[]) => ReviewTableConfig[]) | ReviewTableConfig[]) => void
  availableColumns?: string[]
  addTable: (column: string) => void

  // ── Filter event callbacks ─────────────────────────────────────────────────
  onSetFilterCombinator: (val: 'AND' | 'OR') => void
  onSetFilterConnector: (key: string, val: 'AND' | 'OR') => void
  onSetFilterOperator: (key: string, val: string) => void
  onRemoveFilter: (key: string, value: string | null) => void
  onClearAll: () => void
  onAddFilter: (column: string, values: string[]) => void
  onDoubleClickFilter: (column: string, values: string[]) => void
  onApplySelectionAsFilter: () => void

  // ── Keyboard navigation ───────────────────────────────────────────────────
  keyboardFocus: 'tree' | 'tables'
  setKeyboardFocus: (focus: 'tree' | 'tables') => void
  tableNav: TableNavState
  setTableNav: (updater: ((prev: TableNavState) => TableNavState) | TableNavState) => void

  // ── Optional callbacks ────────────────────────────────────────────────────
  onFocusedClassificationPathChange?: ((path: string | null) => void) | null
}
```

**Key deletions vs current interface:**
- `allTransactions` — removed (unused)
- `tableLocalFilters` / `setTableLocalFilters` / `onRemoveLocalFilter` — removed (D3)
- `filterState?: FilterStateMap` — was optional with local default; now `Record<string, string[]>`
- `tables?: TableDef[]` — `TableDef` deleted, use `ReviewTableConfig`
- `keyboardFocus: string` → `'tree' | 'tables'`
- All `Dispatch<SetStateAction<X>>` → plain callbacks

### Delete local type duplicates

- `TableDef` → delete, use `ReviewTableConfig` (import from `ReviewFilterContext`)
- `FilterStateMap` → delete, use `Record<string, string[]>` directly
- `filterState` default object → change to `filterState: Record<string, string[]> = {}`

### Fix `humanReviewed` check

```typescript
// Delete (wrong — 'human_reviewed' is not a ClassificationStatus value)
if (row['human_reviewed'] || row.humanReviewed) confidences.add('high')

// Fix
if (row.humanReviewed) confidences.add('high')
```

### Fix internal `any[]`

```typescript
// Change Map type in transactionsByValue
const map = new Map<string, DashboardTransactionRow[]>()
```

---

## Part 6: Dashboard Call Site Cleanup

Once MultiTableSystem props are fixed, remove all `as any` from Dashboard's
`<MultiTableSystem ...>` call site. The setters from `ReviewFilterContext`
are already the right shape.

Also update `serverSideFilter` in Dashboard to include `classificationL1–L4`
in the `FilterCondition[]` it sends to IPC (since we deleted the client-side
L1-L4 filtering from MultiTableSystem):

```typescript
// In Dashboard's serverSideFilter useMemo, add:
const classMapping: Record<string, string> = {
  classificationL1: 'classification_l1',
  classificationL2: 'classification_l2',
  classificationL3: 'classification_l3',
  classificationL4: 'classification_l4',
}
Object.entries(filterState).forEach(([fsKey, fsValues]) => {
  if (!Array.isArray(fsValues) || fsValues.length === 0) return
  const col = fsKeyToCol[fsKey] || classMapping[fsKey] || fsKey
  // ... rest of condition push
})
```

---

## Type Checklist
Before opening the PR, verify:
- [ ] No `React.Dispatch<SetStateAction<X>>` in `MultiTableSystemProps`
- [ ] No `TableDef` or `FilterStateMap` local type definitions — use `ReviewTableConfig`, `Record<string, string[]>`
- [ ] No `baseFilteredTransactions`, `filteredTransactions`, `evaluateFilterConditions` in the file
- [ ] No `tableLocalFilters` anywhere in the codebase
- [ ] `humanReviewed` boolean check, not string comparison
- [ ] `as any` gone from Dashboard's MultiTableSystem call site
- [ ] `tsc --noEmit` passes with zero errors

## Files Touched
- `src/renderer/components/review/MultiTableSystem.tsx` — major cleanup
- `src/renderer/components/review/Dashboard.tsx` — remove `as any`, add L1-L4 to serverSideFilter
- `src/renderer/components/review/ReviewFilterContext.tsx` — remove `tableLocalFilters`
- `src/renderer/components/review/ActiveFilters.tsx` — remove `tableLocalFilters` + `onRemoveLocalFilter`
- `src/renderer/components/review/CurrentFiltersPanel.tsx` — remove `tableLocalFilters` if present
- `src/renderer/components/review/Tabs.tsx` — remove `tableLocalFilters` + `onRemoveLocalFilter`
