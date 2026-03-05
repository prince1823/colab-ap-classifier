# PR 2: MultiTableSystem Decomposition — Break Up the 2,159-Line God Component

## Problem
`MultiTableSystem.tsx` is 2,159 lines. It contains:
- Hierarchical data grouping logic (tree-building via `.reduce()`)
- Client-side transaction filtering (lines ~1570, ~1610 — `transactions.filter()`)
- Client-side aggregation (`.reduce()` for spend sums)
- Drag-drop state management
- Row selection logic
- Keyboard navigation
- Table rendering
- ~50+ state variables

The architecture forbids client-side `.filter()` / `.reduce()` on transaction data.
All filtering and aggregation must happen server-side via SQL.

## Changes

### 1. Move client-side filtering to server-side
- Identify every `.filter()` call that operates on `DashboardTransactionRow[]` for data filtering
  (not string splits or UI-only filtering)
- Replace with IPC calls: `transactions:query` with appropriate `FilterCondition[]`,
  or `transactions:queryGrouped`, or `transactions:pivotAggregation`
- Key offenders:
  - Line ~232: filtering transactions by classification path
  - Line ~368: filtering transactions by criteria
  - Line ~867: grouping via `.reduce()` (should be `transactions:queryGrouped`)
  - Line ~1570: base transaction filtering
  - Line ~1610: secondary filtering layer
  - Line ~1851: spend grouping via `.reduce()` (should be `transactions:pivotAggregation`)

### 2. Extract data grouping into a hook or utility
- Tree-building logic (hierarchical grouping, path splitting, amount computation) → `useHierarchicalData.ts` hook or `src/renderer/utils/hierarchicalGrouping.ts` utility
- This is ~300 lines of pure data transformation

### 3. Extract drag-drop into a hook
- `useTableDragDrop.ts` — manages drag state, drop targets, reclassification triggers
- ~200 lines

### 4. Extract row selection into a hook
- `useRowSelection.ts` — selected rows, shift-click range selection, keyboard navigation
- ~150 lines

### 5. Extract table rendering into presentational components
- `HierarchicalTable.tsx` — renders a single hierarchical table with expand/collapse
- `TableRow.tsx` — renders a single row with selection, drag handle
- `TableHeader.tsx` — column headers with sort indicators
- MultiTableSystem becomes a thin orchestrator: layout, tab management, composing child components

## Result
`MultiTableSystem.tsx` should be ~400-500 lines: layout, state coordination, composing hooks + child components.
No `.filter()` or `.reduce()` on transaction arrays.

## Dependencies
- PR 1 (store cleanup) should land first so filter state is in the right place

## Files touched
- `src/renderer/components/review/MultiTableSystem.tsx` (major refactor)
- New: `src/renderer/hooks/useTableDragDrop.ts`
- New: `src/renderer/hooks/useRowSelection.ts`
- New: `src/renderer/utils/hierarchicalGrouping.ts` (or hook)
- New: `src/renderer/components/review/HierarchicalTable.tsx`
- New: `src/renderer/components/review/TableRow.tsx`
- Possibly: `src/main/services/transactions.ts` (new query methods if needed)
- Possibly: `src/main/ipc/transactions.ts` (new IPC channels if needed)
- `src/shared/types/ipc-contract.ts` (add new channels if needed)
