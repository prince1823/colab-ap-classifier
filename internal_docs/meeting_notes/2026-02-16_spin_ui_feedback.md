# SPIN UI Meeting Feedback Analysis
**Meeting Date:** 2026-02-16
**Participants:** Madhur Kabra, Nikhil, Arjun, Pallavi, and others (client analysts/consultants)
**Analyzed:** 2026-02-17

## Purpose

This document maps client feedback from the SPIN UI meeting to the current codebase state, identifies gaps between what clients expect and what is planned/built, and highlights priorities that may need to shift.

---

## Current Codebase State (Context)

- **Backend:** Complete. All 16 services, 4 LLM agents, IPC handlers, DuckDB schema, pipeline — fully implemented and tested.
- **Frontend:** Not started. `App.tsx` is a placeholder. No pages, components, or routing exist.
- **Sprint 2:** Not started. Planned: ColabIP sync, tail spend handling, QC agent, classification source tracking, parallel supplier research, feedback v2.

The frontend is about to be built, making this feedback extremely timely — we can incorporate these insights before writing any UI code.

---

## Key Themes from the Meeting

### 1. Excel Download/Upload is Non-Negotiable

**What clients said:**
Analysts universally prefer Excel for slicing, dicing, and bulk feedback. They want to download classified data, add feedback columns (change, change_all, original, logic), edit offline, and re-upload. Multiple analysts work on the same project in parallel by splitting Excel files. The tool UI is for QC and visual review, not primary classification editing.

**Current state:**
- `export:export` writes a flat CSV of transactions + classifications. No template structure for feedback re-upload.
- No `import feedback from Excel` flow exists anywhere in specs or code.
- The spec envisions reclassification via drag-and-drop in the UI — which clients explicitly called slow and annoying.

**What needs to change:**
- **New feature: Excel feedback round-trip.** Design a download template with blank feedback columns (`change`, `change_all`, `logic`) and an upload flow that parses those columns, applies reclassifications, and logs changes to `change_log`. This is arguably more important than drag-and-drop reclassification.
- **Priority shift:** The Review page's drag-and-drop reclassification (Thread 4 in frontend spec) can be simplified. The heavy reclassification workflow happens in Excel. The in-app UI is for quick visual QC and one-off corrections.
- **Impact:** New IPC channels needed (e.g., `feedback:uploadExcel`, `export:downloadTemplate`). New service for parsing feedback Excel. `change_log` already supports this — source would be `"excel_upload"`.

### 2. The Tool is Primarily for Visual QC, Not Primary Editing

**What clients said:**
The tool's value is visual review — quickly scanning categories, checking top vendors by spend, confirming classifications look correct before delivery. The manager wants to glance at categories and say "looks good, deliver." Nobody wants to do heavy editing in the tool.

**Current state:**
The frontend spec designs the Review page as a full editing environment (drag-and-drop, filter panel, undo/redo, feedback generation). This is over-built relative to what clients actually want.

**What needs to change:**
- **Simplify Review page design.** Prioritize read-heavy views: category-level summaries, top suppliers per category, spend distributions. De-prioritize complex interaction patterns.
- **Add quick category-level QC view.** A summary showing each L1/L2/L3 node with supplier count, spend total, and top suppliers — so a manager can scan and approve. This doesn't exist in the current spec.
- **Keep reclassification simple:** Select rows + pick node from dropdown/tree. Drag-and-drop is a nice-to-have, not essential. Clients said drag-and-drop "is a pain."

### 3. Report Builder / Pivot-Style Views

**What clients said:**
They want pivot-table-like views: supplier by GL, supplier by category, spend by time period. They want downloadable report templates — pre-built views that save time. Custom hierarchy building for analysis purposes.

**Current state:**
- `transactions:query` supports basic filters but no pivot/aggregation capability.
- No report builder concept exists in the spec or code.
- The spec has a simple data table view with column selector.

**What needs to change:**
- **New feature: Report builder tab or panel.** Pre-built pivot templates (supplier x category, GL x category, supplier x GL, spend by month). Allow grouping and aggregation in-app with download.
- This aligns with Thread 6 (Download/Output) in the frontend spec but goes beyond a simple CSV export. Consider a dedicated "Reports" tab or a section within the existing Output page.
- **Backend impact:** New IPC channel for aggregated queries (e.g., `reports:pivot`) or extend `transactions:query` with GROUP BY support. DuckDB is excellent at this — minimal effort.

### 4. Confidence Score Visibility

**What clients said:**
They want a confidence score visible at the transaction level — both in the tool and in Excel downloads. High/medium/low bands. This helps analysts know what to trust and what to review.

**Current state:**
- `review_score` (0-100) exists in the `transactions` table — this is the inverse of confidence (higher = more uncertain).
- The classification agent returns it per row.
- The export service includes it in CSV output.

**What needs to change:**
- **Rename or reframe:** Present `review_score` as a confidence score to users (invert the scale, or use separate high/medium/low labels derived from the score). The internal name can stay, but the UI/export should show "Confidence: High/Medium/Low" alongside the numeric score.
- **Ensure it's prominent in the UI:** Not buried in a column but visible as a color-coded badge or icon.
- Already built on the backend. This is a frontend design decision only.

### 5. Supplier Normalization as a Distinct, Visible Step

**What clients said:**
Supplier name standardization is the single biggest pain point. Dirty supplier names produce garbage classifications. They want normalization as an explicit step before classification — visible, QC-able, not hidden inside the pipeline.

**Current state:**
- No supplier normalization step exists anywhere. The `ResearchAgent` does supplier research (type, industry, website) but does not normalize/standardize supplier names.
- The pipeline goes: upload → canonicalize columns → classify. Supplier names are taken as-is from the CSV.
- The spec mentions "supplier name standardization" once in the context of supplier research but doesn't define it as a pipeline step.

**What needs to change:**
- **New pipeline step: Supplier Normalization.** After CSV upload and before classification, run an LLM or rule-based step that:
  1. Groups similar supplier names (fuzzy matching + LLM judgment)
  2. Suggests a canonical name for each group
  3. Presents results for user review/approval
  4. Updates `project_suppliers` with normalized names
- **New agent or extend ResearchAgent:** Could be a `NormalizationAgent` or an extension of the research step. Clients suggested two separate agents (normalization + research) controlled by a master agent — aligns with our multi-agent architecture.
- **New UI page:** A "Supplier Review" step between Upload/Data Review and Classification. Shows supplier name groups, suggested canonical names, and allows manual correction.
- **Backend impact:** New service (`supplier-normalization.ts`), new IPC channels, possibly a new DuckDB column (`normalized_name` in `project_suppliers`), and pipeline modification to run normalization before research.
- **This is a significant addition** not in any current sprint plan but was raised as the highest-impact improvement by multiple participants.

### 6. Rule Hierarchy and Prioritization

**What clients said:**
Rules have a clear priority hierarchy: supplier-level rules > supplier+GL rules > supplier+invoice rules > machine classification. When a refresh comes in, the machine should only touch new/unmatched data — existing rules and classifications should be preserved.

**Current state:**
- `override_rules` has priority bands: project (100-199), taxonomy (200-299), supplier (300-399). First match wins by ascending priority score.
- The pipeline applies rules before LLM classification — matched rows get `review_score=0`.
- Rule sync rebuilds supplier and taxonomy rules at classification start.
- No concept of "rule type" classification (supplier-only vs. supplier+GL vs. supplier+invoice) is stored.

**What needs to change:**
- **Tag rules by specificity type.** Store whether a rule is supplier-only, supplier+GL, supplier+GL+invoice, etc. This metadata helps with search, display, and future prioritization tuning. Could be a new `rule_type` column in `override_rules` or derived from `conditions` at display time.
- **"New data only" classification scope already exists** (`classification:start` accepts scope `"new"` — rows where `dataset_run_id` is null). But the refresh workflow (append new data, classify only new rows, preserve existing) needs to be a first-class UI flow, not just a backend capability.
- **Rule log searchability:** Clients want to search the full rule history by keyword (e.g., "advertising"). `changelog:list` exists but may need full-text search support.

### 7. Comments/Logic on Reclassifications

**What clients said:**
Every reclassification should have a comment explaining the analyst's logic. This helps the model learn (reinforcement learning from human feedback) and provides an audit trail. The comment captures why a supplier was moved.

**Current state:**
- `change_log` stores `old_values` and `new_values` as JSON but has no `comment` or `logic` field.
- `system_feedback` captures LLM-generated suggestions but not human reasoning.
- The spec's FeedbackAgent generates suggestions from reclassifications but doesn't incorporate analyst-provided rationale.

**What needs to change:**
- **Add a `comment` field to `change_log`** (or to the reclassification flow). When reclassifying, the UI should prompt for or allow a free-text logic note.
- **Feed comments to the FeedbackAgent** as additional context. This is the "reinforcement learning" path the clients described — human logic improves future LLM behavior.
- **Backend impact:** ALTER TABLE `change_log` ADD COLUMN `comment TEXT`; update `reclassification.ts` to accept and store comments; update `feedback-agent.ts` prompts to incorporate analyst reasoning.
- Minimal effort, high value.

### 8. Freeze Panes / Multi-Column View

**What clients said:**
When you have 5+ data columns plus the classification path, scrolling becomes a problem. They want freeze panes (pin supplier name, spend amount on the left while scrolling through other columns).

**Current state:**
No frontend exists yet. The spec describes a data table with configurable columns but doesn't address column pinning/freezing.

**What needs to change:**
- **Use a table component that supports column pinning.** Libraries like TanStack Table (React Table) or AG Grid support this natively. Choose the table library with this in mind.
- **Default pinned columns:** supplier_name, spend_amount, classification_path should be pinned left by default, with remaining columns scrollable.
- Pure frontend decision. No backend impact.

### 9. Time Period / Calendar Filtering

**What clients said:**
They need year/quarter/month filtering on transaction dates. Spend trend visualization over time. A master date column (invoice date or posting date, configurable) is needed.

**Current state:**
- `transactions` table has dynamic columns — date columns would come from canonical mappings (`invoice_date`, `posting_date` are in the canonical column list).
- No time-period aggregation or filtering exists in `transactions:query`.
- No date-based visualization is planned.

**What needs to change:**
- **Extend `TransactionFilter` with date range support.** Add `dateFrom`, `dateTo`, `dateColumn` (which canonical date column to use) to the filter interface.
- **Add time-period aggregation to reporting.** Monthly/quarterly spend breakdowns as charts (bar or line).
- **Master date column concept:** Allow users to designate one date column as the "master date" for filtering. Could be a setting in `settings` table or a UI toggle.
- Backend: extend `transactions:query` WHERE clauses; new aggregation query for time series. Frontend: date range picker, spend trend chart.

### 10. Dynamic Table Filtering (Cross-Column)

**What clients said:**
When you filter on a supplier in one panel, the GL descriptions and other columns should dynamically update to show only data for that supplier. Cascading filters.

**Current state:**
- `transactions:query` supports `supplierName` and `taxonomyNodeId` filters independently. No cascading/dynamic filter concept.
- The spec mentions drag-to-filter and AND/OR logic but doesn't explicitly describe cascading panel updates.

**What needs to change:**
- **Frontend architecture:** Design the Review/QC page with linked panels — supplier list, GL list, transaction table. Selecting a supplier filters the GL list and transaction table. This is a UI state management pattern, not a backend change.
- **Backend is already sufficient:** `transactions:query` with a `supplierName` filter returns the right data. The frontend just needs to chain filter state across panels.

### 11. Multi-Analyst Collaboration

**What clients said:**
Big projects have multiple analysts working simultaneously. They split Excel files, work in parallel, then consolidate. The tool should support or at least not obstruct this workflow.

**Current state:**
- Single-user desktop app. `.c91` files are local. No multi-user support.
- No locking, no merge, no conflict resolution for concurrent edits.

**What needs to change:**
- **Short-term (v2):** Support the Excel round-trip workflow (point 1 above) — this inherently enables multi-analyst parallel work because each analyst works on their own Excel file and uploads feedback separately.
- **Medium-term:** Consider a "merge feedback" flow that handles conflicts when multiple analysts reclassify the same supplier differently.
- **Long-term:** Multi-user support is a major architectural change (server-based DB, auth, real-time sync). Not recommended for near-term.

### 12. Separate LLM Agents for Distinct Tasks

**What clients said:**
Break classification into smaller specialized agents: supplier normalization agent, supplier research agent, GL classification agent, final judgment agent. Smaller, focused tasks produce more accurate results.

**Current state:**
- 4 agents: CanonicalizationAgent, ResearchAgent, ClassificationAgent, FeedbackAgent.
- Classification is a single monolithic agent call per invoice group.
- No GL-specific or invoice-description-specific agents.

**What needs to change:**
- **Evaluate agent decomposition.** The current ClassificationAgent receives supplier research, GL descriptions, invoice descriptions, and taxonomy all at once. Breaking this into:
  1. **NormalizationAgent** — standardize supplier names (new)
  2. **ResearchAgent** — supplier type/industry (exists)
  3. **GL ClassificationAgent** — classify based on GL codes (new or subset of current)
  4. **Final JudgmentAgent** — reconcile all signals into final classification (new or modified current)
- This is a significant refactor of the classification pipeline. Worth prototyping on one test dataset to measure accuracy improvement before committing.
- Aligns with Sprint 2's "Classification Improvements" track.

---

## Priority Matrix

| Theme | Client Priority | Current Coverage | Effort | Recommended Action |
|-------|----------------|-----------------|--------|-------------------|
| Excel download/upload round-trip | Critical | Partial (export only) | Medium | Add to Sprint 2 — before or alongside frontend |
| Visual QC / category summary view | High | Not built (frontend) | Medium | Design into frontend from the start |
| Supplier normalization step | High | Not planned | High | Add to Sprint 2 or create Sprint 3 track |
| Confidence score display | High | Backend done | Low | Frontend design only |
| Comments on reclassifications | High | Not in schema | Low | Quick schema + service update |
| Report builder / pivot views | Medium-High | Not planned | Medium | Add to Sprint 2 Output track |
| Rule hierarchy tagging | Medium | Partially covered | Low | Extend override_rules schema |
| Freeze panes / column pinning | Medium | Not built (frontend) | Low | Choose right table library |
| Time period filtering | Medium | Not in query filters | Low-Med | Extend TransactionFilter |
| Dynamic cascading filters | Medium | Backend supports it | Low | Frontend state management |
| Multi-analyst collaboration | Medium | Not supported | Low (via Excel) | Excel round-trip solves short-term |
| Agent decomposition | Low (research) | 4 agents exist | High | Prototype & measure before committing |

---

## Recommended Actions

### Immediate (before frontend development starts)
1. **Add `comment` column to `change_log` table** — trivial schema change, high value
2. **Design Excel feedback template** — define the download format and upload parsing rules
3. **Rethink Review page layout** — optimize for visual QC (category summaries, spend breakdowns) over heavy editing
4. **Choose a table library with column pinning support** (TanStack Table or AG Grid)

### Sprint 2 Additions
5. **Excel feedback round-trip** — download template + upload parser + apply changes
6. **Report builder** — pre-built pivot templates with download
7. **Supplier normalization agent** — pre-classification step for name standardization
8. **Time period filtering** — extend `TransactionFilter`, add date range picker
9. **Confidence score UX** — map `review_score` to High/Med/Low labels in UI

### Backlog
10. **Agent decomposition study** — prototype GL-specific and judgment agents, measure accuracy delta
11. **Multi-user collaboration** — server architecture evaluation
12. **Rule type tagging** — classify rules by specificity for better search/display
