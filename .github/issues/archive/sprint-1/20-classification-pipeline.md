## Summary

Implement the full classification pipeline orchestrator — the core backend feature that ties together supplier research, override rules, LLM classification, and review scoring.

## Scope

### Pipeline Service (`src/main/services/classification-pipeline.ts`)

**Pipeline Steps (in order):**

1. **Create run tracker** — in-memory run state (no database table), status='pending'
2. **Supplier Research** — query suppliers lacking research data, run ResearchAgent in batches, emit progress
3. **Identify rows** — based on scope (all / new / filtered), get transaction IDs
4. **Sync override rules** — clear taxonomy+supplier rules, rebuild from ColabIP + Category A suppliers, keep project rules
5. **Apply override rules** — evaluate rules against target transactions, set taxonomy_node_id + review_score=0 for matches
6. **Group by invoice** — use invoice_grouping_columns, or treat each row as its own group
7. **Description cleaning** — if numeric chars ≥ 70% of description, strip for LLM only (don't modify DB)
8. **LLM Classification** — for each unmatched invoice group:
   - Check tail spend threshold
   - Build context (taxonomy, company, supplier, history)
   - Call ClassificationAgent
   - Write results to transactions (taxonomy_node_id, classification_reasoning)
   - Emit progress events
9. **Review score calculation** — for each classified row (not override-matched):
   - LLM call or heuristic scoring (0-100)
   - Factors: historical L1 mismatch, L2 mismatch, supplier lookup issues, description misalignment, low spend
   - Write review_score to transactions
10. **Finalize** — update run status, completed_at, log to changelog

**Progress Events:**
```typescript
interface ClassificationProgress {
  runId: string;
  status: ProjectRunStatus;
  phase: 'researching' | 'classifying';
  total: number;
  processed: number;
  percentage: number;
  currentStep: string;
}
```
Emit via `mainWindow.webContents.send('classification:progress', progress)`

**Job Control:**
- `startClassification(options): Promise<{ runId: string }>` — kick off pipeline
- `cancelClassification(runId): Promise<void>` — set flag, pipeline checks between steps
- Only one job at a time — reject if already running
- State: pending → researching → classifying → completed / failed / cancelled
- Partial failure: rows processed before error remain classified

**Run State Tracking:**
Run state is tracked in-memory only (no database table). State resets on app restart.
- runId, scope, status, progressTotal, progressProcessed, startedAt, completedAt, errorMessage

### IPC Handlers (`src/main/ipc/classification.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `classification:start` | `ClassificationStartOptions` | `{ runId: string }` |
| `classification:getStatus` | none | `ProjectRun \| null` |
| `classification:cancel` | `runId: string` | `void` |

| Event | Payload |
|-------|---------|
| `classification:progress` | `ClassificationProgress` |

### Tests
- Pipeline start → status tracking works
- Override rules applied before LLM classification
- Invoice grouping logic
- Description cleaning (70% numeric threshold)
- Cancel stops pipeline between steps
- Partial failure handling
- Progress events emitted correctly
- One-job-at-a-time enforcement

### Acceptance Criteria
- [ ] All 3 IPC handlers + 1 event work
- [ ] 10-step pipeline executes in correct order
- [ ] Override rules applied before LLM
- [ ] Invoice grouping works (with and without configured columns)
- [ ] Progress events emitted at each step
- [ ] Cancel/pause/resume work
- [ ] Only one job runs at a time
- [ ] Partial failures handled (processed rows kept)
- [ ] Changelog entry created on completion
- [ ] Unit/integration tests pass

## Dependencies
- **S1-15** (Supplier Research Service) — step 2
- **S1-16** (Override Rules Service) — steps 4-5
- **S1-18** (Transactions Service) — steps 3, 6
- **S1-19** (Classification Agent) — step 8
- **S1-12** (Taxonomy Service) — taxonomy tree for prompts
- **S1-17** (Changelog Service) — finalization logging

## Spec References
- `internal_docs/ipc_contract.md` — Classification section (channels 17-20)
- `internal_docs/features.md` — Classification Pipeline section
- `internal_docs/backend_spec.md` — pipeline architecture

## Implementation Notes

**Status:** Implemented with deviations

**Files:**
- `src/main/services/classification-pipeline.ts`
- `src/main/ipc/classification.ts`
- `tests/unit/services/classification-pipeline.test.ts`

**Deviations:**
- **Review score simplified:** Uses binary `descriptionSupplierAligned ? 0 : 50` instead of the spec's multi-factor 0-100 scoring with historical L1/L2 mismatch, supplier lookup issues, description misalignment, and low spend factors. Full review scoring should be implemented in a follow-up.
- **Pipeline steps consolidated:** Steps 6 (invoice grouping) and 7 (description cleaning) are implemented inline within the LLM classification loop rather than as distinct pipeline phases. The `cleanDescription()` function exists and correctly applies the 70% numeric threshold.
- **Historical classification scoring:** The pipeline does not query historical L1/L2/L3 classifications per supplier to factor into review scores. This is a TODO for the review score enhancement.

**Implemented correctly:**
- Run state tracked in-memory only (no database table) as specified
- All 3 IPC handlers + 1 event work
- Override rules applied before LLM classification
- Cancel stops pipeline between steps
- One-job-at-a-time enforcement
- Partial failure handling (processed rows kept)
- Changelog entry created on completion
- Progress events emitted
