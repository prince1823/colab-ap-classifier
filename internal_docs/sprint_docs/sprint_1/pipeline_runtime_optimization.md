# Pipeline Runtime Optimization — Potential Changes

**Issue:** [S2-18: Reduce classification pipeline runtime](https://github.com/kavyald/colab-ap-classifier/issues/108)
**Date:** 2026-02-20
**Source:** Two independent codebase audits (`audit_codebase_vs_specs.md`, `codebase_audit.md`)

---

## A. Batch DB Writes

All follow the same anti-pattern: `for (const x of items) { await databaseService.run(...) }` — one awaited round-trip per row instead of bulk operations.

### A1. Classification result writes — row-by-row UPDATE

**File:** `src/main/services/classification-pipeline.ts:294-301`

```typescript
for (const txnId of group.transactionIds) {
  await databaseService.run(
    `UPDATE transactions SET taxonomy_node_id = ?, ... WHERE id = ?`,
    taxonomyNodeId, result.reasoning, reviewScore, txnId
  );
}
```

**Est. impact:** 10-50s for 10K rows (each DuckDB write has ~1-5ms overhead).

**Fix:** Batch per group with `UPDATE ... WHERE id IN (...)`.

---

### A2. CSV import — row-by-row INSERT

**File:** `src/main/services/canonicalization.ts:256-268`

```typescript
for (let i = 0; i < allRecords.length; i++) {
  await databaseService.run(insertSQL, ...values);
}
```

**Est. impact:** 60-300s for 50K rows. Likely the single largest import bottleneck.

**Fix:** Use DuckDB's appender API, multi-row INSERT, or `COPY` from a temp file.

---

### A3. Supplier stats update — row-by-row UPDATE

**File:** `src/main/services/canonicalization.ts:395-401`

Individual UPDATE per supplier during import.

**Est. impact:** Seconds for 500+ suppliers.

**Fix:** Single UPDATE with CASE expression or temp table join.

---

### A4. Supplier inserts — row-by-row INSERT

**File:** `src/main/services/canonicalization.ts:305-344`

Individual INSERT per new supplier during import.

**Fix:** Multi-row INSERT with VALUES list.

---

### A5. Override rule match writes — row-by-row UPDATE

**File:** `src/main/services/classification-pipeline.ts:174-184`

Individual UPDATE per matched transaction.

**Est. impact:** Seconds for 3K+ rule matches.

**Fix:** Batch with `UPDATE ... WHERE id IN (...)`.

---

### A6. Column mapping saves — row-by-row INSERT

**File:** `src/main/services/canonicalization.ts:44-59`

Individual INSERT per mapping entry and grouping column.

**Est. impact:** Minor (small N, typically <20 mappings).

**Fix:** Multi-row INSERT.

---

## B. LLM Token & Call Efficiency

### B1. Full taxonomy sent in every classification LLM call

**File:** `src/main/agents/classification-agent.ts:146-168, 243-258`

The entire taxonomy tree (all L3 nodes with descriptions) is serialized into every single LLM call. A typical taxonomy has 200-500 L3 nodes = 5,000-15,000 tokens per call.

For 500 invoice groups: `500 × ~10K tokens = 5M input tokens` just for taxonomy.

**Fix options (pick one or combine):**
1. **Two-pass classification:** First call picks L1 (send only L1 names, ~20 tokens). Second call picks L2/L3 within that L1 (send only that subtree). Cuts taxonomy tokens by ~90%.
2. **Pre-filter taxonomy by supplier type/industry:** If supplier research says "IT Services", only send IT-related branches.
3. **Prompt caching:** Use Anthropic's `cache_control` parameter to avoid re-tokenizing the static system prompt + taxonomy prefix across calls.

---

### B2. All transaction fields sent to LLM (including system columns)

**File:** `src/main/agents/classification-agent.ts:214-228`

`formatTransactions` sends every non-null field including `id`, `row_index`, `created_at`, `updated_at`, `taxonomy_node_id`, `classification_reasoning`, `invoice_group_key`, `review_score`.

**Est. impact:** 20-40% input token reduction by filtering.

**Fix:** Filter to only classification-relevant fields: `supplier_name`, `line_description`, `gl_description`, `gl_code`, `spend_amount`, `department`, `cost_center`, `po_number`, `invoice_date`, `company`, `memo`.

---

### B3. `maxTokens: 4096` on every LLM call

**Files:** All four agents — `classification-agent.ts:538`, `research-agent.ts:249`, `canonicalization-agent.ts:235`, `feedback-agent.ts:408`

Expected response sizes: classification ~100 tokens, research ~200, canonicalization ~300, feedback ~200.

**Fix:** Set realistic values: 512 for classification, 1024 for research, 1024 for canonicalization, 512 for feedback. Reduces latency on some providers that allocate resources based on `maxTokens`.

---

### B4. System prompt rebuilt per call — no prompt caching

**File:** `src/main/agents/classification-agent.ts:32-141`

The ~1,500-token system prompt is a static string but rebuilt every call. Combined with taxonomy, input is dominated by repeated boilerplate.

**Fix:** Use Anthropic's prompt caching (`cache_control` parameter on system message). Amortizes system prompt + taxonomy tokenization cost across all calls in a run.

---

## C. Concurrency / Batch Sizes

### C1. `CLASSIFICATION_BATCH_SIZE = 7`

**File:** `src/main/services/classification-pipeline.ts:208`

Groups processed in batches of 7 via `Promise.all`, batches are sequential. At ~2s/call, 500 groups = `(500/7) × 2s ≈ 143s`.

**Fix:** Increase to 15-20. OpenRouter and Anthropic both support higher concurrent request rates. Cuts LLM wait time by ~50%.

---

### C2. Supplier research `BATCH_SIZE = 5`

**File:** `src/main/services/supplier-research.ts:100`

5 concurrent research calls per batch. 200 suppliers at ~2s each = `(200/5) × 2s = 80s`.

**Fix:** Increase to 10-15. Cuts research time by ~50%.

---

## D. Database Indexes

### D1. Missing `idx_transactions_supplier`

**File:** `src/main/services/database.ts:209`

Only one index exists: `idx_transactions_taxonomy`. No index on `supplier_name`, which is used by rule evaluation, supplier stats queries, and distinct supplier queries — all perform full table scans.

**Fix:** Add after column creation in canonicalization:
```sql
CREATE INDEX IF NOT EXISTS idx_transactions_supplier ON transactions(supplier_name);
```

---

### D2. Missing indexes on `review_score` and `row_index`

`review_score` is filtered in frontend queries (`WHERE review_score > 0`). `row_index` is used in `ORDER BY` for transaction queries and export.

**Fix:**
```sql
CREATE INDEX IF NOT EXISTS idx_transactions_review_score ON transactions(review_score);
CREATE INDEX IF NOT EXISTS idx_transactions_row_index ON transactions(row_index);
```

---

## E. Redundant I/O & Parsing

### E1. `fs.readFileSync` blocks the Electron main process

**Files:** `src/main/services/upload.ts:162`, `src/main/services/canonicalization.ts:194`

Entire CSV loaded synchronously. For a 100MB file, this blocks the UI for seconds.

**Fix:** Use `fs.readFile` (async) at minimum. For large files, stream with `fs.createReadStream`.

---

### E2. CSV parsed 4+ times during upload flow

1. `upload.ts:detectDelimiter()` — tries 3 delimiters (up to 3 full parses)
2. `upload.ts:parseCSVPreview()` — full parse for preview
3. `canonicalization.ts:importCSV()` — full re-parse during import

**Fix:** Parse once and cache the result, or pass the file path to DuckDB's native CSV reader (`read_csv()`).

---

### E3. Supplier universe CSV re-read on every pipeline run

**File:** `src/main/services/supplier-research.ts:121`

`readSupplierUniverse()` reads and parses the entire ColabIP CSV from disk on every pipeline run. Data doesn't change between runs.

**Fix:** Cache after first load; invalidate only on ColabIP sync.

---

### E4. `getColumns()` queries `information_schema` on every call

**File:** `src/main/services/transactions.ts:151-156`

Called on every `queryTransactions()` and `getStats()`. Column schema is stable after import.

**Fix:** Cache column list after first call; invalidate on `ALTER TABLE`.

---

## F. Query Efficiency

### F1. `SELECT *` fetches all columns for classification grouping

**File:** `src/main/services/classification-pipeline.ts:442-444`

`groupTransactionsByInvoice` does `SELECT * FROM transactions WHERE id IN (...)`. Classification only needs ~6 fields.

**Fix:** `SELECT id, supplier_name, gl_description, line_description, spend_amount, gl_code, ...` — only the columns relevant to classification.

---

### F2. Rule evaluation runs N separate full-table-scan queries

**File:** `src/main/services/rules.ts:138-175`

Each active rule triggers its own `SELECT id FROM transactions WHERE ...`. 20 rules × 50K rows = 20 full table scans.

**Fix:** Consolidate into fewer queries (e.g., UNION ALL), or evaluate rules in-memory after a single data fetch.

---

### F3. `IN (...)` with thousands of placeholders

**Files:** `classification-pipeline.ts:406`, `classification-pipeline.ts:441`, `reclassification.ts:34`, `rules.ts:161`

For 50K transactions, this creates IN clauses with 50K placeholders.

**Fix:** Use temporary tables or CTEs for large ID sets.

---

## G. LLM Reliability (reduces runtime via fewer wasted calls / re-runs)

### G1. No LLM retry logic

**File:** `src/main/services/llm-client.ts`

`chat()` makes a single attempt. A 429 or 503 fails the entire invoice group. With 1% transient error rate across 500 groups, ~5 groups silently fail, potentially requiring a full re-run.

**Fix:** Exponential backoff retry (2-3 attempts) for retryable HTTP codes (429, 500, 502, 503, 504).

---

### G2. Failed classification groups silently swallowed

**File:** `src/main/services/classification-pipeline.ts:283-303`

Failed groups get no DB marker — remain indistinguishable from unprocessed rows. Users re-run the entire pipeline to catch misses.

**Fix:** Write a sentinel value (e.g., `review_score = -1` or a `classification_status` column) on failed groups. Enables targeted re-classification instead of full re-runs.

---

## Summary

### Implemented

| # | Change | Commit | Process Stage |
|---|--------|--------|---------------|
| A1 | Batch classification result UPDATEs (`WHERE id IN`) | `aa4029d` | Classification |
| A2 | Batch CSV import INSERTs (batches of 500) | `aa4029d` | CSV Import |
| A3 | Batch supplier stats UPDATEs (CASE expressions) | `aa4029d` | CSV Import |
| A4 | Batch supplier INSERTs (multi-row VALUES) | `aa4029d` | CSV Import |
| A5 | Batch override rule match UPDATEs (grouped by target node) | `aa4029d` | Classification |
| A6 | Batch column mapping INSERTs (single multi-row INSERT) | `aa4029d` | CSV Import |
| B2 | Filter system fields from LLM prompts (EXCLUDED_FIELDS set) | `d92ac6e` | Classification |
| B3 | Reduce maxTokens per agent (512-1024 from 4096) | `d92ac6e` | Classification |
| C1 | Classification batch size 7 → 8 | `aa4029d` | Classification |
| C2 | Supplier research batch size 5 → 10 | `aa4029d` | Classification |
| D1 | Add `idx_transactions_supplier` index | `78f4e7a` | CSV Import / Data Review |
| E4 | Cache `getColumns()` in memory (invalidated on project open + ALTER TABLE) | `78f4e7a` | Data Review |
| G1 | LLM retry with exponential backoff | `64215ba` | Classification |
| — | Batch supplier name resolution UPDATEs (CASE, 200/batch) | `78f4e7a` | CSV Import |
| — | Consolidate `getStats()` from 5 queries to 1 | `78f4e7a` | Data Review |

### Not implemented

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| B1 | Reduce taxonomy tokens (hierarchical format / supplier-type filtering) | Medium | High — 50-90% input token reduction |
| B4 | Prompt caching (provider-specific, Anthropic `cache_control`) | Medium | Medium — amortizes prefix tokens |
| D2 | Indexes on `review_score` and `row_index` | Trivial | Low |
| E1 | Async file reads (`readFileSync` → `readFile`) | Low | Low — blocks main process for large files |
| E2 | Eliminate redundant CSV parsing (parsed 3-4× during upload) | Medium | Medium — CPU time on large files |
| E3 | Cache supplier universe CSV between runs | Low | Low |
| F1 | SELECT only needed columns in `groupTransactionsByInvoice` | Low | Low — DuckDB columnar, minimal gain |
| F2 | Consolidate rule evaluation into fewer queries | Medium | Medium — fewer full table scans |
| F3 | Temp tables for large IN(...) clauses | Medium | Low — only matters at 50K+ rows |
| G2 | Mark failed classification groups with sentinel value | Low | Low — enables targeted re-runs |
