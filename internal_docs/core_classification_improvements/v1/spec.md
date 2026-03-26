# Core Classification Improvements — Implementation Spec

**Issues:** #221, #302, #303, #306, #317, #323 (~~#301~~ cancelled — addressed structurally by this refactor)
**Date:** 2026-03-25 (v2 — revised after #317 brainstorm)

---

## Overview

Six issues under the "Core classification improvements" thread. After investigation and design discussion, the work consolidates into **four implementation tasks**.

The central design change is **splitting classification into two LLM calls** (#317), which replaces the original multi-supplier batching approach (#221) and reshapes the QC agent's responsibilities (#306).

### Target Architecture

```
Classification (deterministic baseline)
  classifyAll() → per supplier:
    1. Apply override rules → mark matched as classified_by_rule
    2. For remaining unclassified transactions:
       Call 1 (Category Selection):
         supplier name + research + parent + company context + L1|L2 taxonomy
         → returns single L1|L2 path
       Call 2 (Transaction Classification):
         transaction dedup groups + L3 nodes under chosen L1|L2
         → returns {classifications, assignments}
    3. Apply results to DB

QC (user-controlled refinement)
  runQC(config) → per supplier matching scope:
    1. If algorithmic.enabled: spend-weighted consolidation (configurable thresholds)
    2. If llm.enabled AND supplier matches gate_conditions:
       Build full supplier summary → single LLM call with user rules
       → group-level reclassification recommendations
    3. All changes flagged for human review
```

### Design Principles

- **Classification is deterministic.** One supplier → one L1|L2 → L3 assignments. No multi-L2 per supplier. No user configuration — same logic every run.
- **QC is user-controlled.** The user decides: which suppliers to review (scope), when to use LLM (gate conditions), what the LLM checks (rules prompt). Any QC change gets flagged.
- **Classification and QC have distinct roles.** Classification produces a consistent baseline. QC refines it based on user intent. The user can run QC multiple times with different prompts/scopes.
- **Tail spend is not special.** Same 2-call classification pipeline, just with empty research. Good enough for low-value spend.
- **Rules handle returning suppliers.** Generate Rules captures reviewed classifications as override rules. Returning suppliers hit rules before the LLM is invoked — Call 1 results don't need persistence.

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
  agent: 'classification-category' | 'classification-l3' | 'research' | 'column-mapping' | 'qc';
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
- Classification agent Call 1 and Call 2 — after each `llmClient.chat()` returns
- `ResearchAgent.researchSupplier()` — after `llmClient.chat()` returns
- `ColumnMappingAgent` — after `llmClient.chat()` returns
- QC agent (Task 4) — after `llmClient.chat()` returns

**Utility:** Add `npm run dev:trace` script that sets both `LOG_FILE` and `LLM_TRACE_FILE`.

**Why not log inside LLMClient?** The LLM client doesn't know the semantic context (which supplier, which agent, which call phase). Agents have this context. Keeping the trace call in agents also means we can skip tracing for agents where it's not needed.

### Not implementing (from issue)

The issue mentions "a simple system to access and sort through llm logs." For now, JSONL + grep/jq is sufficient. A UI viewer or structured DB storage is out of scope — the JSONL format is the foundation that enables future tooling.

---

## Task 2: Parent Name Injection

**Issue:** #302
**Priority:** P0 — Unblocks parent company data for Call 1.
**Size:** S

### Problem

At line 330 of `classification.ts`, `parentName` is initialized to `null` and never assigned. The `formatSupplierResearch()` function has the code to include it (`if (parentName) parts.push(...)`) but it's never reached. Meanwhile, the research agent already extracts `parentCompanyName` from web search, stores it in the supplier universe, and creates `supplier_parents` records.

### Implementation

**File:** `src/main/services/classification.ts`

Resolve parent name alongside supplier name in `classifySupplier()` (replace lines 321-333):

```typescript
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

Fallback chain: project-level parent (user-assigned or auto-created during research) → universe `parentCompanyName` → null.

The supplier name JS injection loop (lines 336-344) becomes dead code once `supplier_name` is removed from column priorities — removed as part of Task 3 cleanup.

---

## Task 3: Split Classification into Two Calls

**Issues:** #317, #221
**Priority:** P0 — Core accuracy and efficiency improvement. Replaces the original multi-supplier batching approach.
**Size:** L

### Problem

The current single-call approach sends the **full taxonomy** (~93 L3 paths with descriptions, ~4000-5000 tokens) in every LLM call. The LLM must simultaneously decide the category area AND the specific L3, while processing dedup groups. This leads to:
- Wasted tokens on irrelevant taxonomy branches
- LLM attention diluted across too many concerns
- Reduced accuracy when taxonomy is large
- Slow runtime with one call per supplier (especially when median rows/supplier is low)

### Design

Split into two sequential calls per supplier:

**Call 1 — Category Selection (supplier-level decision)**
- Input: supplier name, supplier research, parent company, company context, L1|L2 taxonomy (paths only, no L3)
- Output: single `L1|L2` string
- Purpose: "What kind of spend is this supplier?" — a strategic, supplier-level decision

**Call 2 — Transaction Classification (transaction-level decision)**
- Input: transaction dedup groups (with column priorities), L3 nodes under the chosen L1|L2, company context
- Output: `{classifications, assignments}` (same format as today)
- Purpose: "Which specific L3 for each transaction?" — a tactical, line-item decision

### Why this works

| Aspect | Current (1 call) | Split (2 calls) |
|--------|------------------|-----------------|
| Taxonomy tokens per call | ~4000-5000 (all L3 + descriptions) | Call 1: ~300-500 (L1\|L2 only). Call 2: ~500-1500 (filtered L3 under one L2) |
| LLM focus | Spread across supplier identity + all L3 paths + transaction matching | Call 1: pure supplier reasoning. Call 2: pure transaction matching against small L3 set |
| Net tokens per supplier | ~5000 taxonomy + transaction data | ~2000 taxonomy total + transaction data (in Call 2 only) |
| API calls | 1 per supplier | 2 per supplier (but each is faster/cheaper) |

### Tail spend handling

No special treatment. Tail spend suppliers (no research) follow the same 2-call pipeline. Call 1 receives the supplier name with empty research — the LLM infers what it can from the name alone. If the name is cryptic and Call 1 picks the wrong L1|L2, the QC agent (Task 4) catches it during validation.

This keeps the architecture uniform and avoids branching logic. Tail spend is low-priority by definition — "close enough" is acceptable.

### Implementation

**File:** `src/main/agents/classification-agent.ts`

1. **New: `buildCategorySelectionSystemPrompt()`**
   Focused system prompt for Call 1:
   ```
   You are a supplier category classifier. Given a supplier's identity and
   research, determine which L1|L2 spend category they belong to.

   Rules:
   - Return exactly one L1|L2 path
   - Government supplier type is a strong signal for Exempt
   - Intercompany/subsidiary → Exempt
   - Use supplier research (industry, products, NAICS) as primary signal
   - Use supplier name as fallback when research is unavailable
   - Company context helps interpret domain-specific suppliers

   Response format: {"categoryPath": "L1|L2"}
   ```

2. **New: `buildCategorySelectionUserPrompt(input)`**
   Contains:
   - L1|L2 taxonomy (just paths + L2 descriptions, no L3 nodes)
   - Company context
   - Supplier name, research, parent company

3. **New: `buildL3ClassificationSystemPrompt()`**
   Focused system prompt for Call 2:
   ```
   You are a transaction classifier. Classify transactions into L3 categories
   within the provided taxonomy branch.

   Rules:
   - Must return exactly L1|L2|L3 (3 levels)
   - Transaction fields are in priority order (most important first)
   - Prefer specific categories over "Other"
   - Tax/adjustment lines for non-government suppliers: classify with primary spend

   Response format: same {classifications, assignments} as today
   ```

4. **New: `buildL3ClassificationUserPrompt(input)`**
   Contains:
   - Only L3 nodes under the selected L1|L2 (with descriptions)
   - Company context
   - Transaction dedup groups (with column priorities)
   - Brief supplier context (name + type, not full research)

5. **New: `selectCategories(suppliers)` — batched Call 1**
   Accepts up to 10 suppliers, returns a map of supplier index → L1|L2 path:
   ```typescript
   async selectCategories(input: {
     suppliers: Array<{ name: string; research: SupplierInfo | null; parentName: string | null }>;
     taxonomy: TaxonomyNode[];
     companyContext: CompanyContext;
   }): Promise<Map<number, string>> {
     // Builds prompt with shared taxonomy/context + per-supplier sections
     // Response: {"categories": [{"supplierIndex": 1, "categoryPath": "L1|L2"}, ...]}
     // Validates each categoryPath against taxonomy
   }
   ```

6. **New: `classifyL3(input)` — per-supplier Call 2**
   Receives the L1|L2 from Call 1 and classifies transactions into L3:
   ```typescript
   async classifyL3(input: {
     categoryPath: string;          // L1|L2 from Call 1
     l3Taxonomy: TaxonomyNode[];    // pre-filtered to nodes under categoryPath
     transactions: Record<string, unknown>[];
     columnPriorities: string[];
     companyContext: CompanyContext;
     supplierName: string;
     supplierType: string | null;
   }): Promise<ClassificationResult>
   ```

7. **New: `formatL1L2Taxonomy(taxonomy)`**
   Extracts unique L1|L2 paths with L2-level descriptions.

8. **Rename:** `classifyInvoiceGroup` → `classifyTransactionGroup`. This method becomes a thin wrapper that calls `selectCategories` (single-supplier batch) + `classifyL3` for backward compatibility with tests. The production path uses the orchestrator's batched flow.

**File:** `src/main/services/classification.ts`

9. **Restructure `classifyAll()` for batched Call 1 + per-supplier Call 2:**
   ```
   1. Chunk suppliers into batches of 10
   2. Run Call 1 batches (concurrency pool) → Map<supplierId, categoryPath>
   3. For each supplier, validate categoryPath:
      - fuzzy match against taxonomy (normalizePath + findClosestTaxonomyMatch)
      - if still no match → add to retry list
   4. Retry failed suppliers individually (single-supplier Call 1)
      - if still no match after retry → mark as classification_error
   5. Run Call 2s (concurrency pool), each using its supplier's categoryPath
   ```

10. **Rename `classifySupplier()` → `classifySupplierTransactions()`:**
    Now Call 2 only. Receives `categoryPath` as a parameter (from the batched Call 1 map). Filters taxonomy to L3 nodes under that path, then calls the agent's `classifyL3()`.

**New types** in `src/shared/types/classification.ts`:
```typescript
interface CategorySelectionResult {
  categoryPath: string;  // "L1|L2"
}

// ClassificationInput stays the same — Call 1 and Call 2
// both draw from it, just using different fields
```

### What this replaces

The original Task 3 (multi-supplier batching from #221) is **partially replaced** by this approach. The split-call design reduces per-supplier taxonomy cost directly. Multi-supplier batching of the full classification (research + transactions + full taxonomy in one call) is still off the table — cross-supplier research contexts confuse the LLM and the response format becomes unwieldy. But the two-call split opens a clean batching opportunity for Call 1 specifically (see below).

### Runtime: Batching + Concurrency

At scale (10,000 suppliers), Call 2 sequential = ~11 hours. Both batching and concurrency are required.

**Call 1 — batch at 10 suppliers per call**

Call 1 is a pure supplier→L1|L2 mapping with no transaction data. The taxonomy (L1|L2 list) and company context are shared across all suppliers in a batch — sent once. Only the supplier name + research varies per entry.

Token estimates (from supplier_universe data):
- L1|L2 taxonomy + company context + system prompt: ~536 tokens fixed overhead per batch
- Per supplier: ~207 tokens median, ~300 tokens at p90
- Batch of 10 @ p90: ~3,500 tokens total — well within limits

Batch size: **10 suppliers per Call 1**. Safe at p90 research richness, easy to parse (10 one-liner responses), simple to retry individual missed entries.

Call 1 cannot be batched further than this — Call 2 (10,000 per-supplier calls) is 96% of total call volume anyway.

Response format for batched Call 1:
```json
{"categories": [
  {"supplierIndex": 1, "categoryPath": "L1|L2"},
  {"supplierIndex": 2, "categoryPath": "L1|L2"},
  ...
]}
```

Error handling: if any supplierIndex is missing from the response, fall back to individual Call 1 for that supplier only.

**Call 2 — cannot be batched**

Call 2 involves per-supplier transaction groups with integer group numbers. Batching multiple suppliers' transactions creates group numbering collisions and cross-supplier context mixing. Per-supplier is the only viable approach.

**Concurrency pool — applied to both Call 1 and Call 2**

| Concurrency | Call 2 time (10K suppliers) | Total |
|-------------|----------------------------|-------|
| 1 (sequential) | ~11 hours | ~11.5 hrs |
| 5 | ~133 min | **~2.3 hrs** |
| 10 | ~67 min | ~1.2 hrs |

Default: **concurrency 5**. Safe for all API tiers (Anthropic Tier 2 TPM limits self-throttle around 50-60 effective calls/min anyway — the retry+backoff handles it). Configurable via `CLASSIFIER_CONCURRENCY` env var for users on higher tiers.

Apply the same pool to both Call 1 batches and Call 2 calls — no separate concurrency settings needed.

**Implementation in `classifyAll()`** — replace the sequential `for...of` supplier loop with a concurrency-controlled runner. Each supplier's work unit is: wait for its Call 1 batch result (shared across 10 suppliers), then run Call 2. The Call 1 batches should be kicked off first (or pre-fetched), so Call 2 slots aren't blocked waiting for category selection.

Simplest orchestration:
1. Chunk suppliers into batches of 10
2. Run all Call 1 batches concurrently (pool of 5) → collect `Map<supplierId, categoryPath>`
3. Run all Call 2s concurrently (pool of 5), each reading from the map

Stop (#323): the existing `isCancelled` flag is renamed to `isStopped` (and `cancel()` → `stop()`, `classification:cancel` → `classification:stop`, `qc:cancel` → `qc:stop`) to reflect that stopping preserves all already-classified rows with no rollback. In the concurrent design, each work unit checks `isStopped` independently — in-flight LLM calls complete but their results are discarded if the flag is set.

### Rename

As part of this task, rename `classifyInvoiceGroup` → `classifyTransactionGroup` across the codebase.

---

## Task 4: QC Agent

**Issues:** #306
**Priority:** P1 — Quality improvement. Complements single-L2 classification.
**Size:** L

### Classification → QC Flow

Classification produces a deterministic baseline: every supplier gets exactly one L1|L2, every transaction gets an L3 under that L1|L2. This is intentionally rigid — it gives a consistent starting point.

QC is where the user takes control. After classification, the user runs QC with their chosen scope, conditions, and prompt to refine results. Examples of what a user might do with QC:

- "Take suppliers that are generally in multiple domains and expand the classification using supplier line of business and line descriptions"
- "Consolidate tax rows for non-government suppliers into their primary spend category"
- "For staffing suppliers classified under IT, move to HR|Staffing"
- "Just consolidate obvious spend fragmentation, don't reclassify anything"

The user can run QC multiple times with different configurations. Each run flags its changes for review.

### Design

The QC runner has two optional passes — algorithmic and LLM — both fully user-configured:

```
QC Configuration (stored in project_settings.qc_config):

  scope: FilterCondition[]              — which suppliers to process

  algorithmic:
    enabled: boolean                    — default true
    l3_threshold: number                — default 0.95
    l2_threshold: number                — default 0.90

  llm:
    enabled: boolean                    — default true
    gate_conditions: FilterCondition[]  — which scoped suppliers get LLM review
    rules: string                       — user prompt injected into LLM call
```

**Flow:**
```
runQC(config):
  1. Resolve scoped suppliers (apply scope FilterConditions)
  2. If algorithmic.enabled:
       Per scoped supplier with >1 L3 category:
         - L3 pass: ≥ l3_threshold spend in one L3 → consolidate outliers
         - L2 pass: ≥ l2_threshold spend in one L2,
                    ≥ l3_threshold of that L2 in one L3 → consolidate
         - Tag supplier: algorithmic_resolved = true/false
  3. If llm.enabled:
       Filter scoped suppliers by gate_conditions
       Per matching supplier:
         - Build full supplier summary
         - Single LLM call with user rules
         - Apply group-level recommendations
  4. Flag all changed transactions
```

### Defaults

Out of the box (user hasn't configured anything):

```typescript
{
  scope: [],  // all suppliers
  algorithmic: { enabled: true, l3_threshold: 0.95, l2_threshold: 0.90 },
  llm: {
    enabled: true,
    gate_conditions: [
      { field: 'algorithmic_resolved', operator: 'is_false' }
    ],
    rules: DEFAULT_QC_RULES
  }
}
```

Default behavior: algorithmic consolidation runs on everything, LLM reviews only what algorithmic didn't resolve. User can change any part.

### Gate condition fields

These fields are available for both `scope` and `gate_conditions`. They are computed per-supplier at QC runtime:

| Field | Type | Description |
|-------|------|-------------|
| `is_tail_spend` | boolean | From `project_suppliers.is_tail_spend` |
| `is_researched` | boolean | From `project_suppliers.is_researched` |
| `total_spend` | number | Sum of `spend_amount` for supplier's transactions |
| `transaction_count` | number | Count of transactions |
| `num_categories` | number | Distinct L3 classifications after classification |
| `algorithmic_resolved` | boolean | Whether algorithmic pass resolved this supplier (only available in `gate_conditions`, computed after algorithmic pass) |

### Data available to QC agent (supplier summary)

The LLM QC call receives a **full supplier summary** — the same view a human reviewer would have. This ensures any user-written prompt has the data to back it up.

**Per supplier, the summary contains:**

```
SUPPLIER CONTEXT
  Name: Acme Corp
  Type: company
  Industry: IT consulting and staffing
  Products/Services: IT consulting, staff augmentation, managed services
  Parent Company: Acme Holdings
  Tail Spend: no
  Total Spend: $163,700
  Transaction Count: 62

CURRENT CLASSIFICATIONS
  IT|Consulting|IT Consulting — $120,000 (45 txns)
    Group 1 (30 rows, $85,000): {description: "consulting services", gl_code: "6100"}
    Group 2 (15 rows, $35,000): {description: "staff augmentation", gl_code: "6100"}

  IT|Software|Custom Development — $42,500 (15 txns)
    Group 3 (12 rows, $38,000): {description: "software development", gl_code: "6200"}
    Group 4 (3 rows, $4,500): {description: "software license renewal", gl_code: "6200"}

  Exempt|Tax|Sales Tax — $1,200 (2 txns)
    Group 5 (2 rows, $1,200): {description: "sales tax payable", gl_code: "2100"}

COMPANY CONTEXT
  Industry: Technology Services
  Description: Mid-size IT services company
  Sister Companies: Acme Digital, Acme Cloud

AVAILABLE TAXONOMY
  [L1|L2|L3 paths — all paths, so LLM can recommend moves to any category]
```

**How each section is built:**

| Section | Source | Query |
|---------|--------|-------|
| Supplier context | `project_suppliers` + `supplier_parents` + `supplier_universe` | JOIN project_suppliers → supplier_parents for parent name. `supplierUniverse.getSupplier()` for research fields (type, industry, products, NAICS, etc.) |
| Current classifications | `transactions` + `taxonomy` | `GROUP BY taxonomy_node_id` with `COUNT(*)` and `SUM(spend_amount)` |
| Transaction groups | `transactions` with column priority fields | Same dedup logic as classification: `buildDedupGroups()` using column priorities from `project_settings`. Grouped per classification path. |
| Company context | `project_settings` | Keys: `company_industry`, `company_description`, `sister_companies`, `additional_details` |
| Available taxonomy | `taxonomy` table | All L3 paths with descriptions |

**Column priority fields in transaction groups:**
Transaction groups use the same dedup logic as classification — `buildDedupGroups()` with the project's configured column priorities. The field names shown in the summary are whatever the user configured as column priorities (e.g., `description`, `gl_code`, `amount`). No hardcoded column names.

**What this enables for user prompts:**

| User prompt example | Data that supports it |
|--------------------|-----------------------|
| "Consolidate tax rows for non-government suppliers" | Supplier type + transaction groups showing tax-related descriptions |
| "Expand classification for multi-domain suppliers using line of business" | Supplier research (industry, products) + transaction groups with different field values |
| "If supplier industry doesn't match L1, reclassify" | Supplier research + current classification paths + full taxonomy |
| "Staffing suppliers should be under HR, not IT" | Supplier research (products/industry) + current paths |
| "If <5% spend in a category, consolidate into dominant" | Spend amounts per classification |
| "Subsidiaries of our company → Exempt" | Parent company + sister companies from company context |

### LLM prompt structure

**System prompt** (hardcoded):
```
You are a spend classification QC agent. You review a supplier's
current classifications and recommend corrections.

You will receive a full supplier summary including: supplier identity
and research, current classifications with spend and transaction
detail, company context, and available taxonomy paths.

Apply the QC rules provided to determine what should change.
Only recommend changes that are clearly warranted by the rules.

Response format (JSON only):
{
  "recommendations": [
    {
      "groupNumbers": [3, 5],
      "toClassificationPath": "L1|L2|L3",
      "reason": "brief explanation"
    }
  ],
  "noChangeNeeded": false
}

Rules:
- groupNumbers: which transaction groups to move (from the summary)
- toClassificationPath: the target L1|L2|L3 from the available taxonomy
- If no changes needed, return {"recommendations": [], "noChangeNeeded": true}
- Every recommendation must reference valid group numbers and a valid taxonomy path
```

**User prompt:**
```
[Full supplier summary — as shown above]

## QC Rules
[User's custom rules OR default rules, inserted here]

Review the above supplier. Apply the QC rules and recommend any
reclassifications. Respond with JSON only.
```

### Default QC rules

```
- If any tax rows exist for a supplier that is NOT a government entity,
  collapse them into the supplier's primary spend category.
- If transactions fall into categories outside the supplier's known line
  of business, recommend moving them to an aligned category.
- Prefer consolidation to the dominant category when the supplier clearly
  operates in one business area.
```

### Response format and application

The LLM returns group-level recommendations:

```json
{
  "recommendations": [
    {
      "groupNumbers": [5],
      "toClassificationPath": "IT|Consulting|IT Consulting",
      "reason": "Tax rows for non-government IT supplier — consolidate into primary"
    },
    {
      "groupNumbers": [3, 4],
      "toClassificationPath": "IT|Consulting|IT Consulting",
      "reason": "Software development is core consulting service for this supplier"
    }
  ],
  "noChangeNeeded": false
}
```

**Application:**
1. For each recommendation, map `groupNumbers` → transaction IDs (via the dedup group mapping, same as classification)
2. Resolve `toClassificationPath` → `taxonomy_node_id` (using existing `findClosestTaxonomyMatch()` + fuzzy matching)
3. Update matched transactions: `taxonomy_node_id`, `classification_status = 'classified_by_qc_agent'`
4. Flag ALL transactions for the supplier: `flagged_for_review = true`

### Flagging

**Any change by QC = flagged.** No exceptions.

- Algorithmic consolidation changes: `classification_status = 'classified_by_qc_agent'`, `flagged_for_review = true`
- LLM reclassification changes: `classification_status = 'classified_by_qc_agent'`, `flagged_for_review = true`
- No change: no flagging, supplier marked clean

The user reviews flagged transactions in the Review page and can accept or override.

### Implementation

**File:** `src/main/services/qc.ts`

1. **Rewrite `runQC(config: QCConfig)`** to accept full configuration:
   ```typescript
   interface QCConfig {
     scope: FilterCondition[];
     algorithmic: {
       enabled: boolean;
       l3Threshold: number;
       l2Threshold: number;
     };
     llm: {
       enabled: boolean;
       gateConditions: FilterCondition[];
       rules: string;
     };
   }
   ```

2. **Resolve scoped suppliers** with computed fields:
   ```sql
   SELECT ps.id, ps.supplier_name, ps.is_tail_spend, ps.is_researched,
          COUNT(t.id) as transaction_count,
          COALESCE(SUM(TRY_CAST(t.spend_amount AS DOUBLE)), 0) as total_spend,
          COUNT(DISTINCT t.taxonomy_node_id) as num_categories
   FROM project_suppliers ps
   JOIN transactions t ON t.project_supplier_id = ps.id
   WHERE t.classification_status IN (classified statuses)
   GROUP BY ps.id, ps.supplier_name, ps.is_tail_spend, ps.is_researched
   ```
   Apply scope FilterConditions to this result set.

3. **Algorithmic pass** (if enabled): existing consolidation logic with configurable thresholds. Tag each supplier with `algorithmic_resolved`.

4. **LLM pass** (if enabled): filter suppliers by gate_conditions, then per supplier:
   - Build supplier summary (fetch research, transactions with column priorities, company context, taxonomy)
   - Single LLM call
   - Parse and apply recommendations

5. **New: `buildSupplierSummary(supplierId)`**
   Assembles the full supplier summary string. Delegates data fetching:
   - `project_suppliers` + `supplier_parents` (name, parent) — existing query
   - `supplierUniverse.getSupplier()` (research)
   - `project.getSetting('column_priorities')`, `project.getSetting('company_*')` (company context)
   - `transactions.getSpendByTaxonomy(supplierId)` (classifications with spend + count)
   - Per classification: `transactions.getTransactionsByTaxonomy(supplierId, nodeId, priorities)` → `buildDedupGroups()` for transaction groups
   - `taxonomy` table (all paths)

**New file:** `src/main/agents/qc-agent.ts`

6. **`QCAgent` class** — single entry point:
   ```typescript
   class QCAgent {
     async review(input: {
       supplierSummary: string;
       rules: string;
     }): Promise<QCResult>;
   }
   ```

7. **New `TransactionStore` methods** (delegate queries, don't write raw SQL in QCRunner):
   ```typescript
   // Add to TransactionStore interface in services.ts
   getSpendByTaxonomy(supplierId: string): Promise<Array<{
     taxonomyNodeId: string; fullPath: string; l1: string; l2: string;
     spend: number; txnCount: number;
   }>>;

   getTransactionsByTaxonomy(supplierId: string, taxonomyNodeId: string, columnPriorities: string[]): Promise<Array<Record<string, unknown>>>;
   ```
   `buildSupplierSummary()` calls these instead of writing raw SQL. The taxonomy JOIN, `TRY_CAST` guards, and classified-status filtering live in `TransactionStore` where they belong.

8. **QC config storage — IPC handlers:**

   All new/renamed channels must be declared in `IPCInvokeMap` (`src/shared/types/ipc-contract.ts`) with typed args/result, and added to the renderer client (`src/renderer/lib/ipc.ts`):

   - `qc:getConfig` → `{ args: []; result: QCConfig }`
   - `qc:setConfig` → `{ args: [config: QCConfig]; result: void }`
   - `qc:getDefaults` → `{ args: []; result: QCConfig }`
   - `qc:run` → `{ args: [config?: QCConfig]; result: void }`
   - `qc:stop` (rename from `qc:cancel`) → `{ args: []; result: void }`
   - `classification:stop` (rename from `classification:cancel`) → `{ args: []; result: void }`

**New dependencies for `QCRunner`:**
- `qcAgent: QCAgent` (LLM)
- `supplierUniverse: SupplierUniverse` (research)
- `project: ProjectStore` (column priorities, company context, QC config)
- `transactions: TransactionStore` (already present — now uses new methods)

Update `container.ts` to wire these.

### Interface updates (`src/shared/types/services.ts`)

All renamed/new methods must be on the interface — IPC handlers depend on interfaces, not concrete classes.

**`ClassificationAgent`** — replace current single method:
```typescript
export interface ClassificationAgent {
  selectCategories(input: {
    suppliers: Array<{ name: string; research: SupplierInfo | null; parentName: string | null }>;
    taxonomy: TaxonomyNode[];
    companyContext: CompanyContext;
  }): Promise<Map<number, string>>;

  classifyL3(input: {
    categoryPath: string;
    l3Taxonomy: TaxonomyNode[];
    transactions: Record<string, unknown>[];
    columnPriorities: string[];
    companyContext: CompanyContext;
    supplierName: string;
    supplierType: string | null;
  }): Promise<ClassificationResult>;

  // Backward compat wrapper for tests
  classifyTransactionGroup(input: ClassificationInput): Promise<ClassificationResult>;
}
```

**`ClassificationRunner`** — rename methods:
```typescript
export interface ClassificationRunner {
  classifyAll(conditions?: FilterCondition[]): Promise<void>;
  getScopeCount(conditions?: FilterCondition[]): Promise<number>;
  classifySupplierTransactions(projectSupplierId: string, categoryPath: string,
    taxonomy: TaxonomyNode[], companyContext: CompanyContext,
    columnPriorities: string[], scopedTxnIds?: Set<string>): Promise<void>;
  getIsRunning(): boolean;
  stop(): Promise<void>;  // renamed from cancel()
}
```

**`QCRunner`** — new signature:
```typescript
export interface QCRunner {
  runQC(config?: QCConfig): Promise<void>;
  getSupplierCount(filter?: TransactionFilter): Promise<number>;
  getIsRunning(): boolean;
  stop(): void;  // renamed from cancel()
}
```

**New `QCAgent` interface:**
```typescript
export interface QCAgent {
  review(input: { supplierSummary: string; rules: string }): Promise<QCResult>;
}
```

**`TransactionStore`** — add new methods:
```typescript
// Add to existing interface
getSpendByTaxonomy(supplierId: string): Promise<SpendByTaxonomyResult[]>;
getTransactionsByTaxonomy(supplierId: string, taxonomyNodeId: string,
  columnPriorities: string[]): Promise<Array<Record<string, unknown>>>;
```

---

## Edge Cases and Error Handling

### Call 1 (Category Selection)

- **No parent name or research:** Call 1 still runs. Supplier name alone is sent — the LLM infers what it can. Empty research fields are omitted from the prompt, not sent as "null".
- **Missing supplier in batched response:** If a batched Call 1 response is missing any `supplierIndex`, retry for that supplier individually. Do not re-run the entire batch.
- **Rate limit errors (429):** Caught and retried with exponential backoff (existing `LLMClient` retry logic handles this). The concurrency pool naturally throttles — if multiple workers hit rate limits, backoff slows the pool without explicit coordination.
- **Invalid L1|L2 returned:** Fuzzy match using `normalizePath()` + `findClosestTaxonomyMatch()`. If still no match, retry Call 1 individually for that supplier. If retry also fails to resolve, mark as `classification_error`.

### Call 2 (Transaction Classification)

- **L1|L2 not provided (programming error):** Throw immediately. Call 2 cannot run without a category selection from Call 1. This is a bug, not a recoverable error.
- **No L3 nodes under chosen L1|L2:** Throw with a descriptive error including the L1|L2 path. Indicates a taxonomy mismatch — the L1|L2 exists but has no L3 children.
- **Partial group assignment in response:** Existing retry logic (3 attempts, narrowing to missed groups) carries over from the current implementation.

### QC Agent

- **Empty config fields:** If any field in `QCConfig` is empty/null when it shouldn't be, fall back to the default value for that field and log a warning. Specifically:
  - `llm.rules` empty → use `DEFAULT_QC_RULES`
  - `algorithmic.l3Threshold` / `l2Threshold` missing → use 0.95 / 0.90
  - `scope` empty → all suppliers (not an error)
  - `llm.gate_conditions` empty → all scoped suppliers get LLM review
- **No classified transactions for supplier:** `getSpendByTaxonomy()` throws. QC cannot review a supplier with no classifications — skip and log error.
- **Invalid group numbers in LLM response:** Skip recommendations referencing non-existent group numbers. Log warning. Apply valid recommendations only.
- **Invalid taxonomy path in LLM response:** Use `findClosestTaxonomyMatch()` fuzzy matching. If still no match, skip that recommendation and log warning.

---

## Testing

### Task 1 (Tracing)

- Trace file is created and written to when `LLM_TRACE_FILE` is set
- Trace entries contain all required fields (agent type, supplier, prompts, response, timing)
- No file I/O when `LLM_TRACE_FILE` is unset (noop)
- JSONL format: each line is valid JSON, parseable by `jq`

### Task 2 (Parent Name)

- Parent name resolved from `supplier_parents` table when `parent_supplier_id` is set
- Falls back to `supplierResearch.parentCompanyName` when project-level parent is null
- Returns null when neither source has a parent
- Parent name appears in Call 1 prompt when present, omitted when null

### Task 3 (Split Classification)

**Call 1:**
- Returns valid L1|L2 for supplier with full research
- Returns valid L1|L2 for supplier with name only (no research, no parent) — does not error
- Batched Call 1 returns all 10 supplier mappings in correct format
- Missing suppliers in batch response triggers retry for those suppliers only
- Rate limit (429) is retried with backoff, not surfaced as classification error
- Invalid L1|L2 response falls back to fuzzy match, then individual retry, then classification_error

**Call 2:**
- Throws if L1|L2 is not provided
- Throws if no L3 nodes exist under the given L1|L2
- Correctly filters taxonomy to only L3 nodes under the chosen L1|L2
- Response parsing handles same LLM quirks as current implementation (array classificationPath, wrapper objects, markdown fences)
- Partial group assignment triggers retry for missed groups

**Stop (#323):**
- `classification:stop` IPC handler sets flag, stops processing after current supplier completes
- Already-classified transactions are preserved (no rollback)
- Progress event emitted with status 'stopped'
- Concurrent workers each check `isStopped` independently

**Integration:**
- End-to-end: CSV import → classify → verify transactions have L1|L2|L3 paths
- Mock LLM test: verify Call 1 → Call 2 sequencing with mocked responses
- Real LLM test: run against `innova_test` dataset, verify classification results

### Task 4 (QC Agent)

**TransactionStore methods:**
- `getSpendByTaxonomy(supplierId)` returns correct spend, txn count, and taxonomy path per classification group
- `getSpendByTaxonomy(supplierId)` throws if supplierId has no classified transactions
- `getSpendByTaxonomy(supplierId)` only includes transactions with classified statuses (not unclassified or error)
- `getTransactionsByTaxonomy(supplierId, nodeId, priorities)` returns transactions filtered to the given taxonomy node with only priority columns
- `getTransactionsByTaxonomy` returns empty array (not throw) if no transactions match the node

**Algorithmic pass:**
- Consolidation at configured L3 threshold (default 0.95)
- Consolidation at configured L2 threshold (default 0.90)
- No-op when supplier has single category
- Disabled when `algorithmic.enabled = false`

**LLM pass:**
- Supplier summary contains all expected sections (supplier context, classifications, transaction groups, company context, taxonomy)
- Empty `llm.rules` falls back to `DEFAULT_QC_RULES` with logged warning
- Empty `scope` processes all suppliers
- Empty `gate_conditions` sends all scoped suppliers to LLM
- Group-level recommendations correctly map to transaction IDs
- Invalid group numbers in response are skipped with warning
- Invalid taxonomy paths in response use fuzzy matching, skip if no match
- All QC changes set `classification_status = 'classified_by_qc_agent'` and `flagged_for_review = true`

**Config:**
- `qc:getConfig` returns saved config or defaults
- `qc:setConfig` persists to `project_settings`
- `qc:getDefaults` returns default config with default rules text

**Stop:**
- `qc:stop` preserves already-processed suppliers, no rollback

---

## Dependency Order

```
Task 1 (Tracing)             ← No dependencies. Do first.
    ↓
Task 2 (Parent Name)         ← Uses tracing to verify.
    ↓
Task 3 (Split Classification ← Depends on Task 2 (parent name for Call 1).
        + Batching            Uses tracing for prompt debugging.
        + Concurrency)
    ↓
Task 4 (QC Agent)            ← Depends on Task 3 (single-L2 classification
                                design shapes QC role). Reuses dedup logic
                                and taxonomy matching from classification.
```

Tasks 1 and 2 can be done together in one PR. Tasks 3 and 4 are sequential — QC's supplier summary reuses `buildDedupGroups()` from classification, and the single-L2 constraint is what makes QC's expanded role necessary.

---

## Out of Scope

| Item | Issue | Reason |
|------|-------|--------|
| Full supplier column model refactor | #301 | Addressed structurally by the 2-call design. Broader refactor is a separate project. |
| LLM trace viewer UI | #303 | JSONL + jq/grep is sufficient for now. |
| QC config editor UI | #306 | Backend stores/retrieves config (scope, gate conditions, rules, thresholds). Frontend UI for editing is a separate task. |
| Persisting Call 1 results | #317 | Generate Rules already captures supplier→taxonomy mappings. Returning suppliers hit rules before the LLM — no need to cache Call 1 output. |
