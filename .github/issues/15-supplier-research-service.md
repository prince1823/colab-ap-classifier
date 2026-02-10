## Summary

Implement the Supplier Research service that wraps the ResearchAgent for individual and batch supplier research, and exposes the `suppliers:research` IPC channel.

## Scope

### Service (`src/main/services/supplier-research.ts`)

**Operations:**
- `researchSingle(supplierName: string): Promise<SupplierResearchResult>` — research one supplier, store results
- `researchBatch(supplierNames: string[], onProgress?: (done: number, total: number) => void): Promise<void>` — research multiple suppliers in parallel batches
  - Batch size: configurable (default 5 concurrent)
  - Skip suppliers that already have research data (unless force=true)
  - Store results in project_suppliers.supplier_info + supplier_type
  - Report progress via callback

**Integration:**
- Uses ResearchAgent for the actual LLM research
- Uses Supplier Service for storing results
- Uses ColabIP service for checking Supplier Universe first
- Uses Company Context from project metadata for the company name fallback

### IPC Handler

| Channel | Args | Response |
|---------|------|----------|
| `suppliers:research` | `supplierName: string` | `SupplierResearchResult` |

### Batch Research (used by Classification Pipeline)
- The classification pipeline (S1-20) will call `researchBatch()` as its first step
- This service provides the batch method but doesn't orchestrate the pipeline

### Tests
- Research single supplier → result stored in DB
- Batch research → parallel execution with progress
- Skip already-researched suppliers
- Error handling: one failure doesn't abort batch

### Acceptance Criteria
- [ ] `suppliers:research` IPC handler works
- [ ] Batch research with configurable concurrency
- [ ] Results persisted to project_suppliers table
- [ ] Existing research data checked before re-researching
- [ ] Unit tests pass

## Dependencies
- **S1-13** (Supplier Service) — supplier CRUD
- **S1-14** (Research Agent) — LLM research logic

## Spec References
- `internal_docs/ipc_contract.md` — suppliers:research (channel 33)
- `internal_docs/features.md` — Supplier Research section
