# PR 5: Type Safety Fixes — Close Remaining Gaps in the Type Contract

## Problem
Three categories of residual type issues after PRs 1-4:
1. IPC event listener `on()` is untyped — takes `channel: string`
2. `React.Dispatch<SetStateAction<X>>` may remain in components not touched by PRs 1-4
3. `tableLocalFilters` type in `ReviewFilterContext` is wrong — needs `Record<string, FilterCondition[]>`
4. Ad-hoc filter shapes (`Record<string, string[]>` / `Record<string, Record<string, string[]>>`)
   that should be `FilterCondition[]` wherever they represent query conditions
5. `humanReviewed` presence on the shared `Transaction` type needs verification

---

## Changes

### 1. Type the event listener

In `src/renderer/lib/ipc.ts`, change `on()` signature:
```ts
function on<K extends keyof IPCEventMap>(
  channel: K,
  callback: (data: IPCEventMap[K]) => void
): () => void
```
Update callers (`classification:progress`, `suppliers:research:progress`) — should be no-op
since they already pass the right types.

### 2. Fix `tableLocalFilters` in `ReviewFilterContext`

PR 1 left `tableLocalFilters` as `Record<string, Record<string, string[]>>` (wrong).
The correct type per architecture is `Record<string, FilterCondition[]>`.

In `ReviewFilterContext.tsx`:
```typescript
// Change in ReviewFilterState
tableLocalFilters: Record<string, FilterCondition[]>  // was: Record<string, Record<string, string[]>>

// Change in defaultFilters
tableLocalFilters: {}
```

Update all consumers: `MultiTableSystem`, `ActiveFilters`, `CurrentFiltersPanel`, `Tabs`.
The migration pattern is documented in `2-multitable-decomposition.md` (PR 2) — the
`handleRemoveLocalFilter` implementation shows how `FilterCondition[]` is accessed.

### 3. Audit `React.Dispatch<SetStateAction<X>>` across all renderer components

Search for `Dispatch<SetStateAction` in `src/renderer/`. For each occurrence:
- If it's in a component prop interface or hook return type: replace with plain callback
  `(updater: ((prev: X) => X) | X) => void`
- If it's inside a component body from `useState`, it's fine — that's React internal use

Components likely to have residual `Dispatch<SetStateAction>` props:
- Any component in `src/renderer/components/review/` not updated by PRs 2-4
- Components that received props from Dashboard before PR 3 simplified it
- Look especially at: `ActiveFilters.tsx`, `CurrentFiltersPanel.tsx`, `Tabs.tsx`, `TopMetrics.tsx`

### 4. Audit ad-hoc filter shapes

Search for `Record<string, string[]>` in renderer code used as filter conditions.
Any shape that means "the conditions to apply to a query" should be `FilterCondition[]`.
The `filterState` field in `ReviewFilterState` (`Record<string, string[]>`) is intentionally
a UI state shape (it maps UI filter key → selected values), NOT query conditions — that is
correct. The conversion to `FilterCondition[]` happens in `useReviewFilters.toFilterConditions()`.

Flag: `Record<string, Record<string, string[]>>` anywhere — this is always wrong.
It's the shape that existed for `tableLocalFilters` before the fix. Remove all instances.

### 5. Delete `useHierarchicalPivotData.ts` if no callers remain

After PR 3 fixes MetricsTab/SpendVisualizations to call IPC directly,
`useHierarchicalPivotData.ts` becomes dead code (replaced by `useServerPivotData`).
Verify zero callers with a codebase search, then delete the file.

### 6. Verify `humanReviewed` on Transaction type

- Check `src/shared/types/transactions.ts` for `humanReviewed: boolean`
- If missing, add it
- Verify `TransactionStore.queryTransactionsPaginated` includes `human_reviewed` in SELECT
- Verify `DashboardTransactionRow` maps `humanReviewed` correctly in `transactionTransform.ts`
- Search for `classification_status === 'human_reviewed'` in the codebase — each match is a bug;
  replace with `row.humanReviewed`

### 6. Audit IPC handler argument casts

Check IPC handler files in `src/main/ipc/` for `as` type casts on arguments.
Where possible, replace with proper typing derived from `IPCInvokeMap`.
Do NOT silence errors with `as any` — fix the type at the source.

---

## Type Checklist
Before opening the PR, verify:
- [ ] `tsc --noEmit` passes with zero errors — no new `as any` added
- [ ] `tableLocalFilters` is `Record<string, FilterCondition[]>` everywhere
- [ ] No `React.Dispatch<SetStateAction<X>>` in any component prop interface
- [ ] No `Record<string, Record<string, string[]>>` in renderer code
- [ ] No `classification_status === 'human_reviewed'` anywhere

## Dependencies
- PR 2 must land first — `tableLocalFilters` fix in MultiTableSystem must precede the context fix
  (otherwise MultiTableSystem still expects the old shape)
- PRs 3-4 should land first to ensure no new `Dispatch<SetStateAction>` is introduced

## Files touched
- `src/renderer/lib/ipc.ts`
- `src/renderer/components/review/ReviewFilterContext.tsx` (`tableLocalFilters` type fix)
- `src/shared/types/transactions.ts` (if `humanReviewed` missing)
- `src/shared/types/ipc-contract.ts` (if event types need updating)
- `src/main/services/transactions.ts` (if SELECT needs updating)
- `src/renderer/utils/transactionTransform.ts` (if mapping needs updating)
- `src/renderer/components/review/ActiveFilters.tsx` (type cleanup)
- `src/renderer/components/review/CurrentFiltersPanel.tsx` (type cleanup)
- `src/renderer/components/review/Tabs.tsx` (type cleanup)
- `src/main/ipc/*.ts` (audit casts)
