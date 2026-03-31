# Cat A Supplier System — Design & Decisions

## What is Cat A?

Category A (Cat A) suppliers are suppliers that have been pre-mapped to taxonomy paths by the organisation via the supplier universe. When a project opens and research runs, the app automatically creates override rules for these suppliers based on their mapped paths — no LLM classification needed.

---

## Data model

`category_a_supplier: boolean` lives in three places:

| Location | Purpose |
|---|---|
| `supplier_universe.suppliers` | Source of truth — set externally when the universe is built |
| `project_suppliers` | Per-project copy, synced from universe during research |
| `override_rules` | Marks which rules were created as part of cat A resolution |

`mapped_taxonomy_paths: string[]` on `supplier_universe.suppliers` holds the pre-mapped paths (pipe-delimited strings, e.g. `"Corporate Services|IT|Software"`).

---

## How Cat A rules are created

During `researchAll`, for each supplier with `categoryASupplier: true`:

1. The `mapped_taxonomy_paths` from the universe are fetched alongside research data
2. `resolveCatASupplier` resolves each path against the project's current taxonomy:
   - Exact match on `fullPath` → uses the node directly
   - No exact match → falls back to `LLMCatAAgent` to find the closest node
3. An override rule is created with `source: 'supplier_universe'` and `categoryASupplier: true`
4. The project supplier is flagged `categoryASupplier: true`

**Constraint:** Only one cat A rule per supplier. If a rule already exists, resolution is skipped silently.

---

## Manual toggle (user-driven)

Users can also manually mark any **supplier-only rule** (single `supplier_name = X` condition) as cat A via the Rules page toggle. This:

1. Updates `override_rules.category_a_supplier`
2. Updates the project supplier's `categoryASupplier` flag
3. If the supplier universe is open: adds/removes the rule's taxonomy path from `mapped_taxonomy_paths` and updates `categoryASupplier` on the universe record

**Conflict guard:** If another cat A rule already exists for that supplier, `rules:setCategoryA(ruleId, true)` throws `"A Cat A rule already exists for \"<supplier>\""`.

---

## Delete cascade

When a cat A rule is deleted (`rules:delete`):

1. The rule's taxonomy path is removed from `mapped_taxonomy_paths` in the universe
2. If no other cat A rules remain for that supplier:
   - Project supplier `categoryASupplier` → `false`
   - Universe record `categoryASupplier` → `false`

---

## UI spec

**Rules page**
- "Universe" source label on rules with `source: 'supplier_universe'`
- Cat A toggle on supplier-only rules — calls `ipc.rules.setCategoryA`
- Error toast on conflict

**Suppliers page**
- Read-only Cat A label on suppliers with `categoryASupplier: true`

**Out of scope**
- No cat A toggle on the Suppliers page (read-only label only — toggle lives on Rules)
- No cat A controls on the universe configuration screen

---

## Remaining work

- [ ] UI implementation (see UI spec above)
- [ ] Taxonomy delete guard — prevent deleting a node referenced by any rules (spec: `internal_docs/remaining_fixes/taxonomy-delete-rule-guard.md`)
