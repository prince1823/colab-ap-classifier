## Summary

Implement the Changelog service for tracking all changes to transaction classifications and supporting revert operations.

## Scope

### Service (`src/main/services/changelog.ts`)

**Operations:**
- `listChanges(): Promise<ChangeLog[]>` — all entries sorted by created_at desc
- `logChange(entry: Omit<ChangeLog, 'id' | 'createdAt'>): Promise<string>` — create new changelog entry, return id
- `revertChange(changeId: string): Promise<void>` — revert a change:
  1. Read the original change entry
  2. Apply `old_values` to the affected rows in the affected table
  3. Create a NEW changelog entry documenting the revert (source='manual', description='Reverted: ...')
  4. Never delete existing changelog entries

**Change Entry Structure:**
```typescript
interface ChangeLog {
  id: string;
  source: 'manual' | 'pipeline';
  affectedTable: string;     // e.g., 'transactions'
  affectedIds: string[];     // row IDs that changed
  affectedCount: number;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  description: string | null;
  createdAt: string;
}
```

**Integration Points:**
- Reclassification (S1-21) calls `logChange()` for manual corrections
- Classification pipeline (S1-20) calls `logChange()` for pipeline runs (single summary entry)
- Revert creates a new entry, never deletes

### IPC Handlers (`src/main/ipc/changelog.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `changelog:list` | none | `ChangeLog[]` |
| `changelog:revert` | `changeId: string` | `void` |

### Tests
- Log a change → appears in list
- Revert a change → affected rows restored, new entry created
- Multiple changes → list in reverse chronological order
- Revert of revert → creates yet another entry

### Acceptance Criteria
- [ ] Both IPC handlers work
- [ ] Changes logged with old/new values
- [ ] Revert restores original values correctly
- [ ] Revert creates new changelog entry (never deletes)
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-03** (IPC Infrastructure) — handler registration

## Spec References
- `internal_docs/ipc_contract.md` — Changelog section (channels 42-43)
- `internal_docs/schema.md` — change_log table
- `internal_docs/features.md` — Version History section

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/services/changelog.ts`
- `src/main/ipc/changelog.ts`
- `tests/unit/services/changelog.test.ts`

**No deviations.** Both IPC handlers work, changes logged with old/new values, revert restores original values, revert creates new changelog entry (never deletes).
