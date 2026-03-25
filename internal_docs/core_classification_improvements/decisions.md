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
