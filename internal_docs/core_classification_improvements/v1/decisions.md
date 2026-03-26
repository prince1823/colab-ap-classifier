# Core Classification Improvements — Deviation Decisions

Decisions made during implementation that differ from or extend the spec.

## Task 3: Split Classification

### 1. classifyTransactionGroup backward-compat wrapper routes through selectCategories + classifyL3

**Spec:** "This method becomes a thin wrapper that calls selectCategories (single-supplier batch) + classifyL3."

**Decision:** Implemented as specified, but added a legacy fallback (`_legacyClassify`) when Call 1 returns no valid category path. This prevents hard failures when the LLM returns an unrecognizable L1|L2 for a single supplier — the wrapper falls back to the original full-taxonomy single-call approach rather than throwing.

### 2. classifyAll structure: rules applied in Phase 1, not inside classifySupplierTransactions

**Spec:** The spec implies rules + Call 2 happen together in `classifySupplierTransactions`.

**Decision:** Rules are applied in a pre-pass (Phase 1) before any LLM calls. This allows the Call 1 batch to only include suppliers that actually need classification. `classifySupplierTransactions` (Call 2) only handles unclassified transactions — it queries for `classification_status = 'unclassified'` to exclude rule-matched rows.

### 3. Supplier info resolution happens in both classifyAll (for Call 1) and classifySupplierTransactions (for Call 2)

**Spec:** The spec has supplier info fetched once.

**Decision:** Supplier name, parent, and research are fetched in Phase 1 (for Call 1 batching) and again in `classifySupplierTransactions` (for injecting into transactions). This duplicates a few queries but keeps `classifySupplierTransactions` self-contained — it can be called independently (e.g., from tests) without requiring pre-fetched supplier data.

## Task 4: QC Agent

### 4. QC IPC channel renamed from `qc:start` to `qc:run`

**Spec:** The spec mentions `qc:run` but the original had `qc:start`.

**Decision:** Renamed to `qc:run` to match the spec's config-first design (the old `qc:start` took a `TransactionFilter`; the new `qc:run` takes `QCConfig`).

### 5. QC algorithmic pass flags outlier changes with flaggedForReview = true

**Spec:** Says "Any change by QC = flagged. No exceptions." but the original algorithmic pass did not flag consolidation changes.

**Decision:** Updated `pullOutliersTo` to set `flaggedForReview: true` alongside `classified_by_qc_agent` on all consolidation changes, matching the spec's flagging policy.

### 6. FilterConditionQC is a separate type from FilterCondition

**Spec:** Uses `FilterCondition[]` for scope and gate_conditions.

**Decision:** Created `FilterConditionQC` as a distinct type with QC-specific operators (`is_true`, `is_false`) and fields that are computed at QC runtime (e.g., `algorithmic_resolved`, `total_spend`). These fields don't exist in the transactions table and can't use the SQL-based `FilterCondition` from the query builder. The QC conditions are evaluated in-memory against the `SupplierQCData` objects.

### 7. QCProgress status type extended with 'stopped'

**Spec:** Uses 'cancelled' for stop status.

**Decision:** Kept 'cancelled' as the progress status for stop since the QC progress UI already handles it. The `ClassificationProgress` type was extended with 'stopped' per spec but QC uses the existing 'cancelled' for consistency with the current renderer.

## Task 3 (Revision): Chunked Call 1 → Call 2 Pipeline

### 8. Replace two-phase architecture with chunked pipeline

**Problem:** The current `classifyAll` runs ALL Call 1 (category selection) for every supplier into an in-memory `Map<string, string>` (`categoryMap`) before starting ANY Call 2 (L3 classification). At 10,000 suppliers this means:
- 1,000 LLM calls complete before a single transaction gets classified
- If the process crashes between Phase 2 and Phase 3, all Call 1 results are lost (zero transactions classified)
- Peak memory holds all 10k category paths simultaneously
- Progress feels stalled — user sees "Selecting categories" for a long time before any real classification happens

**Decision:** Restructure into a chunked pipeline where each batch of suppliers flows through Call 1 → Call 2 before moving to the next batch. The `categoryMap` is eliminated.

**Current flow (two-phase):**
```
Phase 1: Override rules for all suppliers → collect suppliersNeedingClassification
Phase 2: runPool(Call 1 batches, concurrency) → populate categoryMap (all suppliers)
Phase 3: runPool(Call 2 tasks, concurrency) → read from categoryMap (all suppliers)
```

**New flow (chunked pipeline):**
```
Phase 1: Override rules for all suppliers → collect suppliersNeedingClassification
Phase 2: For each chunk of CALL1_BATCH_SIZE suppliers:
           Call 1 (one LLM call for the batch) → get category paths
           Call 2 (concurrent per supplier in chunk) → classify L3
         Chunks processed via runPool at configured concurrency
```

**Changes required:**

1. **`src/main/services/classification.ts` — `classifyAll` method**
   - Remove `categoryMap` local variable
   - Merge Phase 2 and Phase 3 into a single loop over batches
   - Each batch task: call `selectCategories` for the batch, then immediately run `classifySupplierTransactions` for each supplier in that batch
   - Individual retry logic for failed Call 1 suppliers stays the same (retry single then mark error)
   - Progress events update after each chunk completes (not after all Call 1s)

2. **No changes to:**
   - `classifySupplierTransactions` — unchanged, still receives `categoryPath` as argument
   - `ClassificationRunner` interface in `services.ts` — public API unchanged
   - `classification.ts` IPC handler — unchanged, still calls `classifyAll(conditions)`
   - `ClassificationAgent` — `selectCategories` and `classifyL3` signatures unchanged
   - `runPool` utility — still used for concurrency within each chunk's Call 2 tasks

3. **Progress emission:**
   - Currently: "Selecting categories" for entire Phase 2, then per-supplier "Classifying: X" for Phase 3
   - New: per-chunk progress alternates between category selection and classification, giving more responsive feedback
   - `processedSuppliers` counter increments after each supplier's Call 2 completes (same as before)

**Why chunked pipeline over DB persistence:**
- No schema changes needed — no new columns or tables for intermediate state
- No cleanup logic for stale Call 1 data on re-runs or interrupted runs
- Call 1 result is just a string per supplier (`"Corporate Services|IT"`) — ephemeral by nature
- Crash resilience comes from incremental progress: if it crashes at supplier 5,000, the first 4,990 are already classified in the DB via Call 2's `updateTransactions`
- Simpler code — one loop instead of two phases plus a shared map
