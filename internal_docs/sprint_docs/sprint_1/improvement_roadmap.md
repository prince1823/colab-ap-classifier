# Improvement Roadmap — Consolidated

**Started:** 2026-02-20 — began prioritizing runtime, accuracy, and cost for 15,000-row runs
**Verified against:** codebase on `dev` as of 2026-02-22

Items marked ✅ are already implemented on `dev` (merged via PR #110). Items with `#nnn` have existing GitHub issues.

---

## Category 1: Infrastructure for 15,000-Row Runs

### 1.1 ✅ Batch DB writes (6 locations) — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

All six row-by-row `await databaseService.run()` loops converted to batch operations. Classification UPDATEs via `WHERE id IN (...)`, CSV imports in 500-row batches, supplier stats via CASE expressions, etc.

### 1.2 ✅ Filter transaction fields sent to LLM — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

`EXCLUDED_FIELDS` set strips `id`, `row_index`, `created_at`, `updated_at`, `taxonomy_node_id`, `classification_reasoning`, `invoice_group_key`, `review_score` from LLM prompts.

### 1.3 ✅ Batch sizes increased — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

Classification 7→8, research 5→10. Further increases blocked on #111.

### 1.4 ✅ `idx_transactions_supplier` index — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

Added as migration for existing projects + on new imports.

### 1.5 ✅ Cache `getColumns()` in memory — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

`transactions.ts` now caches column list with invalidation on project open/create and ALTER TABLE. Previously queried `information_schema` on every transaction query.

### 1.6 ✅ Consolidate `getStats()` — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

5 separate DB queries → 1 with conditional aggregates.

### 1.7 ✅ Batch supplier name resolution — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

CASE expressions, 200 names per batch (was N+1).

### 1.8 Adaptive rate-limit handling — [#111](https://github.com/kavyald/colab-ap-classifier/issues/111)

At 1,000 rows, 37% of transactions fail from HTTP 429s. Current config: `CLASSIFICATION_BATCH_SIZE=8`, `RESEARCH_BATCH_SIZE=10`, `MAX_RETRIES=3`, initial delay 1s, max delay 30s. All 8 concurrent calls retry independently → thundering herd. Need: adaptive concurrency (halve on 429, recover on success), retry queue for failed groups at end of pipeline, increased retry budget (3→5+). LLM retry with exponential backoff exists (`64215ba`) but the fixed concurrency + short budget is insufficient at scale.

### 1.9 Pipeline hardening — silent failure modes at scale — [#112](https://github.com/kavyald/colab-ap-classifier/issues/112)

Three silent failure modes that become catastrophic at 15K rows:

- **Failed group sentinel**: When a classification group fails (LLM timeout, parse error), the catch block at `classification-pipeline.ts:294` logs to console but writes nothing to DB. Failed transactions remain with `taxonomy_node_id = NULL` and `review_score = NULL` — indistinguishable from unprocessed rows.
- **`getDistinctSupplierNames` bare catch**: `classification-pipeline.ts:414-428` — bare `catch { return [] }` swallows all errors. If this fails silently, the entire supplier research phase is skipped. At 15K rows every classification happens without supplier context.
- **60-second LLM timeout**: `llm-client.ts` — `REQUEST_TIMEOUT_MS = 60_000`. With large taxonomy prompts and heavier models, 60s may not be enough.

### 1.10 DuckDB single-writer mutex — [#116](https://github.com/kavyald/colab-ap-classifier/issues/116)

DuckDB only supports one writer at a time but no application-level enforcement exists. At 15K rows classification runs for 10-30+ minutes. During that window, if a user opens the Review tab and reclassifies rows, both the pipeline and reclassification try to `UPDATE transactions` simultaneously → opaque mutex error. The `isClassifying` flag exists in `workflowStore` but the Review tab doesn't check it — nothing prevents concurrent writes. Also implements spec-required read-only mode (2.5).

### 1.11 File I/O optimizations — [#113](https://github.com/kavyald/colab-ap-classifier/issues/113)

- **Async file reads**: `upload.ts` uses `fs.readFileSync` to read entire CSV into memory. For a 100MB file this blocks the Electron main process (UI freezes). Same pattern in `canonicalization.ts:194`.
- **Eliminate redundant CSV parsing**: CSV is parsed 3 times during upload: `detectDelimiter()`, `parseCSVPreview()`, and `importCSV()`. Should parse once and cache.
- **Cache supplier universe CSV**: `readSupplierUniverse()` reads and parses the full CSV from disk on every pipeline run, even though universe data doesn't change between runs.

### 1.12 DB query optimizations — [#114](https://github.com/kavyald/colab-ap-classifier/issues/114)

- **Consolidate rule evaluation queries**: `rules.ts:138-175` — each active override rule triggers a separate `SELECT` against `transactions`. With 20 rules, that's 20 full-table scans.
- **Add indexes on `review_score` and `row_index`**: Filtered and sorted in frontend queries. Currently only `idx_transactions_taxonomy` and `idx_transactions_supplier` exist.
- **Temp tables for large IN clauses**: Multiple locations build `IN (?,?,?...)` with thousands of IDs. At 15K+ rows this generates huge SQL strings.
- **SELECT only needed columns**: `classification-pipeline.ts:442` — `SELECT * FROM transactions WHERE id IN (...)`. Classification agent only needs ~6 fields.

---

## Category 2: Decided Features Not Implemented to Spec

### 2.1 Review score is binary (0 or 50) — [#99](https://github.com/kavyald/colab-ap-classifier/issues/99)

**Spec** (`features.md §5`): 0-100 integer from a dedicated LLM call blending 5 factors (historical mismatch, supplier lookup quality, description misalignment, spend).

**Code** (`classification-pipeline.ts:293`): `review_score = descriptionSupplierAligned ? 0 : 50`. Binary, one factor, inline. Users get no nuanced review prioritization — every misaligned row scores 50.

### 2.2 Historical classifications always empty — [#65](https://github.com/kavyald/colab-ap-classifier/issues/65)

**Spec** (`backend_spec.md §3.3 Step 7`): supplier historical L1/L2/L3 classifications provided to LLM.

**Code** (`classification-pipeline.ts:274`): `historicalClassifications: []` hardcoded. No code queries prior classifications. LLM has no consistency signal across runs.

### 2.3 Taxonomy rules deleted but never rebuilt — [#63](https://github.com/kavyald/colab-ap-classifier/issues/63)

**Spec** (`backend_spec.md §3.3 Step 3`): sync rules rebuilds both taxonomy and supplier rules.

**Code** (`rules.ts:181-205`): `DELETE FROM override_rules WHERE source IN ('taxonomy', 'supplier')` → then only rebuilds supplier rules from Category A suppliers. Taxonomy rules permanently lost after first classification. `readRulePack()` exists in `colabip.ts` but is never called from `syncRulesFromSources()`.

### 2.4 Description cleaning only on `gl_description`

**Spec** (`backend_spec.md §3.3 Step 6`): clean numeric-heavy "invoice descriptions" (plural, implies both description fields).

**Code** (`classification-pipeline.ts:259-265`): only `gl_description` is cleaned. `line_description` is passed to the LLM with numeric noise intact.

Tracked in [#119](https://github.com/kavyald/colab-ap-classifier/issues/119) (S1 bug fix batch).

### 2.5 No read-only mode during classification

**Spec** (`frontend_spec.md:32-35`): Upload, Canonicalization, Data Review show read-only with banner during classification.

**Code**: `isClassifying` flag is computed in `workflowStore.ts:55` but no page reads it. Confirmed: 0 references in `src/renderer/pages/`. Users can modify settings mid-classification.

Tracked in [#116](https://github.com/kavyald/colab-ap-classifier/issues/116) (DuckDB mutex + read-only mode).

### 2.6 No undo/redo for reclassification — [#121](https://github.com/kavyald/colab-ap-classifier/issues/121)

**Spec** (`frontend_spec.md:233`): Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z.

**Code**: `useKeyboardShortcuts` hook exists at `src/renderer/hooks/useKeyboardShortcuts.ts` but is imported only by `MultiTableSystem.tsx` (not for undo/redo). No undo stack exists anywhere.

### 2.7 Dataset selector is stubbed

**Spec** (`frontend_spec.md:36`): Review and Output include a dataset selector for previously classified datasets.

**Code**: `ReviewPage.tsx` has `const datasetId = 'default'; const setDatasetId = () => {}`. Output has no selector. No backend support for multiple datasets. Low priority unless multi-run comparison becomes needed.

Tracked in [#122](https://github.com/kavyald/colab-ap-classifier/issues/122) (form state persistence + dataset selector).

### 2.8 `scope: 'all'` overwrites reclassifications — [#117](https://github.com/kavyald/colab-ap-classifier/issues/117)

`ClassificationControls.tsx:13` defaults to `scope: 'all'`. `identifyRows` for this scope runs `SELECT id FROM transactions` with no WHERE clause — re-classifies everything including manually reclassified rows. Overwrites without warning or changelog entries for the overwrites. Since 'all' is the UI default, users are likely to hit this. Note: `scope: 'new'` already exists and works correctly — this is mainly a bad default + no confirmation dialog.

### 2.9 Classification source tracking — [#72](https://github.com/kavyald/colab-ap-classifier/issues/72)

Track whether each row was classified by rule, LLM, or manual reclassification. Expose as filter in Review tab. No code exists for this.

### 2.10 Rejection reason not stored

`rejectFeedback(id, _reason)` — parameter prefixed with underscore and ignored. Reason never written to DB.

Tracked in [#119](https://github.com/kavyald/colab-ap-classifier/issues/119) (S1 bug fix batch). Previously #67 (closed).

### 2.11 Feedback toggle missing

`reclassification.ts:77` — `if (feedback) { ... }`. Triggers feedback agent whenever non-empty string is passed. No project/app-level toggle to disable automatic feedback generation.

Tracked in [#119](https://github.com/kavyald/colab-ap-classifier/issues/119) (S1 bug fix batch). Previously #66 (closed).

### 2.12 `addRecent()` never wired

`project:new` and `project:open` IPC handlers have TODO comments but never call `addRecent()`. Recent projects list is always empty.

Tracked in [#119](https://github.com/kavyald/colab-ap-classifier/issues/119) (S1 bug fix batch). Previously #64 (closed).

### 2.13 Form state not persisted across reload — [#122](https://github.com/kavyald/colab-ap-classifier/issues/122)

**Spec** (`frontend_spec.md:406`): page reload doesn't lose unsaved changes.

**Code**: Zustand `workflowStore` is in-memory only. No localStorage persistence. F5 or app restart loses all in-progress state.

### 2.14 IPC return type mismatches (3 channels)

`export:export` returns `void` instead of `{ rowsExported: number }` (can't show export counts). `rules:importFromColabip` returns `void` instead of `{ imported: number }`. `rules:create` returns full `OverrideRule` instead of `{ id: string }` (superset — harmless).

Tracked in [#119](https://github.com/kavyald/colab-ap-classifier/issues/119) (S1 bug fix batch).

---

## Category 3: Improved Features for Classification Accuracy

### 3.1 QC Agent — [#71](https://github.com/kavyald/colab-ap-classifier/issues/71)

Post-classification quality review agent. Would catch systematic misclassifications (e.g. all of a supplier's transactions going to wrong L1) before user review. Spec covers tail spend and high spend supplier handling.

### 3.2 Compound feedback rules — [#90](https://github.com/kavyald/colab-ap-classifier/issues/90)

FeedbackAgent currently generates single-condition supplier rules (`supplier_name = X → node`). Should capture filter context from reclassification and generate compound rules (supplier + GL code, supplier + description keywords). Also: add `comment` field to changelog for analyst reasoning. Sub-issue of #75.

### 3.3 System feedback v2 — [#75](https://github.com/kavyald/colab-ap-classifier/issues/75)

Refined FeedbackAgent with improved suggestion quality based on v1 usage patterns.

### 3.4 Two-pass taxonomy + research agent taxonomy context — [#118](https://github.com/kavyald/colab-ap-classifier/issues/118)

Currently `formatTaxonomyTree` sends all depth-3 nodes as a flat list of pipe-delimited paths in every classification call — no L1/L2 grouping, 5,000-15,000 tokens. The LLM has to parse string structure to understand hierarchy while scanning 500 leaf nodes.

Two-pass approach: first LLM call picks L1 (from ~10 categories), second call picks L2/L3 within that subtree (from ~30-50 nodes). Benefits: (1) **accuracy** — LLM focuses on fewer, more relevant options, (2) **cost** — ~90% taxonomy token reduction (~$3.20 saved per 15K-row run at Haiku pricing, see Category 5). Runtime impact is modest (~50-100s across 500 groups), secondary to rate-limit bottleneck.

Also: `research-agent.ts` researches suppliers without any knowledge of the taxonomy. Passing L1 category names would improve downstream classification alignment.

### 3.5 Low-confidence supplier research retry — [#61](https://github.com/kavyald/colab-ap-classifier/issues/61)

Retry Exa search with additional context when confidence is low. Previously implemented (commit `4c80125`) and reverted (`837fd55`). Needs clearer strategy for when retry is worth the extra API calls.

### 3.6 NAICS lookup table — [#74](https://github.com/kavyald/colab-ap-classifier/issues/74)

Validate supplier industry/NAICS codes from the research agent against a lookup table.

### 3.7 Supplier universe pipeline — [#82](https://github.com/kavyald/colab-ap-classifier/issues/82), [#81](https://github.com/kavyald/colab-ap-classifier/issues/81), [#89](https://github.com/kavyald/colab-ap-classifier/issues/89)

Parent issue for: finalize schema (done), implement alias matching, populate from cubes (#81), write back enriched data after classification (#89). Schema and `SupplierUniverseRow` interface exist in `colabip.ts`. `writeSupplierUniverse()` stub exists — needs merge logic. #81 and #89 are sub-issues of #82.

---

## Category 4: Improved Features for Usability

### 4.1 ColabIP sync via GitHub — [#68](https://github.com/kavyald/colab-ap-classifier/issues/68)

Push/pull taxonomy, supplier universe, and override rules to shared GitHub repo. UI to upload new taxonomy. Includes sync conflict resolution UI (previously #69, now closed and folded in). Note: `electron-builder.yml` must NOT bundle `colabip/` — should be populated via `git clone` at runtime.

### 4.2 Package for distribution — [#100](https://github.com/kavyald/colab-ap-classifier/issues/100)

`.dmg` (macOS) and `.exe` (Windows) installers. Requires fixing `process.cwd()` in 3 locations (`colabip.ts:7`, `project.ts:47`, `index.ts:38`), persisting API keys to disk, bundling DuckDB native module, and `base: './'` in Vite config. `colabip.ts` has `setColabipBasePath()` but it's initialized from `process.cwd()` at module load.

### 4.3 Global filter bar (Fibery-style) — [#107](https://github.com/kavyald/colab-ap-classifier/issues/107)

Replace per-table filter buttons with unified filter bar. Inline chips, AND/OR toggle, double-click on rows to apply filters. Would also fix 4.4 and 4.5 below.

### 4.4 Review tab data fixes — [#120](https://github.com/kavyald/colab-ap-classifier/issues/120)

- **Review page operates on incomplete data**: `Dashboard.tsx` builds filter options and aggregates from whatever transactions are loaded. Backend defaults to 50-row pages. So Dashboard filter dropdowns only show suppliers/categories from the first 50 rows, and aggregates are wrong for any dataset larger than 50 rows.
- **Hardcoded field names**: `Dashboard.tsx:184-189` references raw CSV column names (`row['Cost Center Name']`, etc.) instead of canonical names. These filter categories are always empty.
- **Filter dropdowns truncated to 50 items**: `Dashboard.tsx:194` — `suppliers: Array.from(suppliers).sort().slice(0, 50)`. Likely addressed by #107.

### 4.5 Confirm supplier fields spec — [#83](https://github.com/kavyald/colab-ap-classifier/issues/83)

Confirm the full set of editable supplier fields in Data Review (supplier type, parent name, etc.) and update `frontend_spec.md §5.3`.

### 4.6 Frontend E2E tests — [#46](https://github.com/kavyald/colab-ap-classifier/issues/46)

Comprehensive Playwright tests for all frontend workflows. 10 test scenarios covering upload → classify → review → export.

---

## Category 5: Cost Infrastructure for Scale

At 15,000+ rows the pipeline makes thousands of LLM calls and hundreds of Exa searches. Cost per run becomes a real constraint. See `internal_docs/llm_model_evaluation.md` for full model evaluation.

### Current pricing (per 1M tokens, USD)

| Model | Input | Output | Relative to Haiku 3.5 |
|-------|-------|--------|----------------------|
| GPT-4.1-nano | $0.10 | $0.40 | **0.1x** |
| GPT-4o-mini | $0.15 | $0.60 | **0.15x** |
| GPT-4.1-mini | $0.40 | $1.60 | **0.4x** |
| Claude Haiku 3.5 | $0.80 | $4.00 | 1x (current default) |
| Claude Haiku 4.5 | $1.00 | $5.00 | 1.25x |
| GPT-4.1 | $2.00 | $8.00 | 2.0x |
| GPT-4o | $2.50 | $10.00 | 2.5x |
| Claude Sonnet 4 | $3.00 | $15.00 | 3.75x |

**Exa search:** $5 per 1,000 searches. Each un-researched supplier triggers one Exa call. A 15K-row dataset with 1,000 unique suppliers = $5 in Exa alone.

### 5.1 Evaluate LLM models for pipeline agents — [#80](https://github.com/kavyald/colab-ap-classifier/issues/80)

GPT-4o-mini and GPT-4.1-mini are 2.5-5x cheaper than Haiku 3.5 with acceptable quality for structured JSON extraction. GPT-4.1-nano is 10x cheaper but untested. Known parsing quirks (inverted mappings, array-wrapped values) are already mitigated in code. Reasoning models (o3-mini, o4-mini) are overkill — our prompts are structured extraction, not open-ended reasoning.

**Next step:** Run `pipeline-run.test.ts` with Haiku 3.5 (baseline) and GPT-4.1-mini (candidate) against `innova_test`, compare accuracy and cost.

### 5.2 ✅ Reduce `maxTokens` per agent — [#108](https://github.com/kavyald/colab-ap-classifier/issues/108)

Classification 512, research 1024, canonicalization 1024, feedback 512 (down from 4096 for all). Negligible runtime or cost impact — `maxTokens` caps output length but responses are already short (~100 tokens for classification). The model doesn't generate more because the cap is higher. This is hygiene, not a real saving.

### 5.3 Prompt caching (Anthropic `cache_control`) — [#115](https://github.com/kavyald/colab-ap-classifier/issues/115)

System prompt + taxonomy is identical across all classification calls in a run. Anthropic's prompt caching would amortize tokenization — currently the same ~15K-token prefix is re-sent hundreds of times. Cached input tokens are 90% cheaper ($0.08/M vs $0.80/M for Haiku). For a 15K-row run this could save ~$3.50.

Only works with Anthropic direct (not OpenRouter). If switching to OpenAI models this becomes irrelevant. Sub-issue of #108.

### 5.4 Tail spend handling reduces LLM calls — [#70](https://github.com/kavyald/colab-ap-classifier/issues/70)

Simplified classification prompt for below-threshold transactions. If 40% of rows are tail spend, that's 40% fewer full classification calls. This is also a spec deviation — `features.md` defines tail spend handling but it was deferred from Sprint 1 and never implemented. Currently all transactions get the same full prompt regardless of spend amount.

### Cost estimate: 15,000-row run with current defaults (Haiku 3.5)

| Component | Calls | Est. tokens/call | Cost |
|-----------|-------|-------------------|------|
| Classification (input) | ~2,000 groups | ~12K input | ~$19.20 |
| Classification (output) | ~2,000 groups | ~100 output | ~$0.80 |
| Research (input) | ~1,000 suppliers | ~2K input | ~$1.60 |
| Research (output) | ~1,000 suppliers | ~200 output | ~$0.80 |
| Exa search | ~1,000 suppliers | — | ~$5.00 |
| **Total** | | | **~$27.40** |

With two-pass taxonomy + prompt caching + GPT-4.1-mini: estimate drops to ~$3-5 per run.

---

## Uncategorized / Loose Items

### Security

**SQL injection in rule evaluation** — `rules.ts:231` — `conditionToSQL` for the `regex` operator interpolates `condition.field` directly into SQL without validation. Attack surface is narrow (field names come from ColabIP CSV imports or UI rule creation, both limited to known canonical columns), but a whitelist validation would close the gap.

**Preload exposes all IPC channels** — `preload/index.ts` forwards any channel name to `ipcRenderer.invoke()`. No whitelist. A compromised renderer could call arbitrary IPC channels. Best practice is to whitelist allowed channels.

### Code Quality

**Unknown rule operators silently dropped** — `conditionToSQL` returns `null` for unrecognized operators, and the rule is silently skipped (`if (whereClauses.length === 0) continue`). Rules imported from ColabIP with typos in operators match nothing, with no warning. Risk scales with number of hand-edited ColabIP rules.

**Bare catch blocks (20+ locations)** — Silent error swallowing throughout the codebase. Some intentional (graceful degradation), many mask bugs. The worst case (`getDistinctSupplierNames`) is now tracked in Category 1 ([#112](https://github.com/kavyald/colab-ap-classifier/issues/112)). Others are less severe but should be audited.

**Duplicate CSV utilities** — `detectEncoding`, `stripBom`, `detectDelimiter` implemented identically in `upload.ts` and `canonicalization.ts`. `stripBom` also in `colabip.ts`. Should be extracted to shared utility.

**Dynamic uuid import in reclassification.ts** — `const { v4: uuidv4 } = await import('uuid')` at line 142. Every other file uses static import. No performance impact (user-triggered, not in pipeline loop). Trivial consistency fix.

**`approveFeedback` not atomic** — `feedback.ts` applies the suggestion (e.g. updates company_context), then logs to changelog, then updates status to 'approved'. If changelog or status update fails, the change is applied but feedback still shows as 'pending'. Re-approving would apply it again — creates duplicate supplier rules (not data corruption, but messy). Should wrap in transaction or update status first.

**`cancelledRunIds` memory leak** — `classification-pipeline.ts:19` — only cleaned up on successful run completion. Negligible for typical usage (a few KB after dozens of runs), only relevant after 100+ failed/cancelled runs in a single session.

**Race condition on `currentRun`** — `classification-pipeline.ts:50` — two `classification:start` calls in the same event loop tick could both pass the guard. Practically very unlikely since Electron IPC is serial per-channel and the call comes from a UI button click.

**Untyped frontend components** — `MultiTableSystem.tsx` and `Dashboard.tsx` have no TypeScript interfaces for props, row data, or event handlers. `Dashboard.tsx` has vestigial props (`datasetId`, `foldername`) that are set to dummy constants in `ReviewPage.tsx`.

### Spec Inconsistencies (doc updates only, no code changes)

- `dataset_run_id` referenced in `features.md:92` and `backend_spec.md:249` but never defined in schema or code. Implementation uses `taxonomy_node_id IS NULL`. Specs should be updated to match.
- `system_feedback.status` includes `modified` in `schema.md:283` but TypeScript type only has `pending | approved | rejected`. No code path sets `modified`. Remove from schema spec.
- Default LLM provider is `anthropic` (direct API), not OpenRouter as stated in `features.md §1` and `CLAUDE.md`. Three providers supported. Update docs.
- Pipeline step order in code (identify rows → research → rules → classify) differs from `backend_spec.md §3.3`. Code order is more efficient. Update spec to match.

### Loose GitHub Issues

**[#109 — Fix failing unit tests](https://github.com/kavyald/colab-ap-classifier/issues/109)** — 16 unit test failures on `dev`. Stale mocks, missing re-export, regex bug in changelog revert. High priority — blocks development.

### Closed Issues (for reference)

- **#73** — Parallel batch supplier research: fully implemented, closed.
- **#76** — GitHub project management: Phase 1 + Phase 2 complete, closed.
- **#69** — Sync conflict resolution UI: folded into #68, closed.
- **#64, #66, #67** — Small S1 bug fixes: superseded by #119 (batch issue), closed.
