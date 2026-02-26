# Clarifying Questions

Decisions that go beyond execution — need product/design input before implementing.

---

## Schema

### Q1: Merge `settings` + `company_context` into a single `project` key-value table?

**Current state:** Two separate tables. `settings` is key-value, `company_context` is a single-row table with typed columns.

**Project flow says:** "Blank textboxes, save in project table" and "Save in project table" for settings.

**Proposal:** Merge both into one `project` key-value table. Company context fields become keys (`company_name`, `industry`, etc.). Column mappings JSON goes here too.

**Trade-off:** Simpler schema, one place for all project config. Loses column-level typing on company_context (all values are VARCHAR). This is fine since the fields are all free-text.

**Decision needed:** Confirm merge, or keep separate tables.

### Q2: Add `classification_status` column to transactions?

**Current state:** No explicit `classification_status`. Status is inferred from `taxonomy_node_id IS NULL` (unclassified) and `review_score` values. No way to distinguish "classified by rule" from "classified by AI".

**Project flow says:** Explicit `classification_status` with values: `unclassified`, `classified_by_rule`, `classified_by_ai`, `human_reviewed`.

**Proposal:** Add `classification_status VARCHAR DEFAULT 'unclassified'` to the transactions base schema. Pipeline sets it during classification. Review page sets it to `human_reviewed` on mark-correct.

**Trade-off:** Small schema addition, big gain in queryability and clarity.

**Decision needed:** Confirm addition + the four status values above. Does `review_score` remain alongside it, or does `classification_status` replace the need for it?

### Q3: Drop `column_mappings` and `invoice_grouping_columns` tables?

**Current state:** Two separate tables store column mappings and grouping columns.

**Project flow says:** "Column mapping llm outputs column map json" — suggests storing as a single JSON blob.

**Proposal:** Store column mapping as a JSON value in the `project` table (key: `column_mapping_json`), and invoice grouping columns as another JSON value (key: `invoice_grouping_columns`). Drop the two dedicated tables.

**Trade-off:** Simpler schema. Marginally harder to query individual mappings in SQL (need JSON functions), but these are only ever read/written as a complete unit anyway.

**Decision needed:** Confirm consolidation.

---

## Override Rules

### Q4: Replace source-based priority bands with flat user-controlled priority?

**Current state:** Priority is banded by source: project rules get 100-199, taxonomy rules get 200-299, supplier rules get 300-399. Lower number = higher priority. Source types: `project`, `taxonomy`, `supplier`.

**Project flow says:** Rules have a "Priority number (unique, positive)" that the user reorders in a prioritization view. Rules are grouped by "rule type" (which column they target), not by source.

**Proposal:** Drop source-based bands. Priority is a flat positive integer, fully user-controlled. Group/display by "rule type" (supplier, GL, mixed) which is derived from the columns referenced in conditions. Drop the `source` and `imported_at` columns from `override_rules`. Add a `rule_type` column (or derive it at query time from conditions).

**Trade-off:** Simpler mental model. Users have full control. Loses the automatic separation that prevented supplier rules from overriding project rules. The user is now responsible for ordering.

**Decision needed:** Confirm flat priority. Should `rule_type` be stored or computed?

### Q5: What happens to ColabIP-imported rules?

**Current state:** `syncRulesFromSources()` deletes all taxonomy/supplier rules and rebuilds them from ColabIP + Category A suppliers every time classification runs. This is the "sync" mechanism.

**Project flow says:** Rules are loaded once (step 5), user edits them, priority is user-controlled. No mention of re-syncing.

**Proposal:** Import ColabIP rules once as regular rules (no special source). User can then edit, reorder, delete them freely. No automatic re-sync during classification. The "import from ColabIP" action is a one-time data load, not a recurring sync.

**Trade-off:** User has full ownership of rules. Risk: if ColabIP rules change upstream, the project won't pick up changes automatically. This is probably fine since projects are point-in-time snapshots.

**Decision needed:** Confirm one-time import model. Should there be a "re-import from ColabIP" button that warns about overwriting user edits?

---

## Supplier Research

### Q6: `supplier_universe.db` — separate database or same project file?

**Current state:** Supplier data lives in `project_suppliers` table inside the `.c91` project file. The supplier universe is read from ColabIP's `supplier_universe.csv` at import time and during research.

**Project flow says:** "Page shows supplier table (supplier_universe.db) — default filter for project suppliers". This implies a separate database for the supplier universe, shared across projects.

**Proposal options:**

**A) Separate `supplier_universe.db`** — A single DuckDB file in the app data directory. All projects read/write the same supplier universe. Supplier research results persist across projects. Requires managing two DB connections.

**B) Keep in project file** — Each project has its own `project_suppliers` table. Cross-project supplier data comes from ColabIP CSV only. Simpler but no cross-project learning.

**Decision needed:** Which model? Option A matches the project flow description but adds connection management complexity. Option B is simpler but loses cross-project supplier state.

### Q7: Supplier research as a separate step vs. part of pipeline?

**Current state:** Supplier research runs as part of the classification pipeline (step 2 of `runPipeline`). It's not a separate user-initiated step.

**Project flow says:** Step 6 (Supplier Research) is a distinct step before Step 7 (Classification). User reviews suppliers before classification begins.

**Proposal:** Make supplier research a standalone operation triggered from the Suppliers page. User clicks "Research Suppliers", sees progress, reviews results on the supplier review page, and only then proceeds to classification. Classification pipeline no longer includes a research phase.

**Trade-off:** Cleaner separation. User has a review gate before classification. Slightly more manual steps.

**Decision needed:** Confirm separate step. Should classification refuse to run if suppliers haven't been researched yet?

### Q8: "Previous mappings" in supplier context — what does this mean?

**Project flow says** the supplier service returns "Previous mappings" as part of supplier context.

**Options:**
- Historical taxonomy classifications for this supplier from past projects (requires cross-project data, i.e., `supplier_universe.db`)
- The current project's classifications for this supplier (trivially queryable)
- Manual overrides/rules associated with this supplier

**Decision needed:** Define "previous mappings" — which data, from which scope?

---

## Classification Pipeline

### Q9: "Batch" granularity in review — what defines a batch?

**Project flow says:** "For every batch sent to classification, show results in a review pane" and "Allow for viewing multiple batches together."

**Current state:** The pipeline processes all transactions at once (grouped by invoice group). There's no concept of a "batch" exposed to the user.

**Options:**
- Batch = all transactions for one supplier (natural grouping since supplier research is per-supplier)
- Batch = a chunk of N transactions submitted together
- Batch = a single pipeline run (all-or-nothing)

**Decision needed:** What defines a batch? How are batches tracked for the review UI?

### Q10: "Reclassify based on filters" UI — how does this work?

**Project flow says:** "Reclassify based on filters. Therefore, call update_Transaction()" with a note: "TODO: The UI specific thing has to be detailed here, since this is complex."

**Current state:** ReviewPage allows selecting rows and reclassifying to a chosen taxonomy node.

**Questions:**
- Does "reclassify based on filters" mean: select a filter (e.g., "all transactions from Supplier X classified as Y"), pick a new taxonomy node, and reclassify all matching rows?
- Or does it mean: re-run the AI classification engine on the selected rows?
- Can both options coexist (manual re-assign vs. AI re-classify)?

**Decision needed:** Specify the reclassification UI interaction.

---

## Pruning Candidates

### Q11: Tables that could be pruned

| Table | Current | Proposal | Rationale |
|-------|---------|----------|-----------|
| `settings` | key-value settings | Merge into `project` | See Q1 |
| `company_context` | Single-row company info | Merge into `project` | See Q1 |
| `column_mappings` | Mapping rows | JSON in `project` | See Q3 |
| `invoice_grouping_columns` | Grouping rows | JSON in `project` | See Q3 |
| `system_feedback` | Feedback agent table | Remove | Feedback agent removed from flow |

Net effect: 10 tables → 5 tables.

### Q12: Services that could be pruned or merged

| Service | Proposal | Rationale |
|---------|----------|-----------|
| `canonicalization` | Merge into `upload` | `saveMappings` + `getMappings` are small; only called by the upload flow |
| `taxonomy-utils` | Merge into `taxonomy` | Single helper function (`resolveTaxonomyPath`) |
| `feedback` | Remove | Feedback agent removed from flow |
| `supplier-matcher` | Keep | Used by both `upload` (import) and `supplier-research` |
| `exa-search` | Keep | Clean external API wrapper |
| `rate-limiter` | Keep | Used by both research and classification |

### Q13: Pages to remove

| Page | Proposal | Rationale |
|------|----------|-----------|
| `FeedbackDashboardPage` | Remove | Feedback agent removed from flow |

---

## Export

### Q14: Export format — CSV only?

**Project flow says:** "Download dataset as csv, with all the canonicalized columns and taxonomy classifications."

**Current state:** CSV export only.

**Question:** Is CSV sufficient, or should Excel (.xlsx) export be supported? (The `xlsx` package is already a dependency.)

**Decision needed:** CSV only, or add Excel?

---

## Taxonomy Editing

### Q15: Taxonomy editing in two modes — what triggers reclassification?

**Project flow says:**
- "Pivot table mode" = no reclassification, viewing only
- "Review mode" = editing triggers reclassification

**Questions:**
- When a taxonomy node is edited (name changed, moved in hierarchy), what happens to transactions already classified under it?
- When a taxonomy node is added, does anything happen automatically?
- When a taxonomy node is deleted, are classified transactions orphaned, or auto-reclassified?

**Decision needed:** Define the reclassification triggers for each taxonomy mutation (add/edit/delete).
