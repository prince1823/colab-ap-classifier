# Remaining Fix: ChangelogStore.revertChange — Toggle vs. Append Semantics

## Failing test

`tests/unit/services/changelog.test.ts > ChangelogStore > revertChange > should revert a change and restore affected rows`

```
AssertionError: expected 1 change(s) to equal 2
```

## What the test expects

After calling `store.revertChange(changeId)`:
1. The affected row in `transactions` is restored to its `oldValues`
2. `store.listChanges()` returns **2 entries** — the original change + a new revert log entry

## What the implementation does

`revertChange` toggles `is_reverted` on the existing row and restores data, but does NOT insert a new changelog row:

```ts
// Revert: restore old values
await this.db.run(`UPDATE ${table} SET ... WHERE id IN (...)`, ...values, ...ids);
await this.db.run('UPDATE change_log SET is_reverted = TRUE WHERE id = ?', changeId);
// ← no INSERT; listChanges() still returns 1 entry
```

The method also supports "un-revert" (calling again on an already-reverted entry re-applies `newValues` and sets `is_reverted = FALSE`), which is toggle behaviour.

## Decision needed

**Option A — Keep toggle, fix the test**
The toggle model is valid: users can flip a change back and forth. The test was written against a different design. Fix the test to check that `is_reverted` becomes true and that the restored value is correct, without expecting a second log row.

```ts
// Updated assertion
const changes = await store.listChanges();
expect(changes).toHaveLength(1);
expect(changes[0].isReverted).toBe(true);
```

**Option B — Switch to append, log the revert as a new entry**
Insert a new `change_log` row with `source = 'revert'` that references the original change. This gives a full audit trail visible in the UI. Requires schema change (add `reverts_change_id` FK or similar) or use the description field to reference the original.

## Recommendation

Option A is simpler and consistent with the existing toggle model. The UI already renders `is_reverted` as a visual indicator. Unless an audit trail of "revert events" is required by a stakeholder, avoid the complexity of Option B.

## Related files

- `src/main/services/changelog.ts` — `revertChange` implementation
- `tests/unit/services/changelog.test.ts` — failing test at line 138
- `src/shared/types/changelog.ts` — `ChangeLog` and `PaginatedChangelog` types
