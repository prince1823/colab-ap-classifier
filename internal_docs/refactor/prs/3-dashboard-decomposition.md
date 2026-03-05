# PR 3: Dashboard Decomposition — Split Into Tabs + Fix MetricsTab/SpendVisualizations

## Problem

Two things need fixing together:

1. `Dashboard.tsx` (~1,000 lines) manages tab switching, reclassification, undo/redo,
   toasts, and filter orchestration — all inline. Should be a thin wrapper (~200 lines).

2. `MetricsTab.tsx` and `SpendVisualizations.tsx` do **all their aggregation
   client-side** on the `transactions` prop (which is only the first 100 rows from
   `useLightTransactions`). This is wrong — they should call IPC directly.
   See `architectural-debt-audit.md` D8, D9, D10.

## Dependencies
- PR 2 (MultiTableSystem cleanup) — establishes the pattern that tab components call IPC

---

## Changes

### 1. Extract each tab into its own component

**`TablesTab.tsx`** — wraps `MultiTableSystem`. Reads `useReviewFilterContext()`
directly for filter state. No filter props drilled from Dashboard.

**`MetricsTabContainer.tsx`** — wraps `MetricsTab` and `SpendVisualizations`.
Calls IPC directly for all aggregated data. Does NOT receive `transactions` or
`filteredTransactions` as props.

### 2. Fix MetricsTab / SpendVisualizations — IPC-only data model

`MetricsTab` currently receives `transactions: TransactionRow[]` and
`filteredTransactions: TransactionRow[]` and does all aggregation client-side.
This is ~200 lines of `useMemo` that belongs in DuckDB.

**Delete from `MetricsTab` props:**
- `transactions`
- `filteredTransactions`

**Replace with IPC calls inside `MetricsTabContainer`:**

```typescript
// In MetricsTabContainer — reads filter state from context, calls IPC
const { filters } = useReviewFilterContext()
const filterConditions = useReviewFilters().toFilterConditions()

// Stats (totalSpend, totalRows, totalSuppliers, lowConf count)
const { data: stats } = useIPC(() => ipc.transactions.stats(), [])
// Already returns: { totalRows, totalSpend, classifiedCount, unclassifiedCount }

// L1 spend breakdown → passed to chart component
const { data: l1Pivot } = useIPC(
  () => ipc.transactions.pivotAggregation(['classification_l1'], 'spend_amount', undefined, { conditions: filterConditions }),
  [JSON.stringify(filterConditions)]
)

// Top suppliers → passed to chart component
const { data: supplierPivot } = useIPC(
  () => ipc.transactions.pivotAggregation(['supplier_name'], 'spend_amount', undefined, { conditions: filterConditions }),
  [JSON.stringify(filterConditions)]
)

// Monthly spend series
const { data: monthlyPivot } = useIPC(
  () => ipc.transactions.pivotAggregation(['year', 'month'], 'spend_amount', undefined, { conditions: filterConditions }),
  [JSON.stringify(filterConditions)]
)
```

`MetricsTab` is refactored to receive already-aggregated typed data:

```typescript
interface MetricsTabProps {
  stats: TransactionStats
  l1Data: { name: string; value: number }[]
  supplierData: { name: string; total: number }[]
  monthlyData: { month: string; spend: number }[]
  particularDimension: string
  onDimensionChange: (dim: string) => void
  onDrillToFilters: (filters: Record<string, string[]>) => void
}
```

No `any` in prop types. No `TransactionRow[]` prop (no raw rows).

**Delete from `SpendVisualizations`:**
- `transactions` prop
- `activeFilters` prop (it was used for client-side filtering)
- The `filteredTransactions = useMemo(() => transactions.filter(...))` computation

`SpendVisualizations` calls its own `ipc.transactions.pivotAggregation()` or
receives pre-aggregated data from `MetricsTabContainer`.

**Delete after this PR:**
- `useHierarchicalPivotData.ts` — dead code once MetricsTab stops receiving raw transactions
  (verify no other callers first; if none, delete the file)

### 3. Filter orchestration — tab components call context directly

PR 1 moved all filter state to `ReviewFilterContext`. Dashboard already reads from
`useReviewFilterContext()`. Tab components call `useReviewFilterContext()` directly —
do NOT drill filter props from Dashboard down through tab components.

### 4. No `Dispatch<SetStateAction>` in new tab component props

```typescript
// WRONG — don't do this in new components
setSelectedRows: React.Dispatch<React.SetStateAction<string[]>>

// RIGHT — plain updater callback
setSelectedRows: (updater: ((prev: string[]) => string[]) | string[]) => void
```

### 5. `DashboardTransactionRow` is the row type everywhere

New tab components receive `DashboardTransactionRow[]` for the rare cases they
need raw row data (e.g., TablesTab passing to MultiTableSystem). Never `any[]`.

### 6. Simplify Dashboard to layout-only

After extraction Dashboard should be:
- Tab bar + active tab switching
- Top metrics bar (already `TopMetrics`)
- Reclassification toast
- `useReclassification()` and `useUndoRedo()` hooks wired up once here
- ~200 lines

### 7. Reclassification + undo/redo stay in Dashboard

`useReclassification()` and `useUndoRedo()` results are owned at the Dashboard level
because they span both the tree (drag-drop source) and tables (selection source).
Pass their callbacks explicitly as props to child components that trigger them —
these are event callbacks, not state setters.

---

## Type Checklist
Before opening the PR, verify:
- [ ] No `React.Dispatch<SetStateAction<X>>` anywhere in new component prop interfaces
- [ ] No `any` in row or aggregated data types
- [ ] `MetricsTab` receives no `TransactionRow[]` — only pre-aggregated typed shapes
- [ ] `SpendVisualizations` receives no `transactions` — calls IPC or receives aggregated data
- [ ] Tab components call `useReviewFilterContext()` directly, don't receive filter state as props
- [ ] `useHierarchicalPivotData.ts` deleted if no callers remain
- [ ] `tsc --noEmit` passes with zero errors

## Files Touched
- `src/renderer/components/review/Dashboard.tsx` (major simplification)
- `src/renderer/components/review/MetricsTab.tsx` (refactor props, delete client-side aggregation)
- `src/renderer/components/review/SpendVisualizations.tsx` (refactor props, delete client-side filter + aggregation)
- New: `src/renderer/components/review/TablesTab.tsx`
- New: `src/renderer/components/review/MetricsTabContainer.tsx`
- `src/renderer/hooks/useHierarchicalPivotData.ts` — delete if no callers
