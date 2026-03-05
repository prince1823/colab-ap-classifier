# PR 3: Dashboard Decomposition — Split 1,068-Line Component Into Tabs + Hooks

## Problem
`Dashboard.tsx` (1,068 lines) manages filter state, multiple tabs (tables, tree, metrics),
reclassification, undo/redo, and toasts — all inline. The architecture says Dashboard should
be a thin wrapper composing hooks and child components (~200 lines max).

## Changes

### 1. Extract each tab into its own component
- `TablesTab.tsx` — wraps MultiTableSystem with its props
- `TreeTab.tsx` — wraps ClassificationTree with its props
- `MetricsTabContainer.tsx` — wraps MetricsTab/SpendVisualizations with data loading
- Each tab component owns its own data fetching and local state

### 2. Move filter orchestration into useReviewFilters
- If not already done in PR 1, ensure all filter state management
  (active filters, filter panel visibility, filter combinators) lives in the hook
- Dashboard just passes the hook's return values down

### 3. Simplify Dashboard to layout-only
- Tab bar + active tab rendering
- Top metrics bar (already extracted as TopMetrics)
- Reclassification toast (thin wrapper)
- ~200 lines: layout, tab switching, composing child components

### 4. Clean up prop drilling
- Tabs receive data via hooks, not via props drilled through Dashboard
- `useTransactions()` called within each tab that needs it, not at Dashboard level

## Dependencies
- PR 1 (store cleanup) — filter state must be in hooks first
- PR 2 (MultiTableSystem decomposition) — tables tab wraps the simplified component

## Files touched
- `src/renderer/components/review/Dashboard.tsx` (major simplification)
- New: `src/renderer/components/review/TablesTab.tsx`
- New: `src/renderer/components/review/TreeTab.tsx`
- New: `src/renderer/components/review/MetricsTabContainer.tsx`
