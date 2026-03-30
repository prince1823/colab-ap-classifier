# Virtual Column Registry & supplier_name Cleanup (#318)

> **Scope:** This spec covers the virtual column registry and filtering `supplier_name` from classification column_priorities. The `parent_name` virtual column question (#355) is tracked separately in `parent-name-virtual-column.md`.

## Problem Summary

Two related issues stem from a single architectural gap: **the system has no formal concept of "virtual columns"** — columns that don't exist on the `transactions` table but are resolved via JOINs.

### Bug 1: `supplier_name` leaks into `column_priorities` (#318)

**What happens:** On every CSV import, `DataView.tsx:123-127` saves all mapped canonical columns (including `supplier_name`) into `column_priorities`. This means `supplier_name` ends up in the list that drives Call 2 dedup grouping and the LLM prompt.

**Why it's wrong:** In the two-call classification design, supplier name goes to Call 1 as a direct parameter (supplier research + L1/L2 narrowing). Call 2 receives per-supplier transaction data grouped by `column_priorities` — supplier name is constant across all transactions for a given supplier, so it adds noise without information.

**Current workarounds:**
- `rules.ts:353` has `const VIRTUAL_COLS = new Set(['supplier_name'])` to filter it out of rule generation
- `classification.ts:363` manually sets `cleaned.supplier_name = supplier.supplier_name` on each txn before dedup — this is the FK-resolved name being injected back onto the row object

**Downstream impact:**
- `extractFields()` in `dedup-groups.ts:28-32` will include `supplier_name` in every group's fields, wasting LLM tokens and creating misleading group keys (every group within a supplier will have the same supplier_name field)
- `classification.ts:165-176` validates that every column_priority exists in `getColumns()` — `supplier_name` passes because `getColumns()` appends virtual columns. But this validation is checking the wrong thing: it should be checking whether the column is *physical* (available for dedup), not just queryable.

### Bug 2: No systematic virtual column registry

Each consumer independently handles the physical-vs-virtual distinction:
- `transactions.ts:33-41` — `VIRTUAL_COLUMNS` dict for query resolution
- `transactions.ts:48-57` — `FILTER_VIRTUAL_EXPRS` dict for filter queries
- `rules.ts:353` — `VIRTUAL_COLS` set for rule generation
- `export.ts:99-108` — hardcoded header list with virtual columns appended
- `supplier-service.ts:281-292` — `SUPPLIER_COLUMNS` dict for supplier queries
- `classification.ts:363` — manual injection of `supplier_name` onto row objects

There is no single source of truth. Each new feature must independently remember which columns are virtual, and bugs occur when one is missed.

---

## Why `supplier_name` must be excluded from column_priorities

`supplier_name` is a **required canonical column** — the user always maps a CSV column to it. But unlike every other canonical column, it doesn't end up as a physical column on `transactions`. Here's the full flow:

1. User maps CSV "Vendor" → canonical `supplier_name`
2. `ingest.ts:344` silently remaps: `supplier_name` → `original_supplier_name` at the SQL level
3. The physical column stored on transactions is `original_supplier_name` (raw CSV value, audit trail)
4. Supplier normalization creates a `project_suppliers` row with a cleaned `supplier_name`
5. Transactions get a FK (`project_supplier_id`) pointing to the supplier row
6. The canonical `supplier_name` is resolved at query time via `LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id`

**The problem:** `column_priorities` saves `supplier_name` (the canonical name from mapping step 1). But when classification runs and reads transaction rows from DB, there is no physical `supplier_name` column — the row has `original_supplier_name` instead. Currently `classification.ts:363` papers over this by manually injecting `supplier_name` back onto each row object. This is fragile: it only works for the tail-spend path, and it means dedup groups include a field that's constant per supplier (wasted tokens).

**The fix:** Never put `supplier_name` into `column_priorities` in the first place. The classification runner already receives the supplier name as a direct parameter for each supplier batch — it doesn't need it repeated on every transaction row.

**The general rule:** Virtual columns can never legitimately appear in column_priorities. They don't exist on the transaction rows that `extractFields()` reads — any virtual column in priorities is silently absent from dedup groups anyway (the value would be undefined, filtered out by `extractFields`). The right fix is to prevent them from entering priorities at all, not to paper over the absence at read time.

### Will we keep running into issues from the `supplier_name` → `original_supplier_name` switcheroo?

**Short answer: not after the registry.** The remap itself is fine — it correctly preserves the raw CSV value while the normalized name lives on `project_suppliers`. The bugs all stem from consumers not knowing that `supplier_name` is virtual. Once the registry exists:

- `DataView.tsx` won't save it to `column_priorities` → no leak into dedup/LLM
- `classification.ts` will strip it from priorities before validation → no false validation errors
- `rules.ts` will use the registry instead of a local hardcoded set → no drift
- `extractFields()` will never see it in priorities → no wasted tokens
- The manual injection in `classification.ts:363` can be removed → no fragile workaround

The `original_supplier_name` remap in `ingest.ts` stays as-is. It's correct and well-documented. The registry just makes the virtual nature of `supplier_name` visible to every consumer.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | `parent_name` canonical column handling | Separate spec (`parent-name-virtual-column.md`) |
| 2 | Registry location | `src/shared/virtual-columns.ts` — pure data, importable by both main and renderer |
| 3 | Existing projects with `supplier_name` in priorities | Don't care — just filter at classification time as a safety net, no migration |
| 4 | Show `original_supplier_name` in review UI? | No |
| 5 | `VIRTUAL_COLS` in rules.ts | Replace with `VIRTUAL_COLUMN_NAMES` from registry (not delete — the filter IS needed to prevent `t."supplier_name"` queries against a non-existent physical column) |

---

## Solution

### Part 1: Formal Virtual Column Registry (`src/shared/virtual-columns.ts`)

```typescript
export interface VirtualColumnDef {
  /** SQL expression when this column appears in a SELECT */
  selectExpr: string;
  /** The JOIN clause required to resolve this column */
  requiredJoin: 'supplier' | 'taxonomy' | 'rules' | 'supplier_parent';
}

export const VIRTUAL_COLUMN_REGISTRY: Record<string, VirtualColumnDef> = {
  supplier_name:       { selectExpr: 'ps.supplier_name',                         requiredJoin: 'supplier'        },
  is_tail_spend:       { selectExpr: 'ps.is_tail_spend',                         requiredJoin: 'supplier'        },
  parent_name:         { selectExpr: 'sp.name',                                  requiredJoin: 'supplier_parent' },
  classification_l1:   { selectExpr: 'tax.l1',                                   requiredJoin: 'taxonomy'        },
  classification_l2:   { selectExpr: 'tax.l2',                                   requiredJoin: 'taxonomy'        },
  classification_l3:   { selectExpr: 'tax.l3',                                   requiredJoin: 'taxonomy'        },
  classification_path: { selectExpr: "CONCAT_WS(' > ', tax.l1, tax.l2, tax.l3)", requiredJoin: 'taxonomy'        },
  applied_rule_name:   { selectExpr: 'ar.name',                                  requiredJoin: 'rules'           },
};

/**
 * Set of all virtual column names — resolved via JOINs, not physically stored on transactions.
 *
 * Virtual columns must never appear in column_priorities. They have no physical presence
 * on transaction rows, so extractFields() would silently skip them even if listed.
 * Filter these out at every write path for column_priorities, and strip defensively at
 * read time in the classification runner.
 */
export const VIRTUAL_COLUMN_NAMES = new Set(Object.keys(VIRTUAL_COLUMN_REGISTRY));
```

`excludeFromClassification` is intentionally absent from `VirtualColumnDef`. Being virtual *is* the reason a column can't be in column_priorities — there's no case where a JOIN-resolved column should appear in dedup grouping. `VIRTUAL_COLUMN_NAMES` is the single check for both query-building and priority filtering.

### Part 2: Filter virtual columns from column_priorities at BOTH save paths

There are two places in `DataView.tsx` where column_priorities get saved — both need the filter.

**Path A — initial save after import (`DataView.tsx` line 123-127):**
```typescript
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';

const mappedCols = rows.filter((r) => r.csvColumn).map((r) => r.canonical)
                       .filter((c) => !VIRTUAL_COLUMN_NAMES.has(c));
```

**Path B — manual reorder in DataPriorityStep (`DataView.tsx` line 159-162):**

The user can drag columns in the priority step UI. If `supplier_name` somehow appears in the
LLM list (e.g. from a pre-existing project), the user could drag it back in.

```typescript
const handleSavePriorities = async (llmOrder: string[], _nonLlm: string[]) => {
  const filtered = llmOrder.filter((c) => !VIRTUAL_COLUMN_NAMES.has(c));
  await ipc.project.setSetting('column_priorities', filtered);
  ...
```

This gives three layers of defense: write-time filter (initial import), write-time filter (manual reorder), and the read-time strip in classification.ts as the final safety net.

### Part 3: Strip virtual columns in classification runner (safety net)

**In `classification.ts` (~line 165-176):**
```typescript
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';

// Strip any virtual columns that leaked into priorities (defensive — virtual columns
// have no physical presence on transaction rows and cannot contribute to dedup groups)
const effectivePriorities = columnPriorities.filter(col => !VIRTUAL_COLUMN_NAMES.has(col));

// Validate remaining against available columns
const availableColumns = await this.transactions.getColumns();
const invalidColumns = effectivePriorities.filter(col => !availableColumns.includes(col));
```

Note: `getColumns()` already includes virtual columns, but since we've stripped them from `effectivePriorities`, the validation now only checks physical columns. No need for a separate `getPhysicalColumns()` method.

### Part 4: Replace scattered virtual column definitions

**`transactions.ts`** — derive `VIRTUAL_COLUMNS` from registry:
```typescript
import { VIRTUAL_COLUMN_REGISTRY, VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';

const VIRTUAL_COLUMNS: Record<string, string> = Object.fromEntries(
  Object.entries(VIRTUAL_COLUMN_REGISTRY).map(([name, def]) => [name, def.selectExpr])
);
```

Keep `FILTER_VIRTUAL_EXPRS` (line 48) as-is — it has different expressions for some columns like `classification_path` with COALESCE. But add a comment referencing the registry.

Also deduplicate `FILTER_VIRTUAL_DIMS` inside `buildFilterSQL()` (line 123) — this is a **third copy** of the same virtual mapping that's identical to `FILTER_VIRTUAL_EXPRS`. Replace it with a reference to `FILTER_VIRTUAL_EXPRS`:
```typescript
// was: const FILTER_VIRTUAL_DIMS: Record<string, string> = { ... duplicated map ... };
const resolver = (field: string) => FILTER_VIRTUAL_EXPRS[field] ?? `t."${field}"`;
```

**`rules.ts`** — replace local `VIRTUAL_COLS`:
```typescript
import { VIRTUAL_COLUMN_NAMES } from '../../shared/virtual-columns';

// was: const VIRTUAL_COLS = new Set(['supplier_name']);
const validPriorities = columnPriorities.filter(col =>
  availableColumns.includes(col) && !VIRTUAL_COLUMN_NAMES.has(col)
);
```

**`export.ts`** — add comment referencing registry. The export header list is intentionally explicit (not all virtual columns appear in export), so keep the hardcoded list but add a note.

### Part 5: Remove manual supplier_name injection (both classification paths)

The `supplier_name` injection exists in **two** places — both must be removed:

**Path A — non-tail-spend (`classifySupplierTransactions`, line 531):**
```typescript
const cleanedTxns = txnRows.map((txn) => {
  const cleaned = { ...txn };
  // ...
  if (supplierName) cleaned.supplier_name = supplierName;  // ← remove this line
  return cleaned;
});
```
The supplier name is already passed separately to the classification agent via `supplierName` / `supplierResearch` parameters.

**Path B — tail-spend (line 363):**
```typescript
const cleanedTxns = txns.map((txn) => {
  const cleaned = { ...txn };
  // ...
  cleaned.supplier_name = supplier.supplier_name;  // ← remove this line
  return cleaned;
});
```
The supplier name is already passed separately to `classifyL3ForTailSpend()` as `name: e.supplier.supplier_name` (line 419).

With `supplier_name` filtered from column_priorities, `extractFields()` and `buildDedupGroups()` will never look for it on the row in either path. Both injections become dead code once the priority filter is in place.

---

## Implementation Order

1. **Create `src/shared/virtual-columns.ts`** with registry and `VIRTUAL_COLUMN_NAMES`
2. **Update `src/renderer/views/DataView.tsx`** — filter `VIRTUAL_COLUMN_NAMES` from column_priorities at both save paths (initial import + manual reorder)
3. **Update `src/main/services/classification.ts`** — strip virtual cols from priorities before validation; remove manual `supplier_name` injection on both paths (non-tail-spend line 531 + tail-spend line 363)
4. **Update `src/main/services/transactions.ts`** — derive `VIRTUAL_COLUMNS` from registry; deduplicate `FILTER_VIRTUAL_DIMS` inside `buildFilterSQL()` to reference `FILTER_VIRTUAL_EXPRS`
5. **Update `src/main/services/rules.ts`** — replace local `VIRTUAL_COLS` with `VIRTUAL_COLUMN_NAMES` import
6. **Update `src/main/services/export.ts`** — add reference comment to registry

---

## Files Changed

| File | Change |
|------|--------|
| `src/shared/virtual-columns.ts` | **NEW** — Virtual column registry + `VIRTUAL_COLUMN_NAMES` |
| `src/main/services/transactions.ts` | Derive `VIRTUAL_COLUMNS` from registry; deduplicate `FILTER_VIRTUAL_DIMS` in `buildFilterSQL()` |
| `src/main/services/classification.ts` | Strip virtual cols from priorities; remove `supplier_name` injection on both paths (line 531 + line 363) |
| `src/main/services/rules.ts` | Replace local `VIRTUAL_COLS` with `VIRTUAL_COLUMN_NAMES` import |
| `src/main/services/export.ts` | Add reference comment |
| `src/renderer/views/DataView.tsx` | Filter `VIRTUAL_COLUMN_NAMES` at both save paths (import + manual reorder) |
