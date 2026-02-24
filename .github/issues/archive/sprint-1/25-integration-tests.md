## Summary

Create end-to-end integration tests that verify the full backend workflow: project creation → data import → taxonomy setup → classification → review → export.

## Scope

### Test Suites (`tests/integration/`)

**Test 1: Full Project Lifecycle**
1. Create new project → verify .c91 file created
2. Set company context → verify stored
3. Import taxonomy from test fixture → verify nodes
4. Upload CSV → verify preview
5. Save column mappings → verify stored
6. Import CSV → verify transactions and suppliers created
7. Close project → verify cleanup
8. Reopen project → verify all data preserved

**Test 2: Classification Flow**
1. Create project with taxonomy and transactions
2. Create override rules (project source)
3. Start classification (mock LLM responses)
4. Verify override rules applied first (review_score=0 for matched)
5. Verify LLM classification called for unmatched rows
6. Verify review scores calculated
7. Verify progress events emitted
8. Verify changelog entry created

**Test 3: Reclassification & Feedback**
1. Setup: classified transactions
2. Reclassify a batch → verify updated
3. Verify changelog entry with old/new values
4. Verify feedback agent triggered (mock)
5. Approve feedback → verify action applied
6. Revert changelog entry → verify restored

**Test 4: Override Rules Evaluation**
1. Create rules with different sources and priorities
2. Create transactions matching different rules
3. Evaluate → verify first-match-wins, correct priority ordering
4. Verify rule sync clears and rebuilds

**Test 5: Export**
1. Setup: project with classified transactions
2. Export CSV → verify file content matches DB state

### Test Fixtures
- Sample CSV files (5-10 rows with typical AP data)
- Sample taxonomy (Direct/Indirect/Exempt with 10 L3 nodes)
- Sample ColabIP data (taxonomy + rules)
- LLM mock responses for all agents

### Acceptance Criteria
- [ ] All 5 test suites pass
- [ ] Tests use in-memory or temp-file DuckDB (no persistent state)
- [ ] LLM calls are mocked (no real API calls in CI)
- [ ] Test fixtures are reusable
- [ ] Tests run in < 30 seconds total
- [ ] No flaky tests (deterministic mocks)

## Dependencies
- **All previous issues** (S1-01 through S1-24) — this tests the full stack

## Spec References
- All spec documents — this validates the complete backend

## Implementation Notes

**Status:** Partially implemented

**Files:**
- `tests/integration/backend-workflow.test.ts`

**Implemented test suites:** Settings lifecycle, taxonomy + rules, reclassification + changelog, feedback approval workflow, transaction queries, supplier CRUD, error handling.

**Missing test suites from spec:**
- "Full Project Lifecycle" (create → import → classify → close → reopen) — not implemented due to complexity of mocking full DuckDB + file system lifecycle
- "Classification Flow" (override rules → LLM → review scores → progress events) — not implemented due to deep pipeline mocking requirements
- "Export" (CSV output validation) — not implemented

**Notes:**
- All tests use mocked database layer (no DuckDB dependency in CI)
- Tests run deterministically with no real API calls
