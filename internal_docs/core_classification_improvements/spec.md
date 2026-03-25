# Core Classification Improvements — Implementation Spec

**Issues:** #221, #301, #302, #303, #306
**Date:** 2026-03-24

---

## Overview

Five issues under the "Core classification improvements" thread address different aspects of the classification pipeline. After investigation, the work consolidates into **four implementation tasks** ordered by dependency and priority.

### Current Architecture (Summary)

```
classifyAll()
  → per supplier:
      1. Fetch transactions (by project_supplier_id)
      2. Apply override rules → mark matched as classified_by_rule
      3. For remaining: inject canonical supplier_name, clean descriptions
      4. buildDedupGroups() → batchDedupGroups() (max 300 groups/batch)
      5. LLM call per batch (up to 3 retry attempts per batch)
      6. Apply results to DB
  → QCRunner (post-classification):
      - Per supplier: spend-weighted consolidation (95% threshold)
      - Fallback: flag for human review
```

**Key pain points identified:**
- One LLM call per supplier is slow when median rows/supplier is low (e.g., 2)
- `parentName` is declared but never populated — dead code
- Supplier name handling has confusing overlap between transaction columns and project_suppliers FK
- No prompt/response logging for debugging misclassifications
- QC is algorithmic only; no LLM fallback for ambiguous cases

---

## Task 1: LLM Prompt & Response Tracing

**Issue:** #303
**Priority:** P0 — Do first. Enables debugging for all subsequent changes.
**Size:** S

### Problem

The only observability into LLM calls is `debugLog` statements that log supplier name, batch number, and a 60-char research preview. The actual prompt text and LLM response are never persisted. Debugging misclassifications (like #301) requires guessing what the LLM saw.

### Design

Add a lightweight, file-based trace logger that captures every LLM call's full prompt and response. Opt-in via env var, writes to a single JSONL file.

### Implementation

**New file:** `src/main/utils/llm-trace.ts`

```typescript
interface TraceEntry {
  timestamp: string;
  agent: 'classification' | 'research' | 'column-mapping' | 'qc';
  supplier?: string;
  batchIndex?: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  elapsedMs: number;
  tokenEstimate?: { input: number; output: number };
}
```

**Behavior:**
- Enabled when `LLM_TRACE_FILE` env var is set (e.g., `LLM_TRACE_FILE=/tmp/c91-trace.jsonl`)
- Each entry is one line of JSON appended to the file (JSONL format — greppable, streamable)
- The trace function is called **by each agent** after getting a response, not inside `LLMClient` itself. This gives agents control over metadata (supplier name, batch index, agent type).
- Noop when env var is unset — zero overhead in production.

**Integration points:**
- `ClassificationAgent.classifyInvoiceGroup()` — after `llmClient.chat()` returns
- `ResearchAgent.researchSupplier()` — after `llmClient.chat()` returns
- `ColumnMappingAgent` — after `llmClient.chat()` returns

**Utility:** Add `npm run dev:trace` script that sets both `LOG_FILE` and `LLM_TRACE_FILE`.

**Why not log inside LLMClient?** The LLM client doesn't know the semantic context (which supplier, which agent, which batch). Agents have this context. Keeping the trace call in agents also means we can skip tracing for agents where it's not needed.

### Not implementing (from issue)

The issue mentions "a simple system to access and sort through llm logs." For now, JSONL + grep/jq is sufficient. A UI viewer or structured DB storage is out of scope — the JSONL format is the foundation that enables future tooling.

---

## Task 2: Supplier Name Clarity + Parent Name Injection

**Issues:** #301, #302
**Priority:** P0 — Fixes active bug and unblocks parent company feature.
**Size:** M

### Problem

**#301 — Supplier name confusion:**
The current code has a workaround at line 336-344 of `classification.ts` that manually injects `project_suppliers.supplier_name` into each transaction record, overriding whatever was in `transactions.supplier_name`. This works but is fragile because:
- `transactions.supplier_name` is a dynamic canonical column that may or may not be populated
- The "real" supplier name is always `project_suppliers.supplier_name` (via FK)
- The injection happens inline, making it invisible to other code paths

**#302 — Parent name dead code:**
At line 330, `parentName` is initialized to `null` and never assigned. The `formatSupplierResearch()` function has the code to include it (`if (parentName) parts.push(...)`) but it's never reached. Meanwhile, the research agent already extracts `parentCompanyName` from web search, stores it in the supplier universe, and creates `supplier_parents` records.

### Design

Two changes:

**A. Make supplier name resolution explicit in the classification query.**

Instead of fetching transactions then patching supplier_name in JS, resolve it in the SQL query that fetches transactions for classification:

```sql
SELECT t.*,
       ps.supplier_name AS canonical_supplier_name
FROM transactions t
JOIN project_suppliers ps ON t.project_supplier_id = ps.id
WHERE t.project_supplier_id = ?
  AND t.classification_status = 'unclassified'
```

Then in dedup/prompt building, use `canonical_supplier_name` as the supplier name column. This replaces the JS-level override hack.

**B. Populate parentName from project data.**

After fetching the supplier row, also resolve the parent:

```sql
SELECT ps.supplier_name,
       sp.name AS parent_name
FROM project_suppliers ps
LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id
WHERE ps.id = ?
```

If the project-level parent is null, fall back to `supplierResearch.parentCompanyName` from the universe. This covers both:
- Suppliers where parent was auto-assigned during research
- Suppliers where user manually assigned a parent via the UI

### Implementation

**File:** `src/main/services/classification.ts`

1. **`classifySupplier()` method** — Replace lines 321-344:
   ```typescript
   // Resolve supplier name + parent in one query
   const supplierInfo = await this.db.get<{
     supplier_name: string;
     parent_name: string | null;
   }>(
     `SELECT ps.supplier_name, sp.name AS parent_name
      FROM project_suppliers ps
      LEFT JOIN supplier_parents sp ON ps.parent_supplier_id = sp.id
      WHERE ps.id = ?`,
     projectSupplierId
   );
   const supplierName = supplierInfo?.supplier_name;
   const parentName = supplierInfo?.parent_name
     ?? supplierResearch?.parentCompanyName
     ?? null;
   ```

2. **Transaction fetching** — Fetch with JOIN to get canonical name:
   ```typescript
   const txnRows = await this.db.all<TransactionRow>(
     `SELECT t.*, ps.supplier_name AS supplier_name
      FROM transactions t
      JOIN project_suppliers ps ON t.project_supplier_id = ps.id
      WHERE t.project_supplier_id = ? AND ...`,
     projectSupplierId
   );
   ```
   This eliminates the need for the post-fetch JS override loop.

3. **Remove the manual injection loop** (lines 336-344 of current code).

### Not implementing

Issue #301 mentions "Plan a refactor so that we no longer run into issues with original_supplier_name, supplier_name virtual and physical, supplier_id column and joins." A full refactor of the supplier column model is out of scope. The fix above resolves the classification-specific problem. A broader refactor (e.g., removing `supplier_name` as a canonical column entirely and always resolving via FK) would be a separate task affecting ingest, column mapping, and the column priorities system.

---

## Task 3: Classification Grouping for Low-Volume Suppliers

**Issue:** #221
**Priority:** P1 — Performance improvement.
**Size:** L

### Problem

Classification groups transactions by supplier, making one LLM call per supplier (per batch). When most suppliers have very few transactions (median = 2 in real datasets), this means hundreds of small LLM calls with high per-call overhead. Each call includes the full taxonomy and company context in the prompt, wasting tokens on repeated boilerplate.

### Design

Introduce **multi-supplier batching** for low-volume suppliers. Suppliers with few dedup groups get combined into a single LLM call, reducing total calls while maintaining classification quality.

### Algorithm

```
1. For each supplier, compute dedup group count.
2. Partition suppliers into:
   - "solo" — suppliers with > SOLO_THRESHOLD groups (e.g., > 15)
   - "batchable" — suppliers with ≤ SOLO_THRESHOLD groups
3. Solo suppliers: process as today (one LLM call per batch of 300 groups).
4. Batchable suppliers: pack into multi-supplier batches targeting
   MAX_MULTI_GROUPS groups per call (e.g., 200).
   Each batch contains multiple suppliers' groups, prefixed with supplier context.
5. For multi-supplier batches, the prompt changes:
   - System prompt: same classification rules
   - User prompt: taxonomy + company context (once), then per-supplier sections:
     [Supplier: "Acme Corp" | Research: ... | Parent: ...]
       Group 1 (3 rows): ...
       Group 2 (1 row): ...
     [Supplier: "Beta Inc" | Research: ... | Parent: ...]
       Group 3 (2 rows): ...
   - Response format: same {classifications, assignments} but group numbers are global across the batch
```

### Implementation

**File:** `src/main/services/classification.ts`

1. **New method: `buildSupplierPlan()`**
   - Query all suppliers with unclassified transaction counts
   - Partition into solo vs batchable based on dedup group count
   - Pack batchable suppliers into multi-supplier batches using first-fit-decreasing bin packing
   - Return a plan: `Array<{ type: 'solo', supplierId } | { type: 'multi', suppliers: SupplierBatchEntry[] }>`

2. **Modify `classifyAll()`**
   - Replace the per-supplier loop with plan execution
   - Solo entries: call existing `classifySupplier()` unchanged
   - Multi entries: call new `classifyMultiSupplierBatch()`

3. **New method: `classifyMultiSupplierBatch(suppliers)`**
   - For each supplier in the batch: fetch transactions, apply override rules, build dedup groups
   - Concatenate groups across suppliers with supplier context headers
   - Single LLM call with the combined prompt
   - Parse response and apply results, mapping group numbers back to their supplier/transaction IDs

**File:** `src/main/agents/classification-agent.ts`

4. **New method: `classifyMultiSupplierGroup(input: MultiSupplierInput)`**
   - `buildUserPrompt` variant that includes per-supplier sections
   - Same system prompt, same response format
   - `formatTransactions` variant that emits supplier headers between groups

**New types** in `src/shared/types/classification.ts`:
```typescript
interface MultiSupplierInput {
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
  suppliers: Array<{
    supplierName: string;
    parentName: string | null;
    supplierResearch: SupplierInfo | null;
    groups: DedupGroup[];
    groupToTransactionIds: Map<number, string[]>;
  }>;
  columnPriorities: string[];
}
```

### Constants

```typescript
const SOLO_THRESHOLD = 15;       // Groups above this → solo call
const MAX_MULTI_GROUPS = 200;    // Target groups per multi-supplier batch
```

These are tunable. Start conservative and adjust based on tracing data (Task 1).

### Parallelization

Issue #221 also mentions parallelizing LLM calls. **Do not implement parallelization in this task.** Multi-supplier batching reduces call count significantly (e.g., 200 suppliers × 2 groups → ~2 calls instead of 200). If further speed is needed after batching, parallelization can be added later with a simple concurrency pool (`Promise.all` with a semaphore). Rate limiting concerns make this a separate decision.

### Rename

Issue mentions renaming `classifyInvoiceGroup` → `classifyTransactionGroup`. Do this as part of this task since we're already modifying the agent interface. Purely cosmetic — find and replace across the codebase.

---

## Task 4: QC Agent — Algorithmic + LLM Hybrid

**Issue:** #306
**Priority:** P1 — Quality improvement.
**Size:** L

### Problem

The current QC runner is purely algorithmic (spend-weighted consolidation at 95% threshold). When a supplier's transactions don't have a dominant category, all transactions get flagged for human review with no guidance. The issue requests:
1. Adjusted thresholds (95% L3/L2, 90% for L2-only consolidation)
2. LLM-based QC agent as fallback when algorithmic passes don't fire
3. User-configurable QC prompt
4. Default prompt with tax and business-alignment rules

### Design

Extend `QCRunner` with a two-phase approach: algorithmic first (fast, cheap), then LLM for unresolved suppliers.

### Algorithm (Updated)

```
Per supplier with >1 category:
  Case 1 (Algorithmic):
    - L3 pass: if ≥95% spend in one L3, consolidate outliers
    - L2 pass: if ≥90% spend in one L2 AND ≥95% of that L2 in one L3, consolidate
    (Changed from current: L2 threshold 95% → 90%)

  Case 2 (LLM Agent — new):
    - Build supplier summary: supplier info, all classifications with spend amounts
    - Send to QC agent with user-configured (or default) prompt
    - Agent returns reclassification recommendations
    - Apply recommendations, mark as classified_by_qc_agent
    - Flag all affected rows (qc_agent_reviewed = true)
```

### Implementation

**File:** `src/main/services/qc.ts`

1. **Update thresholds:**
   ```typescript
   const L3_THRESHOLD = 0.95;
   const L2_THRESHOLD = 0.90;  // Changed from 0.95
   ```

2. **Add LLM fallback in `processSupplier()`:**
   After both algorithmic passes fail (where currently we just flag), call the QC agent:
   ```typescript
   // Neither pass fired — try QC agent
   const qcResult = await this.qcAgent.reclassify({
     supplierName,
     supplierInfo: supplierResearch,
     classifications: groups.map(g => ({
       taxonomyPath: g.full_path,
       taxonomyNodeId: g.taxonomy_node_id,
       spend: g.spend,
       transactionCount: g.txn_count,
     })),
     taxonomy: availableTaxonomy,
     customPrompt: await this.getQCPrompt(),
   });
   ```

3. **Add `getQCPrompt()` method:**
   Reads from `project_settings` table (key: `qc_prompt`). Falls back to a default prompt string.

**New file:** `src/main/agents/qc-agent.ts`

4. **`QCAgent` class:**

   **System prompt (default):**
   ```
   You are a spend classification quality control agent. You review a supplier's
   transaction classifications and recommend corrections where the current
   classification appears incorrect.

   Rules:
   - If any tax rows exist for a supplier that is NOT a government entity,
     recommend collapsing them into the next closest available classification.
   - If transactions fall into categories outside the supplier's line of business,
     strongly recommend moving them to an aligned category.
   - Prefer consolidation to the dominant category when the supplier clearly
     operates in one business area.
   - Preserve split classifications only when the supplier genuinely operates
     across multiple distinct categories.
   ```

   **User prompt:** supplier summary (name, research info, parent), current classifications with spend and count, available taxonomy paths.

   **Response format:**
   ```json
   {
     "recommendations": [
       {
         "fromTaxonomyNodeId": "...",
         "toClassificationPath": "L1|L2|L3",
         "reason": "..."
       }
     ],
     "noChangeNeeded": false
   }
   ```

5. **QC prompt storage — IPC handlers:**
   - `qc:getPrompt` — returns current custom prompt or null
   - `qc:setPrompt` — saves custom prompt to project_settings
   - `qc:getDefaultPrompt` — returns the hardcoded default prompt string

**DI wiring:** `QCRunner` constructor gains `qcAgent: QCAgent` and `supplierUniverse: SupplierUniverse` dependencies. Update `container.ts`.

### Flagging

When the QC agent makes changes:
- Transactions moved by the agent get `classification_status = 'classified_by_qc_agent'`
- All transactions for that supplier get `flagged_for_review = true` so users know the QC agent intervened and can verify

When the QC agent returns `noChangeNeeded: true`:
- No changes are made, no flagging

---

## Dependency Order

```
Task 1 (Tracing)          ← No dependencies. Do first.
    ↓
Task 2 (Supplier Name     ← Uses tracing to verify fix.
        + Parent Name)
    ↓
Task 3 (Multi-Supplier    ← Depends on Task 2 (clean supplier name
        Batching)            resolution). Uses tracing to tune thresholds.
    ↓
Task 4 (QC Agent)         ← Independent of Task 3, but logically comes
                             after classification changes stabilize.
```

Tasks 1 and 2 can be done together in one PR. Tasks 3 and 4 are independent of each other and can be parallelized.

---

## Out of Scope

These items were mentioned in the issues but are deferred:

| Item | Issue | Reason |
|------|-------|--------|
| Parallelizing LLM calls with concurrency pool | #221 | Multi-supplier batching should reduce call count enough. Add parallelism later if needed. |
| Full supplier column model refactor | #301 | The FK-based query fix in Task 2 resolves the classification bug. A broader refactor affecting ingest/mapping is a separate project. |
| "Collapse across similar categories" pre-grouping | #221 | Vague requirement. The multi-supplier batching approach is clearer and addresses the same performance problem. Revisit if batching proves insufficient. |
| LLM trace viewer UI | #303 | JSONL + jq/grep is sufficient for now. A UI can be built later on the JSONL foundation. |
| QC prompt editor UI | #306 | Backend stores/retrieves the prompt. Frontend UI for editing is a separate frontend task. |
