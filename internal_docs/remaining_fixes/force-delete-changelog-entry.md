# Force Delete: Changelog Entry for Deleted Transactions

## Problem

When an upload is force-deleted (classified rows), orphaned `change_log` entries remain with `is_reverted = FALSE` but point to transaction IDs that no longer exist. These entries are invisible in the rule deactivation modal (filtered out) but appear stale in the version history page.

## Proposed Fix: Option A — Single informational changelog entry

Before deleting, insert one `change_log` row that records the deletion:

- `source = 'manual'`
- `affected_table = 'transactions'`
- `affected_ids = [all deleted tx IDs]`
- `description = "Deleted upload: filename.csv (N rows)"`
- `old_values = null` (or snapshot of classification_status/taxonomy_node_id per row if auditability is desired)
- `new_values = null`
- `is_reverted = FALSE` (permanent — not revertible)

This gives the version history a readable record of what happened without adding complexity to the revert flow. The entry is informational only — no revert button should be shown for it.

## What to skip

Do NOT mark existing changelog entries for those transactions as `is_reverted = TRUE` (Option B). That would misrepresent the history — the rule didn't get reverted, the data was deleted.

## Files to change

- `src/main/services/ingest.ts` — `deleteUpload()`: insert the changelog entry before the DELETE, only when `force = true`
- `src/main/services/changelog.ts` — may need a `recordDeletion()` helper, or insert directly via db in ingest
- `src/renderer/` — version history page may need to handle `source = 'manual'` + null old/new values gracefully (no revert button)
