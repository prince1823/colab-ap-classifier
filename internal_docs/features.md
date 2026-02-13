# Features Spec

> This document is the authoritative source for product-level decisions. Backend and frontend specs reference this document for the "what" and "why"; they contain only implementation details (the "how").
>
> **Database Schema:** See [schema.md](./schema.md) for the database schema.

---

## 1. Project Management

- Each project is a self-contained `.c91` file (DuckDB database). Projects are fully portable — they can be shared, moved between machines, or backed up as a single file.
- Projects are saved to a `./projects/` folder by default. Users can also open projects from any location.
- Project name is derived from the filename (e.g., `Acme Corp.c91` → "Acme Corp").
- Recent projects are tracked in a local index for quick access. The project picker shows recently opened projects from any location (both ./projects/ and external).
- Each project stores:
  - **Company context:** industry, sector, description, business focus, procurement nuances
  - **Settings:** tail spend threshold (default: $10,000)
- LLM access is through **OpenRouter**, which routes to any supported model (Claude, GPT, etc.) with a single API key. The model is configured via environment variable, with a default.

---

## 2. Data Import

- Users upload CSV transaction files into a project. Each upload can create a new dataset or add rows to an existing dataset.
- **Column canonicalization (LLM-first):** When a CSV is previewed, the CanonicalizationAgent automatically maps CSV columns to the standard schema (supplier_name, spend_amount, gl_description, line_description, etc.) using column names and sample values. The user's role is to **review, edit, and approve** the LLM's suggested mappings — not to configure them from scratch.
- **Invoice grouping columns:** The user selects which canonical columns define an "invoice" for grouping during classification.
- Only canonicalized columns are stored in duckdb.
- After canonicalization is confirmed, distinct suppliers are extracted from transactions and inserted into the project's supplier list.

---

## 3. Taxonomy

- Classifications follow a 3-level hierarchy: L1 → L2 → L3.
- L1 categories are user-defined and can be customized per taxonomy (e.g., "Direct", "Indirect", "Exempt" for procurement, or "Revenue", "Cost of Sales", "Operating Expenses" for finance).
- Each project contains its own complete copy of the taxonomy, imported from ColabIP during project setup. This makes projects self-contained and portable. Taxonomy metadata (name) is stored in project settings.
- Taxonomy nodes have descriptions that help the LLM understand what belongs in each category. Descriptions are authoritative — the LLM should follow them.
- Users can add, rename, and delete taxonomy nodes. Deleting a node requires reassigning affected rows to another node.
- **TBD:** UI to upload a new taxonomy to ColabIP

---

## 4. Supplier Research

### Supplier Type

- Every supplier is classified as one of: **company**, **individual**, or **government** (or null if not yet researched).
- Supplier type is passed to the LLM as context during classification. It is a signal, not a hard rule. For example, a government supplier strongly suggests L1 = Exempt, but the LLM makes the final call based on the full context. **Exception:** government utility payments (electricity, water, gas) should be classified under Utilities, not Exempt.

### Automatic Research

- Supplier research runs **automatically as the first step of the classification pipeline**. When classification starts, the system researches any suppliers that don't already have data before proceeding.
- Research runs in parallel batches to manage API cost and latency.

### Lookup Fallback Chain

Research uses a fallback chain — try each step in order:

1. **Existing data** — check the Supplier Universe (ColabIP global master list) and any existing `supplier_info` / `supplier_type` from prior research. If data already exists, use it directly (no external calls needed). Done.
2. **Exa web search → LLM synthesis** — search Exa for `"supplierName [address] company information linkedin"`. Includes a LinkedIn bias to surface concise company profiles alongside official websites. Exa results are passed to the LLM as context; the LLM extracts structured fields. If Exa is unavailable (no API key) or fails, falls back to LLM-only (training data).
3. **Exa retry with project name** — if step 2 returns `low` confidence and the project has a name, retry Exa with `"supplierName projectName"` to disambiguate. If the retry returns results, re-run the LLM with the new context. **TODO:** Replace `projectName` with a dedicated `companyName` field on CompanyContext once available — project name is a proxy for now.

### Research Output

The ResearchAgent returns:
- supplier_type (company / individual / government)
- website
- industry / NAICS codes — v2: add NAICS lookup table for validation
- parent company
- key offerings / services
- research_confidence (how confident the agent is in the match)

The ResearchAgent uses web search to find supplier info. The prompt instructs the LLM to return "Unknown" for any field it cannot verify from search results, rather than guessing.

### Category A Suppliers

- A supplier can be marked as **Category A** with a predetermined taxonomy classification (`category_a_taxonomy_node_id` on `project_suppliers`).
- At classification time, Category A designations are synced into `override_rules` with `source='supplier'` and priority_score band 300-399.
- The Supplier Database shows Category A status and the predetermined classification directly.

---

## 5. Classification Pipeline

### Classification Scope

Users can choose what transactions to classify. This is implemented as a scope selector function before processing. Such taht we can add future categories to this.

- **All transactions** - Classify every transaction in the project (re-classifies everything)
- **New transactions only** - Classify only transactions that haven't been classified yet (dataset_run_id is null)
- **Filtered** - Reclassify only transactions matching filter criteria passed from the UI (supplier_name, classification_path, review_score range, spend range, etc.)

### Priority Hierarchy

Classification uses a priority hierarchy. First match wins:

1. **Override rules** — synced from all sources, sorted by priority_score (ascending). All conditions in a rule must match (AND logic). First match wins.
2. **LLM classification** — remaining transactions classified by the LLM.

Rows matched by override rules get review score = 0 (deterministic, no review needed).

### Rule Sync

At classification start, `supplier` and `taxonomy` rules in `override_rules` are cleared and rebuilt from their sources:

1. **Project rules** — already in the table with `source='project'`, priority_score band 100-199 (highest priority).
2. **Taxonomy rules** — synced from ColabIP (per-taxonomy `rules.csv`), `source='taxonomy'`, priority_score band 200-299.
3. **Category A suppliers** — synced from `project_suppliers` (where `category_a = TRUE`), `source='supplier'`, priority_score band 300-399.

After sync, go through each rule (sorted by priority_score ascending) and query for all matching transaction rows, set their classification.

### Override Rules

- Each rule has: name, source, priority_score, conditions (field/operator/value), target classification.
- **Source:** where the rule originated: `project`, `taxonomy`, `supplier`. Determines the auto-assigned priority_score band.
- **Priority score:** evaluation order (integer). Lower = evaluated first. Auto-assigned based on source (project: 100-199, taxonomy: 200-299, supplier: 300-399), user-adjustable.
- **Evaluation order:** sorted by priority_score ascending. First match wins. Only one rule is applied per transaction.
- Rule operators: equals, contains, regex, greater_than, less_than, in.


### LLM Classification

- Transactions not classified by override rules are grouped by invoice (using the configured invoice grouping columns). If no grouping columns are set, each row is its own group.
- **Minimum depth:** Classification must return at least L1|L2|L3 (3 levels). Never just L1 or L1|L2.
- **Invoice-level response:** For invoices with multiple line items, the LLM returns one classification per line item. If all rows get the same classification, a single path is returned; otherwise a list of paths (one per row).
- The classification prompt includes:
  - Taxonomy tree (paths + descriptions)
  - Company context (industry, sector, business focus, procurement nuances)
  - Supplier research info (type, offerings, website, industry)
  - Supplier historical L1/L2/L3 classifications
  - Transaction details (supplier_name, gl_description, line_description, spend_amount)
- **Description prioritization:** Supplier research info takes precedence over line/GL descriptions. Line and GL descriptions should only influence classification when they align with supplier info. When they conflict, supplier info wins. **TBD 🟠 PRODUCT: if this is contextual, specify how to decide.**
- **Description cleaning:** If numeric characters constitute 70%+ of an invoice description's content, the numerics are stripped before sending to the LLM. Raw data in the database remains unchanged.
- **Intercompany spend:** The LLM should check if the supplier is a subsidiary of the client company. If so, classify under Exempt.
- The LLM returns: classification_path (L1|L2|L3), reasoning.

### Review Score

- After classification, a separate LLM call computes a **review score** (0-100 integer) for each classified row. Higher scores indicate greater urgency for human review. The score blends classification uncertainty signals with business impact (spend).
- Override rule rows get review score = 0 (deterministic, no review needed).

#### Factors (in priority order)

1. **Historical L1 mismatch** — the L1 assigned differs from the supplier's historical L1
2. **Historical L2 mismatch** — the L2 assigned differs from the supplier's historical L2
3. **Supplier lookup issue** — cannot find a match for the supplier name, or multiple ambiguous results
4. **Description/supplier misalignment** — supplier offerings don't align with line/GL description
5. **Low supplier spend** — low total spend reduces the score (misclassifications have minimal business impact)

- **"Flagged for review"** = any row with a review score above a threshold. The exact threshold is an implementation detail (to be tuned based on real data).
- Exact weights for each factor are an implementation detail. This spec defines the priority ordering only.

---

## 6. Review & Correction

- Users review classified transactions and correct misclassifications.
- The review page displays 3-4 tables, showing supplier_name / line_description / etc. against aggregate spend.
- **Metrics:** Total rows, total spend, and flagged row counts (pending review vs. reviewed) are shown as a summary.

### Filtering

- Transactions can be filtered and sorted by: review score, supplier name, classification path, spend amount.
- **Review score filter** — slider to filter rows within a specific review score range (0-100).
- **Tail spend filter toggle** — hides transactions from suppliers below the tail spend threshold. The threshold value can be edited inline.
- Filters can be combined with AND/OR logic. Dragging a row value to the filter panel creates a filter for that value.

### Reclassification

- A taxonomy tree panel shows all available classifications. Users drag selected rows to a node in the taxonomy tree to reclassify.
- **Override rule warning:** If reclassifying rows matched by an override rule, a warning prompts the user to confirm since those rows are normally deterministic.
- **Undo/redo:** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. History is cleared on page refresh.

---

## 7. System Feedback (feature description to be updated, once usage comes in)

- When reclassifying rows, the user can toggle automatic feedback generation on or off.
- When on, the FeedbackAgent analyzes the correction context and suggests one of:
  - **company_context** — update company business focus
  - **taxonomy_description** — clarify a category definition
  - **supplier_rule** — create an override rule for the supplier
  - **uncategorized_feedback** — surface to developers for manual review
    - Issue subtypes: pattern_recognition, taxonomy_gap, prompt_failure, data_enrichment_needed, supplier_complexity, edge_case
- Suggestions appear in the feedback dashboard. The user can approve, reject, or edit each suggestion before it takes effect.
- If a row has been reclassified before and a new reclassification conflicts, the user is prompted to override the existing feedback or cancel.

---

## 8. Data Stores

### Taxonomy Store
- Browse the taxonomy hierarchy (L1 → L2 → L3) with descriptions.
- Add, rename, and delete nodes. Deleting requires reassigning affected rows.
- Edit taxonomy descriptions inline. Changes are logged.
- Taxonomy is project-local (imported from ColabIP).

### Company Context
- View and edit: industry, sector, description, business focus, procurement nuances.

### Supplier Database
- Table showing: supplier name, supplier type (company/individual/government), parent company, historical classifications, Category A status and classification, research info.
- Edit supplier parent, supplier type, and Category A designation inline.

### Override Rules
- Table showing: rule name, priority_score, source, conditions, target classification, affected row count.
- Create, edit, delete rules. All rules can be edited regardless of source.
- Filter/group by source.
- Warning when a new rule conflicts with an existing one.

### Version History
- Timeline of all changes to transaction classifications.
- Each entry: timestamp, change type, rows affected, summary, source (manual / rule / feedback).
- Revert any change (creates a new history entry, never deletes).
- Export change log as CSV.

---

## 9. Export & Sync

- **Export:** download classified transactions as CSV. File reflects all reclassifications and applied rules at time of download.
- **ColabIP sync:** push/pull taxonomy, supplier universe, and override rules to a shared GitHub repository. Handles conflicts by surfacing them to the user.

---

## 10. QC Agent

**TBD.** A QC agent will review classification quality. Details to be defined after we have a better understanding of what is examined during QC.
