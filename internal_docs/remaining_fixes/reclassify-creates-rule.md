# Reclassification Always Creates a Rule — Action Spec

**Issue:** #379
**Branch:** `feature/reclassify-creates-rule` (from `dev`)

Any reclassification from the review page must create an override rule and respect rule
priority. Transactions already covered by higher-priority rules are shown as a warning
to the user before applying.

---

## Current Behavior (Two Separate Flows)

### Cmd+K — reclassify only, no rule

```
usePivotKeyboard case 'k'
  → onCmdF(getExplicitlySelectedRows())
  → HierarchicalPivotView.handleCmdF → onReclassify(rows)
  → PivotPage opens ReclassifyModal
  → useReclassification.apply(node)
    → ipc.transactions.getIdsByConditions(flatConditions)
    → ipc.transactions.update({ ids, taxonomyNodeId })     ← no rule, no priority check
    → pushUndo({ changelogId })
```

### Cmd+L — create rule + apply, no priority check

```
usePivotKeyboard case 'l'
  → onCmdL(getExplicitlySelectedRows())
  → HierarchicalPivotView.handleCmdL → onCreateRule(rows)
  → PivotPage opens CreateRuleModal
  → handleSave()
    → ipc.rules.createAndApply({ name, groupedConditions, targetNodeId, groupId })
      → createRule() then transactions.applyRule()          ← applies to ALL matching, ignores priority
    → onCreated() (refetch)
```

**Problems:**
1. Cmd+K creates no rule — reclassification is lost on next "Apply Rules" run.
2. `createAndApplyRule` calls `transactions.applyRule()` which blindly applies to all
   matching transactions without checking `evaluateRules()` for higher-priority coverage.
3. Rule name is required in Cmd+L flow — unnecessary friction.

---

## New Behavior (Single Unified Flow)

### Cmd+K — classify + create rule + priority check

```
usePivotKeyboard case 'k'
  → onCmdF(getSelectedRows())                          ← changed: falls back to focused row
  → HierarchicalPivotView.handleCmdF → onReclassify(rows)
  → PivotPage opens ReclassifyModal (same modal, no name input)
  → useReclassification.apply(node)
    → buildGroupedConditionsFromRows(rows)              ← shared util (extracted)
    → ipc.transactions.getIdsByConditions(conditions)   ← get candidate IDs
    → ipc.rules.previewConflicts(candidateIds)          ← NEW IPC
    → if conflicts: show warning screen in modal
    → on confirm: ipc.rules.createAndApply(             ← EXISTING IPC, now priority-aware
        { name: selectedGroupName, groupedConditions, targetNodeId, groupId }
      )
    → pushUndo({ changelogId })
```

- **Cmd+L removed** from keyboard hook entirely.
- `CreateRuleModal` removed from `PivotPage` (still exists for `OverrideRulesPage`).
- Rule name defaults to the rule group (bucket) name. If no group selected, falls back
  to taxonomy leaf node name.

---

## Backend Changes

### Modified: `RuleStore.createAndApplyRule(input)`

The existing method is fixed to respect priority. No new method needed.

**Before (line 256-260 of rules.ts):**
```ts
async createAndApplyRule(input: OverrideRuleCreate) {
  const { id } = await this.createRule(input);
  const matchedCount = await this.transactions.applyRule(id, input.groupedConditions, input.targetTaxonomyNodeId);
  return { id, matchedCount };
}
```

**After:**
```ts
async createAndApplyRule(input: OverrideRuleCreate) {
  // 1. Get all matching transaction IDs from conditions
  const allMatchingIds = await this.transactions.getIdsByGroupedConditions(
    input.groupedConditions ?? { groupConnector: 'AND', groups: [] }
  )

  // 2. Check which are already covered by higher-priority rules
  const ruleMap = await this.evaluateRules(allMatchingIds)
  const eligibleIds = allMatchingIds.filter(id => !ruleMap.has(id))

  // 3. Create the rule
  const { id } = await this.createRule(input)

  // 4. Apply only to eligible transactions
  let changelogId: string | undefined
  if (eligibleIds.length > 0) {
    changelogId = await this.transactions.updateTransactions(
      { ids: eligibleIds, taxonomyNodeId: input.targetTaxonomyNodeId,
        classificationStatus: 'classified_by_rule', appliedRuleId: id },
      'rule'
    )
  }

  return {
    id,
    matchedCount: eligibleIds.length,
    skippedCount: allMatchingIds.length - eligibleIds.length,
    changelogId,
  }
}
```

**Why this is safe:** `evaluateRules` runs before `createRule`, so the new rule can't
conflict with itself. The only caller of `createAndApply` is `CreateRuleModal`, which
is being modified anyway. The new behavior is strictly better — there's no reason to
override higher-priority rules silently.

### New: `RuleStore.previewRuleConflicts(candidateIds)`

Composes existing methods (`evaluateRules` + `listAllRules`), no new SQL:

```ts
async previewRuleConflicts(candidateIds: string[]) {
  const ruleMap = await this.evaluateRules(candidateIds)
  const allRules = await this.listAllRules()
  const ruleNameById = new Map(allRules.map(r => [r.id, r.name]))

  const covered = [...ruleMap.entries()].map(([txnId, match]) => ({
    transactionId: txnId,
    existingRuleId: match.ruleId,
    existingRuleName: ruleNameById.get(match.ruleId) ?? match.ruleId,
  }))
  const eligibleIds = candidateIds.filter(id => !ruleMap.has(id))
  return { covered, eligibleIds }
}
```

### Double evaluation note

`evaluateRules` runs once in `previewConflicts` (to show the warning) and once in
`createAndApplyRule` (to apply). This is intentional: rules may change between preview
and confirm, and the apply step must always be correct. The cost is negligible.

---

## IPC Changes

### New channel

```ts
// ipc-contract.ts
'rules:previewConflicts': {
  args: [candidateIds: string[]];
  result: { covered: ConflictRow[]; eligibleIds: string[] }
};
```

### Modified return type

```ts
// ipc-contract.ts — existing channel, return type extended
'rules:createAndApply': {
  args: [input: OverrideRuleCreate];
  result: { id: string; matchedCount: number; skippedCount: number; changelogId?: string }
};
```

### Handler registration

```ts
// src/main/ipc/rules.ts — one new handler
registerHandler('rules:previewConflicts', async (_event, candidateIds: unknown) =>
  rules.previewRuleConflicts(candidateIds as string[])
)
```

Existing `rules:createAndApply` handler stays unchanged — it already delegates to
`rules.createAndApplyRule(input)`.

### Renderer client

```ts
// src/renderer/lib/ipc.ts — one new method
previewConflicts: (candidateIds: string[]) =>
  invoke('rules:previewConflicts', candidateIds),
```

---

## Type Changes

### New type

```ts
// src/shared/types/rules.ts
export interface ConflictRow {
  transactionId: string;
  existingRuleId: string;
  existingRuleName: string;
}
```

### Interface update

```ts
// src/shared/types/services.ts — RuleStore interface
// ADD:
previewRuleConflicts(candidateIds: string[]): Promise<{ covered: ConflictRow[]; eligibleIds: string[] }>;
// MODIFY return type:
createAndApplyRule(input: OverrideRuleCreate): Promise<{ id: string; matchedCount: number; skippedCount: number; changelogId?: string }>;
```

---

## Frontend Changes

### New: `src/renderer/utils/buildConditionsFromRows.ts`

Extracted from `CreateRuleModal` (line 26-58). Shared by `useReclassification` and
`CreateRuleModal`:

```ts
export function buildGroupedConditionsFromRows(rows: FlattenedPivotRow[]): GroupedFilter
```

### Modified: `src/renderer/hooks/useReclassification.ts`

Options gain `selectedGroupId` and `selectedGroupName`. The `apply(node)` method becomes
a two-phase flow:

1. Build `groupedConditions` from rows via shared util.
2. Get `candidateIds` via `ipc.transactions.getIdsByConditions(conditions)`.
3. Call `ipc.rules.previewConflicts(candidateIds)`.
4. If `covered.length > 0` → set conflict state (modal shows warning screen).
5. If `covered.length === 0` → call `confirm()` immediately.
6. `confirm()` calls `ipc.rules.createAndApply({ name: selectedGroupName, groupedConditions, targetTaxonomyNodeId: node.id, groupId: selectedGroupId })` → push `changelogId` to undo stack → close + refetch.

Hook returns new state: `conflicts`, `confirmApply()`, `conflictChecking`.

### Modified: `src/renderer/components/review/ReclassifyModal.tsx`

- No rule name input — name auto-set to `selectedGroupName` by the hook.
- Header changed to **"Classify & Create Rule"**.
- Footer hint: *"A rule will be created and applied immediately."*
- New screen 2 — conflict warning (shown when `reclassify.conflicts` is set):
  ```
  "N transactions are already covered by higher-priority rules"
  - [rule name] — M transactions
  "X transactions will be updated   [Apply to X] [Cancel]"
  ```

### Modified: `src/renderer/hooks/usePivotKeyboard.ts`

- Remove `onCmdL` from `UsePivotKeyboardOptions` interface.
- Remove `case 'l'` handler block.
- `case 'k'`: change `getExplicitlySelectedRows()` → `getSelectedRows()` (falls back
  to focused row if nothing explicitly selected).

### Modified: `src/renderer/components/review/HierarchicalPivotView.tsx`

- Remove `handleCmdL` useMemo (line 515-518).
- Remove `onCmdL: handleCmdL` from `usePivotKeyboard` call (line 552).

### Modified: `src/renderer/pages/PivotPage.tsx`

- Pass `selectedGroupId` + `selectedGroupName` to `useReclassification`.
- Remove `createRuleRows` state, `handleCreateRule` callback, `<CreateRuleModal>`.
- Update keyboard hint text: `⌘K classify & create rule`.

---

## File Change Summary

| File | Change |
|---|---|
| `src/shared/types/rules.ts` | Add `ConflictRow` interface |
| `src/shared/types/services.ts` | Add `previewRuleConflicts`, update `createAndApplyRule` return |
| `src/shared/types/ipc-contract.ts` | Add `rules:previewConflicts`, update `rules:createAndApply` result |
| `src/main/services/rules.ts` | Add `previewRuleConflicts`, modify `createAndApplyRule` |
| `src/main/ipc/rules.ts` | Register `rules:previewConflicts` handler |
| `src/renderer/lib/ipc.ts` | Add `previewConflicts` method |
| `src/renderer/utils/buildConditionsFromRows.ts` | *(new)* Shared grouped condition builder |
| `src/renderer/hooks/useReclassification.ts` | Two-phase flow with conflict state |
| `src/renderer/components/review/ReclassifyModal.tsx` | Conflict screen, updated header |
| `src/renderer/hooks/usePivotKeyboard.ts` | Remove `onCmdL`, Cmd+K uses `getSelectedRows()` |
| `src/renderer/components/review/HierarchicalPivotView.tsx` | Remove `handleCmdL` |
| `src/renderer/pages/PivotPage.tsx` | Pass group info, remove CreateRuleModal, update hints |

---

## Edge Cases

| Case | Handling |
|---|---|
| All candidates covered by higher-priority rules | Rule still created; warning shows "0 will be updated" — user confirms or cancels |
| No transactions match conditions | Error: "No matching transactions found" — rule not created |
| No group selected (ungrouped) | Rule name falls back to taxonomy leaf node name |
| Undo | `changelogId` returned from `createAndApplyRule`, pushed to undo stack |
| Rules change between preview and confirm | `createAndApplyRule` re-evaluates internally — always correct |

---

## Architecture Compliance

Validated against the 9 invariants:

- **DI Container** — no new services; methods added to existing `RuleStore` which has
  `this.transactions` injected via constructor.
- **IPC Contract** — new channel added to `IPCInvokeMap`; existing channel return type
  extended; handler uses `registerHandler`; renderer uses typed `ipc` client.
- **DuckDB safety** — `evaluateRules` + `updateTransactions` called sequentially.
- **Virtual dims** — `ConflictRow` uses rule name (from `override_rules` table), not
  classification path. No taxonomy JOIN needed for preview.
- **Interface discipline** — new method + updated return type added to `RuleStore`
  interface in `services.ts` before handler is written.
- **Service delegation** — `previewRuleConflicts` composes `evaluateRules()` +
  `listAllRules()`, no new SQL. Modified `createAndApplyRule` reuses `evaluateRules()`
  and `getIdsByGroupedConditions()`.
