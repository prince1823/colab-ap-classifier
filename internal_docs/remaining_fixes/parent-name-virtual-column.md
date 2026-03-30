# Parent Name Virtual Column Guard (#355)

> **Prerequisite:** Virtual column registry from `supplier-name-and-virtual-columns.md` is already implemented. `parent_name` is registered as a virtual column in `VIRTUAL_COLUMN_REGISTRY`.

## Problem

If a user's CSV has a `parent_name` column, it can be imported as a physical column on `transactions`, creating a name collision with the virtual `parent_name` resolved via `LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id`.

**In export (`export.ts:124`):** `SELECT t.*, sp.name as parent_name` — the explicit JOIN alias silently overwrites whatever is in `t.parent_name`. The user's original CSV value is lost.

**In review/supplier pages:** `parent_name` is always the FK-resolved value. Physical `parent_name` on transactions is invisible everywhere.

## Decision: Option 2 — virtual takes precedence, user's column is guarded out

`parent_name` is a **supplier-level attribute**, not a transaction-level attribute. A CSV row is a transaction — it has one supplier, one amount, one date. Parent company is a property of the *supplier*, managed in the normalization layer, not per-transaction row data.

Accepting a user's `parent_name` column to seed the parents table (Option 1) would require:
- Deduplication: same supplier, potentially different parent values across rows
- Conflict resolution: which row's value wins?
- Creation of `supplier_parents` rows and FK assignment at import time

This is the wrong layer. **Issue #308 (bulk normalization CSV upload/download)** is the correct mechanism for setting parent assignments in bulk. Users who have parent data in their CSV should use 308's flow to import those assignments properly, with full control and conflict visibility.

`parent_name` is exclusively a virtual column. If a user's CSV happens to have a column by that name, the app guards it at the point of import.

## Fix

### Part 1: Block `parent_name` as a physical column in `ingest.ts`

`parent_name` is not in `canonical-columns.ts` — the LLM mapping agent and the UI will never suggest it as a mapping target. However, a user could manually type `parent_name` as a custom canonical name in the mapping UI. The guard must sit in `importCSV`.

Extend the `dbColumn()` remap in `ingest.ts` to cover all virtual column names:

```typescript
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';

// Remap virtual column names to original_* so they never shadow JOIN-resolved columns.
// supplier_name → original_supplier_name is the primary case (required canonical).
// Other virtual names (e.g. parent_name) guard against manual misuse.
const dbColumn = (canonical: string): string => {
  if (VIRTUAL_COLUMN_NAMES.has(canonical)) return `original_${canonical}`;
  return canonical;
};
```

This replaces the current hardcoded:
```typescript
const dbColumn = (canonical: string) =>
  canonical === 'supplier_name' ? 'original_supplier_name' : canonical;
```

**Effect:** If a user maps their CSV "Parent Company" column to the canonical name `parent_name`, it is stored as `original_parent_name` on transactions — never as `parent_name`. The virtual column is unaffected. The raw CSV value is preserved for audit purposes.

### Part 2: No change to `canonical-columns.ts`

`parent_name` is not added as an optional canonical column. It is not a transaction field. The LLM mapping agent will never propose it; the UI priority step will never list it.

### Part 3: No change to export

`export.ts` already does `sp.name as parent_name` via JOIN. With Part 1 in place, there is no physical `parent_name` column on `transactions` to collide with. The `t.*` in the SELECT will never include `parent_name`, so the alias is unambiguous.

### Part 4: Note in UI (optional, deferred)

If/when issue #308 ships, the supplier normalization panel can surface a note: "Have parent company data in your CSV? Use the bulk normalization upload to assign parents." Not blocking this fix.

---

## Files Changed

| File | Change |
|------|--------|
| `src/main/services/ingest.ts` | Generalize `dbColumn()` remap to cover all `VIRTUAL_COLUMN_NAMES` |

---

## What this does NOT do

- Does not seed `supplier_parents` from CSV import — use issue #308 for that
- Does not add `parent_name` as a canonical column
- Does not surface `original_parent_name` in the UI — it's an audit trail only, same as `original_supplier_name`
