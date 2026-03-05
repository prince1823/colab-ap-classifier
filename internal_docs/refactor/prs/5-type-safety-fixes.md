# PR 5: Type Safety Fixes — Close Remaining Gaps in the Type Contract

## Problem
Two gaps in the type safety layer:
1. The `on()` event listener in `ipc.ts` takes `channel: string` — not typed against `IPCEventMap`
2. `humanReviewed` may be missing from the shared `Transaction` type (arch doc says it's mandatory)

## Changes

### 1. Type the event listener
- In `src/renderer/lib/ipc.ts`, change `on()` signature:
  ```ts
  function on<K extends keyof IPCEventMap>(
    channel: K,
    callback: (data: IPCEventMap[K]) => void
  ): () => void
  ```
- Update callers (classification:progress, suppliers:research:progress) — should be no-op
  since they already pass the right types

### 2. Verify humanReviewed on Transaction type
- Check `src/shared/types/transactions.ts` for `humanReviewed: boolean`
- If missing, add it
- Verify `TransactionStore.queryTransactionsPaginated` includes it in SELECT
- Verify `DashboardTransactionRow` maps it correctly in `transactionTransform.ts`

### 3. Audit IPC handler argument casts
- Check IPC handler files for `as` type casts on arguments
- Where possible, replace with proper typing derived from `IPCInvokeMap`

## Dependencies
- Independent of PRs 1-4

## Files touched
- `src/renderer/lib/ipc.ts`
- `src/shared/types/transactions.ts` (if humanReviewed missing)
- `src/shared/types/ipc-contract.ts` (if event types need updating)
- `src/main/services/transactions.ts` (if SELECT needs updating)
- `src/renderer/utils/transactionTransform.ts` (if mapping needs updating)
- `src/main/ipc/*.ts` (audit casts)
