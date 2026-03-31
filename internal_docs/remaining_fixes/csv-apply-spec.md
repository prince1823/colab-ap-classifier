# CSV Apply — Action Spec

The CSV apply flow takes a downloaded supplier CSV (edited offline) and reconciles it
against the current project DB. Identity matching is alias-based: a CSV row is linked to
a DB supplier by which `original_supplier_name` values (aliases) they share.

---

## Algorithm Overview

The diff engine iterates **per CSV row**, not per alias or per supplier. Each row expresses
a single intent: "I want a supplier named X, with these aliases, under this parent." The
engine works out what DB operations are needed to match that intent.

**Phase 1 — Snapshot DB state**
Build lookup maps from DuckDB:
- `dbAliasToSupplier`: `original_supplier_name` → `{ supplierId, supplierName, parentId, parentName }`
- `dbSupplierAliases`: `supplierId` → `Set<alias>` (all raw names linked to that supplier)
- `dbSupplierNames`: `supplierId` → current canonical name
- `dbSupplierSpend`: `supplierId` → alias count (proxy for spend/importance)
- `dbParentsByName`: lowercase parent name → `{ id, name }`

**Phase 2 — Validate CSV**
- Reject duplicate aliases within the CSV (same raw name listed under two rows)
- Flag unknown aliases (not in `dbAliasToSupplier`) as warnings
- Build `csvAliasToRowIndex`: alias → CSV row index (for all known aliases only)

**Phase 3 — Match rows to DB suppliers**
For each CSV row, scan its aliases against `dbAliasToSupplier`. Collect the set of DB
supplier IDs that own any of those aliases:
- **Empty set** → unmatchable row warning
- **One ID** → direct match (rename / parent change candidate)
- **Multiple IDs** → merge (aliases currently belong to different DB suppliers)

Aliases absent from the CSV are **never visited** — the DB is only mutated for things
explicitly mentioned in the CSV.

**Phase 4 — Compute per-match operations**
For each matched row, compute:
- **Survivor** (for merges): prefer name-exact match to CSV name; otherwise pick by alias count
- **Merge**: if multiple DB suppliers matched, losers are absorbed by survivor
- **Rename**: survivor's current name ≠ CSV `supplierName`
- **Alias reassignment**: for each alias in the CSV row, check if its current DB owner
  (post-merge effective owner) equals the intended survivor. Mismatch → reassignment.
- **Parent change**: `row.parentName` ≠ survivor's current parent name

**Phase 5 — Compute parent operations (second pass)**
Aggregate `csvParentToDbParents`: CSV parent name → set of DB parent IDs currently
assigned to suppliers touched by this CSV. Determines parent creation / rename / merge.

**Apply order (to avoid FK violations)**
1. Create new parents → 2. Rename parents → 3. Merge parents →
4. Merge suppliers → 5. Rename suppliers → 6. Reassign aliases →
7. Assign/change parent on suppliers

---

## Supplier Actions

### 1. Rename
**Scenario:** A CSV row matches exactly one DB supplier (via shared aliases), but the
`supplier_name` in the CSV differs from the DB canonical name.

**Detection:** `csvRowSurvivor` maps to one DB supplier; `dbSupplierNames.get(survivorId) !== row.supplierName`.

**Apply:** `UPDATE project_suppliers SET supplier_name = ? WHERE id = ?`

**Status:** ✅ Implemented

---

### 2. Merge
**Scenario:** A CSV row's aliases match more than one DB supplier — meaning the user has
collapsed what were separate suppliers into one row.

**Detection:** Multiple distinct `supplierId` values collected from the row's known aliases.

**Survivor selection:** Prefer the DB supplier whose name already matches the CSV name;
otherwise pick the one with the most aliases (highest alias count as a spend proxy).

**Apply:** Reassign all transactions from losers to survivor, then delete loser rows from
`project_suppliers`.

**Status:** ✅ Implemented

---

### 3. Alias reassignment (move alias from supplier A → supplier B)
**Scenario:** Alias X currently maps to supplier A in the DB. In the CSV, alias X appears
under supplier B's row instead.

**Detection:** For each alias in `csvAliasToRowIndex`, compare its current DB owner
(post-merge effective owner) against the CSV row's `csvRowSurvivor`. Mismatch → reassignment.

**Apply:** `UPDATE transactions SET project_supplier_id = ? WHERE original_supplier_name = ?`
(sets all transactions with that raw name to the new supplier).

**Status:** ✅ Implemented

---

## Parent Actions

### 4. Parent creation
**Scenario:** A CSV row references a `parent_name` that has no match in `supplier_parents`
(case-insensitive) and none of the affected DB suppliers currently have that parent.

**Detection:** `csvParentToDbParents` entry has `dbParentIds.size === 0` and no existing
parent by that name.

**Apply:** `INSERT INTO supplier_parents`, then assign the new ID in step 7.

**Status:** ✅ Implemented

---

### 5. Parent rename
**Scenario:** All suppliers that shared a DB parent now list a different parent name in
the CSV — the intent is to rename the parent, not create a new one.

**Detection:** `csvParentToDbParents` entry has exactly one DB parent ID and no existing
parent already matches the CSV name → rename that single DB parent.

**Apply:** `UPDATE supplier_parents SET name = ? WHERE id = ?`

**Status:** ✅ Implemented

---

### 6. Parent merge
**Scenario:** Multiple distinct DB parents all map to the same CSV parent name — meaning
the user has unified them under one name.

**Detection:** `csvParentToDbParents` entry has more than one DB parent ID.

**Survivor selection:** Prefer an existing DB parent whose name already matches the CSV
name; otherwise pick the first in the set.

**Apply:** Reassign all `project_suppliers.parent_supplier_id` from losers to survivor,
delete loser rows. Then rename survivor if its name doesn't match CSV name.

**Status:** ✅ Implemented

---

### 7. Parent assignment change
**Scenario:** A supplier's `parent_name` in the CSV differs from what the DB currently
has. Covers: assigning a parent for the first time, switching to a different parent, or
removing a parent (CSV row has blank `parent_name`).

**Detection:** For each `csvRowSurvivor`, compare `row.parentName` against
`currentInfo.parentName`. Any mismatch (including null ↔ non-null) → parent change.

**Apply:** Resolve the CSV parent name to a DB ID (including newly created parents from
step 1), then `UPDATE project_suppliers SET parent_supplier_id = ? WHERE id = ?`.
If `newParentName` is blank, sets `parent_supplier_id = NULL`.

**Status:** ✅ Implemented

---

## Warnings (non-destructive, no DB write)

### 8. Unknown alias
**Scenario:** An alias listed in the CSV doesn't appear in any transaction's
`original_supplier_name` — it's not a known raw name in this project.

**Detection:** `!dbAliasToSupplier.has(alias)` during CSV validation pass.

**Shown as:** Warning — "Alias X in supplier Y not found in project."

**Status:** ✅ Implemented

---

### 9. Unmatchable row
**Scenario:** A CSV row either has an empty supplier name, or has aliases but none of
them match any DB alias — the row cannot be resolved to any DB supplier.

**Detection:** Row has no aliases, or all aliases are unknown (none in `dbAliasToSupplier`).

**Shown as:** Warning — "Row X: No aliases match existing transactions."

**Status:** ✅ Implemented

---

## Out of scope (explicit non-actions)

- **Alias removal:** Aliases in the DB that are absent from the uploaded CSV are
  intentionally kept. Unlinking aliases would orphan transactions (make them
  unclassifiable, invisible on the suppliers page). Not supported.
- **Supplier deletion:** Removing a supplier row entirely from the CSV has no effect —
  suppliers with no CSV row are simply not visited by the diff engine.
- **New supplier creation:** A CSV row whose aliases are all unknown cannot be matched
  to any DB supplier and is flagged as unmatchable. The CSV apply flow does not create
  new suppliers (use the separate "Import supplier list" flow for that).

---

## Enhancements

### E1. Retained alias warning
**Scenario:** A supplier is matched by the CSV (it has at least one shared alias), but
some of its DB aliases are absent from the CSV row. The user may not realize those
aliases are still linked.

**Planned behaviour:** After building `csvRowSurvivor`, for each matched supplier compare
its post-merge DB alias set against the CSV alias set. Aliases that are in the DB but
absent from the CSV — and not being reassigned elsewhere (not in `csvAliasToRowIndex`)
— are surfaced as a warning.

**Warning message:** "N aliases not in CSV (kept as-is)" with a list of
`alias → supplier name` pairs.

**No DB write.** This is purely informational.

**Status:** 🔲 Planned
