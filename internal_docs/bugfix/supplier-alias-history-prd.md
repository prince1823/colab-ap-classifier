# PRD: Supplier Alias Table for New Projects

## Summary

Supplier identity should survive upload/delete/re-upload workflows without relying on transaction rows as the only alias history. For new `.c91` projects, add a durable alias table that maps every known supplier alias to exactly one `project_supplier_id`.

This is intentionally scoped to new projects going forward. We will not backfill old `.c91` files, repair existing orphan states, or support complicated merge recovery in this phase.

The alias table is not a replacement for the existing transaction foreign-key model. Runtime supplier views, supplier detail pages, classification, rules, export, research, and aggregate queries should continue to use `transactions.project_supplier_id` joined to `project_suppliers`. The alias table exists only to improve supplier resolution during data import after transaction rows have been deleted.

## Problem

Today, aliases are inferred from transactions:

```sql
transactions.original_supplier_name + transactions.project_supplier_id
```

When an upload is deleted, those transaction rows disappear. The `project_suppliers` row may remain because it stores expensive state such as research, parent assignment, taxonomy hints, and Cat A flags, but the raw-name alias evidence disappears.

That creates a bug in this workflow:

```text
1. Import transactions.
2. Normalize/rename suppliers.
3. Delete or replace uploads.
4. Re-import similar data.
```

The importer may create or reuse a cleaned supplier name instead of reusing the previously normalized/researched supplier row.

Example:

```text
raw alias:       "access display group, inc."
cleaned name:   "access display group"
user canonical: "access display group, inc."
```

If alias history is only stored in deleted transactions, future imports cannot reliably know that `"access display group, inc."` should still belong to the researched supplier row.

## Goals

- Add durable alias ownership for new `.c91` projects.
- Guarantee one alias maps to exactly one `project_supplier_id`.
- Reuse existing supplier identity before creating or linking to a cleaned-name supplier.
- Preserve user-chosen canonical names across re-imports.
- Keep implementation simple: no backfill, no old-project cleanup, no automatic merge recovery.
- Ensure each raw/original supplier name is recorded as an alias for the resolved supplier.

## Non-Goals

- No migration/backfill for existing `.c91` files.
- No repair flow for current orphan suppliers.
- No metadata-preserving merge system in this phase.
- No support for users applying drastically wrong supplier mappings and expecting automatic recovery.
- No supplier universe sync for aliases.
- No replacement of existing `transactions.project_supplier_id` query paths.
- No separate alias management or export UI in this phase.

## Data Model

For newly created projects, create:

```sql
CREATE TABLE IF NOT EXISTS project_supplier_aliases (
  id VARCHAR PRIMARY KEY,
  project_supplier_id VARCHAR NOT NULL,
  alias VARCHAR NOT NULL,
  alias_key VARCHAR NOT NULL UNIQUE,
  source VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`alias_key` is a normalized lookup key:

```text
lower(trim(collapse_internal_whitespace(alias)))
```

The unique constraint on `alias_key` enforces:

```text
one alias -> one project_supplier_id
```

Suggested `source` values:

```text
raw_import
csv_apply
manual
```

## Import Behavior

When importing a transaction supplier name:

```text
rawName = transactions.original_supplier_name
cleanedName = cleanSupplierName(rawName)
```

Resolve supplier identity in this order:

```text
1. Look up rawName alias_key in project_supplier_aliases.
   - If found, use that project_supplier_id.
   - Update last_seen_at.

2. Look up project_suppliers.supplier_name = cleanedName.
   - If found, use that project_supplier_id.
   - Insert rawName alias -> supplier.

3. Otherwise create project_suppliers row with supplier_name = cleanedName.
   - Insert rawName alias -> new supplier.
```

The cleaned name is the supplier's canonical `project_suppliers.supplier_name`, not another alias entry. The alias table is for raw/original supplier names that appear in transaction CSVs.

Example:

```text
rawName:     "access display group, inc."
cleanedName: "access display group"
supplier_id: sup_123
```

Alias table after import:

```text
"access display group, inc." -> sup_123  source=raw_import
```

## Normalize CSV Apply Behavior

CSV contract remains:

```csv
parent_name,supplier_name,alias,total_spend,transaction_count,created_at
```

Meaning:

```text
alias = raw/original supplier name
supplier_name = desired canonical supplier name
```

Apply behavior:

```text
1. Look up alias in project_supplier_aliases.
2. If found, use that project_supplier_id.
3. Rename that project supplier to CSV supplier_name.
4. Upsert alias -> project_supplier_id with source=csv_apply.
```

If the CSV alias does not exist in `project_supplier_aliases`, this phase should not try to infer or recover aggressively. It should fail or show an explicit warning that the alias is unknown.

If CSV apply attempts to assign an alias that already belongs to a different supplier, reject the apply with a clear error. We are not supporting automatic conflict repair in this phase.

If CSV apply attempts to rename a supplier to a name already used by another supplier, reject the apply with a clear error. The user should start over or correct the source file/project state.

## Why No Merge

Automatic merge is intentionally out of scope. It adds decisions about:

- Which supplier row survives.
- Which research metadata wins.
- Whether existing classifications or parents should move.
- Whether user mistakes should be reversible.

For this phase, correctness comes from preventing the split in new projects, not repairing arbitrary old or incorrect states.

## Delete Behavior

Deleting an upload deletes transaction rows, but it must not delete alias rows.

Alias rows are durable project memory. They preserve the connection:

```text
raw supplier name -> researched project supplier
```

If a supplier itself is explicitly deleted and has no linked transactions, delete its aliases as part of the same explicit supplier deletion after confirming with the user. Alias ownership alone should not block deletion.

If a supplier has linked transactions, deletion should be blocked until the user reassigns or removes those transactions through an explicit workflow. The app should not silently leave transactions without a supplier.

## New Project Only

This feature applies to newly created `.c91` files after the schema change.

Existing `.c91` files do not need backfill and should not get an empty compatibility table on open. Supporting old projects would create a second behavior path that is not needed long term. Acceptance criteria are only for projects created after this schema change.

## Supplier UI Scope

The existing Supplier page remains the source of user-facing supplier management. The new alias table is an internal import-resolution aid.

Do not add a separate alias debugging export or alias-management page in this phase. Users should continue correcting supplier names, aliases, and bad groupings through the Supplier/Normalize workflows that already operate on project suppliers and transaction-linked aliases.

Implementation must preserve existing transaction-linked behavior:

```text
transactions.project_supplier_id -> project_suppliers.id
```

The alias table should only answer this import-time question:

```text
Have we seen this raw supplier name before, and which project_supplier_id should new rows link to?
```

## Existing UI Remedy

If a supplier assignment is wrong, users should continue using the existing Normalize view controls:

1. If one raw alias is under the wrong supplier, use Reassign Alias.
   - In the Aliases column, click the reassign icon on the alias, or select the alias and use `Shift + R`.
   - Choose the correct supplier.
   - This updates matching transaction rows by `transactions.original_supplier_name`.
2. If two supplier rows represent the same supplier, use Merge.
   - Select both supplier rows.
   - Use Merge and choose the surviving supplier name.
   - This updates transactions from the losing supplier IDs to the survivor.
3. If the supplier identity is right but the displayed name is wrong, rename the supplier instead of deleting it.

The alias table should not change these UI workflows. It should be updated behind the scenes so future imports remember the same raw alias ownership.

## Acceptance Criteria

- New projects include `project_supplier_aliases`.
- Import records raw/original supplier names in `project_supplier_aliases`.
- `alias_key` is unique, so an alias cannot belong to two suppliers.
- Import resolves supplier identity using raw alias first, then cleaned supplier name, then create.
- Deleting uploads does not remove alias rows.
- Re-importing the same raw supplier after upload deletion links to the same `project_supplier_id`.
- Normalize CSV apply renames the supplier that owns the CSV alias.
- Normalize CSV apply upserts CSV `alias` for that supplier.
- Unknown or conflicting CSV aliases fail clearly instead of guessing.
- Target supplier-name collisions fail clearly instead of merging.
- Existing supplier list, detail, classification, rules, export, and research paths continue to use `transactions.project_supplier_id` and are not rewritten to depend on the alias table.

## Test Plan

Add tests for:

- New project schema includes `project_supplier_aliases`.
- Import inserts raw/original alias for each supplier.
- Import reuses raw alias owner before cleaned-name lookup.
- Import reuses existing cleaned supplier name when raw alias is new and no alias owner exists.
- Upload deletion leaves alias rows intact.
- Re-import after deletion links to the original supplier id.
- CSV apply renames alias owner and records the CSV alias ownership.
- CSV apply rejects alias ownership conflicts.
- CSV apply rejects target-name collisions.
- Existing supplier listing still derives aliases/spend from `transactions.original_supplier_name` and `transactions.project_supplier_id`.
- Existing classification/rules/export paths still join through `transactions.project_supplier_id`, not `project_supplier_aliases`.
- Deleting an upload removes transaction rows but leaves alias rows intact for future import resolution.
- Opening an old `.c91` file without `project_supplier_aliases` does not attempt compatibility backfill behavior.

## Supplier Deletion Behavior

Alias ownership alone should not block supplier deletion. If a supplier has no linked transactions, deleting it should also delete its alias rows after confirming with the user:

```text
Deleting this supplier will also remove remembered aliases. If the same raw names are imported again, the app will normalize them as new suppliers.
```

If a supplier has linked transactions, deletion should not silently leave transactions with no supplier. The user should be guided to one of these remedies:

1. Reassign the supplier's aliases/transactions to the correct existing supplier.
2. Rename the current supplier if the supplier identity is right but the name is wrong.
3. Delete the upload if all associated transactions are wrong and should be removed.

Only after transactions are no longer linked to that supplier should supplier deletion proceed and remove the supplier's alias rows.
