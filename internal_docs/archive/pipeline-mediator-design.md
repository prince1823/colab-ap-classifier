# Pipeline Mediator — Design Spec

## Context

The pipeline currently runs a strict sequential flow: research ALL suppliers → approval gate → classify ALL suppliers. Classification can't begin until every supplier has been researched, even though research and classification are both per-supplier operations. The pipeline service should become a true mediator — interleaving research and classification per-supplier, with periodic checkpoints for user review.

## Service Responsibilities

Three distinct services, each with a clear boundary:

- **Supplier Research** (`supplier-research.ts`) — learns *what a supplier is*. Calls web search (Exa) + LLM to determine supplier type, industry, NAICS, products/services. Writes to `supplier_universe.db`. Operates at the **supplier level** — no knowledge of transactions.

- **Classification** (`classification.ts`) — assigns **transactions** to taxonomy categories. For a given supplier's unclassified transactions: applies override rules, then sends remaining transactions + taxonomy + supplier research context to the LLM to get a taxonomy path (L1|L2|L3). Classification *consumes* research output as a signal — it reads from `supplier_universe.db` but never writes to it.

- **Pipeline** (`pipeline.ts`) — pure orchestration. Decides *when* to call research and *when* to call classification. Owns run lifecycle (start, cancel, run ID) and emits `pipeline:progress` events to the renderer. Does not perform research or classification itself — it delegates to the above services.

The mediator redesign changes **only the pipeline's orchestration strategy**. Research and classification services keep their existing logic. The pipeline just calls them at a finer granularity (per-supplier instead of all-at-once).

## Design Decisions

| Decision | Choice |
|---|---|
| Interleaving | Per-supplier: research A → classify A → research B → classify B |
| User intervention | Percentage-based checkpoints — pause at 25%, 50%, 75% for review |
| Concurrency | Sequential (no parallelism) — rate-limit safe, simple error handling |

---

## Current Flow

```
startPipeline()
  ├─ Phase 1: researchAllProjectSuppliers()     // ALL suppliers
  ├─ Phase 2: waitForApproval()                  // blocks until user clicks
  └─ Phase 3: startClassification(runId)         // ALL suppliers
```

Pipeline owns the phase state. Research and classification are opaque bulk operations.

## Proposed Flow

```
startPipeline()
  ├─ Get supplier list, compute checkpoint indices (25%, 50%, 75%)
  ├─ For each supplier:
  │    ├─ Research supplier (researchSingle)
  │    ├─ Classify supplier (classifySupplier)
  │    └─ If at checkpoint: pause, emit awaiting_review, wait for user to resume
  └─ Emit completed
```

Pipeline takes ownership of the per-supplier loop. Research and classification become leaf operations that the mediator calls individually.

---

## State Machine

**Pipeline states:**

```
idle ──startPipeline()──> processing
processing ──checkpoint──> awaiting_review
awaiting_review ──resume()──> processing
processing ──all done──> completed
processing ──error──> failed
any ──cancel()──> cancelled
```

**Per-supplier delegation tracking:**

As the pipeline processes each supplier, it delegates to two services in order: `research service → classification service → done`. The pipeline reports *which service it's currently delegating to* via the `currentService` field in progress events. This is not stored as state — it's a transient value passed to `emitProgress()` right before calling each service.

This replaces the current top-level `phase` field. The pipeline no longer has "a research phase" and "a classification phase." Instead, it tells the renderer: "I'm currently calling research for supplier X" or "I'm currently calling classification for supplier X."

---

## Checkpoint Mechanism

**Trigger**: percentage-based at 25%, 50%, 75% of total supplier count.

**Calculation** (at pipeline start):
```
checkpoints = [
  Math.floor(total * 0.25),
  Math.floor(total * 0.50),
  Math.floor(total * 0.75),
]
// De-duplicate and remove 0 or total
```

**Behavior at checkpoint**:
1. Pipeline emits progress with `status: 'awaiting_review'`
2. Pipeline blocks on a Promise (same pattern as current approval gate)
3. User reviews results in UI, then clicks "Continue" which calls `resume()`
4. Pipeline resumes from the next supplier

**Edge cases**:
- < 4 suppliers: no checkpoints (not useful to pause for 1-3 suppliers)
- Supplier count makes checkpoints collide (e.g., 5 suppliers → 25%=1, 50%=2, 75%=3): all fire, but this is fine
- User can cancel at a checkpoint instead of resuming

---

## Progress Model

**Current:**

```typescript
{
  runId: string;
  status: 'pending' | 'researching' | 'classifying' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  phase: 'researching' | 'classifying';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}
```

**Proposed:**

```typescript
{
  runId: string;
  status: 'pending' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
  currentService: 'research' | 'classification' | null;  // which service the pipeline is delegating to right now
  totalSuppliers: number;
  processedSuppliers: number;     // fully done (both research + classification complete)
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;            // human-readable, e.g., "Researching: Acme Corp"
  checkpoint?: number;            // which checkpoint (1, 2, 3) when status is awaiting_review
}
```

Key changes:
- `phase` removed — replaced by `currentService` which reports which downstream service the pipeline is currently calling
- `'researching' | 'classifying' | 'awaiting_approval'` removed from `status` — these were pipeline phases, not pipeline statuses
- `'awaiting_review'` replaces `'awaiting_approval'` — clearer intent (review results, not approve to start)
- `currentService` tells the renderer what the mediator is doing: calling research or calling classification
- `checkpoint` optional field so UI can show "Checkpoint 2 of 3"

---

## Pipeline Service Redesign

**New state:**

```
isRunning: boolean
isCancelled: boolean
currentRunId: string
reviewResolver: (() => void) | null     // checkpoint gate
reviewRejecter: ((reason?) => void) | null
```

Removed: `currentPhase`, `approvalResolver/Rejecter` (replaced by review gate).

**New exports:**

```
startPipeline()    — starts the interleaved loop
resume()           — resolves the review checkpoint (replaces approve())
cancel()           — cancels at any point
getIsRunning()     — query state
setMainWindow()    — for progress emission
```

Removed: `approve()`, `getPhase()`.

**Core loop (pseudo):**

```
async startPipeline():
  suppliers = getDistinctSuppliers()
  checkpoints = computeCheckpoints(suppliers.length)
  taxonomy = getNodes()
  companyContext = getMetadata().companyContext

  for i, supplier in suppliers:
    if cancelled: break

    // Delegate to research service
    emit({ status: 'running', currentService: 'research', currentSupplier: supplier })
    try: researchSingle(supplier)
    catch: log error, continue (research failure is non-fatal)

    if cancelled: break

    // Delegate to classification service
    emit({ status: 'running', currentService: 'classification', currentSupplier: supplier })
    try: classifySupplier(supplier, taxonomy, companyContext)
    catch: log error, mark failed txns

    processedSuppliers++

    // Checkpoint?
    if processedSuppliers in checkpoints:
      emit({ status: 'awaiting_review', checkpoint: checkpoints.indexOf(processedSuppliers) + 1 })
      await waitForReview()    // blocks until resume() called
      if cancelled: break

  emit({ status: 'completed' })
```

---

## Service Changes

**Classification** — export `classifySupplier()` as a named export (currently private). No other changes. `startClassification()` remains for standalone use. Note: `classification.ts` has its own `emitProgress()` that sends `pipeline:progress` events, but this is only used inside `startClassification()`. `classifySupplier()` itself does not emit progress — the pipeline is the sole emitter when it's running.

**Supplier Research** — minimal. `researchSingle()` is already exported and standalone. The pipeline calls it instead of `researchAllProjectSuppliers()`.

---

## IPC Changes

| Channel | Current | Proposed |
|---|---|---|
| `pipeline:start` | calls `startPipeline()` | unchanged |
| `pipeline:approve` | calls `approve()` | rename to `pipeline:resume`, calls `resume()` |
| `pipeline:cancel` | calls `cancel()` | unchanged |
| `pipeline:progress` | emits `ClassificationProgress` | emits updated progress type with `currentService` field |

---

## Frontend Impact

- **ProgressDisplay.tsx / ClassificationBanner.tsx** — replace `progress.phase === 'researching'` with `progress.currentService === 'research'`
- **ipc.ts** — rename `pipeline.approve` → `pipeline.resume`
- **Workflow store** — update `status === 'researching'` / `status === 'awaiting_approval'` checks to new status values
- **New: Review checkpoint UI** — when `status === 'awaiting_review'`, show checkpoint number and "Continue" / "Cancel" buttons

---

## Evolvability — Sequencing Strategies

The key architectural decision is making `researchSingle(supplier)` and `classifySupplier(supplier)` the atomic building blocks that the pipeline composes. The pipeline loop is the *only* thing that changes between strategies. Research and classification services are untouched.

**Strategy 1: Strict per-supplier** (simplest, start here)
```
for supplier in suppliers:
  await research(supplier)
  await classify(supplier)
```

**Strategy 2: Batch chunks** (e.g., 1/3 at a time)
```
for chunk in splitIntoChunks(suppliers, 3):
  for supplier in chunk:
    await research(supplier)
  for supplier in chunk:
    await classify(supplier)
  // checkpoint
```

**Strategy 3: Concurrent overlap** (max throughput)
```
let prevClassify = Promise.resolve()
for supplier in suppliers:
  await research(supplier)
  await prevClassify
  prevClassify = classify(supplier)  // don't await — overlap with next research
await prevClassify
```

All three use the same two functions with the same signatures. The pipeline never reaches inside these functions. Changing the sequencing strategy is a change to the pipeline's loop structure — not to any service logic.

---

## Future Extensions

- **Configurable checkpoints**: let users choose checkpoint frequency or disable them entirely.
- **Skip-supplier**: at a checkpoint, let users exclude specific suppliers from further classification.
- **Re-research**: at a checkpoint, let users trigger re-research for specific suppliers before continuing.
- **Strategy selection**: expose strategy choice in project settings (simple/batch/concurrent).
