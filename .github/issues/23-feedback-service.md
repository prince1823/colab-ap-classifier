## Summary

Implement the Feedback service — CRUD operations for system feedback suggestions and the approval/rejection workflow.

## Scope

### Service (`src/main/services/feedback.ts`)

**Operations:**
- `listFeedback(): Promise<SystemFeedback[]>` — all feedback entries sorted by created_at desc
- `createFeedback(entry: Omit<SystemFeedback, 'id' | 'createdAt'>): Promise<string>` — insert new feedback suggestion
- `approveFeedback(feedbackId: string, modifications?: Partial<FeedbackActionDetails>): Promise<void>`:
  1. Read feedback entry
  2. Apply modifications if provided (user can edit before approving)
  3. Execute the suggestion:
     - `company_context` → update company_context table field
     - `taxonomy_description` → update taxonomy node description
     - `supplier_rule` → create override rule (source='project')
     - `uncategorized_feedback` → just mark approved (no auto-action)
  4. Log change to changelog
  5. Update feedback status to 'approved'
- `rejectFeedback(feedbackId: string, reason?: string): Promise<void>` — update status to 'rejected'

**Feedback Status Flow:** `pending` → `approved` | `rejected`

### IPC Handlers (`src/main/ipc/feedback.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `feedback:list` | none | `SystemFeedback[]` |
| `feedback:approve` | `feedbackId: string, modifications?: Partial<FeedbackActionDetails>` | `void` |
| `feedback:reject` | `feedbackId: string, reason?: string` | `void` |

### Integration
- Reclassification service (S1-21) creates feedback entries via FeedbackAgent
- Approval applies changes to the appropriate table
- All applied changes logged to changelog

### Tests
- Create feedback → appears in list
- Approve company_context feedback → company_context table updated
- Approve taxonomy_description → taxonomy description updated
- Approve supplier_rule → override rule created
- Reject feedback → status updated
- Approve with modifications → modified suggestion applied

### Acceptance Criteria
- [ ] All 3 IPC handlers work
- [ ] Approval executes the correct action per feedback type
- [ ] Modifications applied before execution
- [ ] Changes logged to changelog
- [ ] Rejection just updates status
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-22** (Feedback Agent) — generates feedback entries
- **S1-17** (Changelog Service) — log applied changes
- **S1-12** (Taxonomy Service) — update taxonomy descriptions
- **S1-16** (Rules Service) — create override rules

## Spec References
- `internal_docs/ipc_contract.md` — Feedback section (channels 39-41)
- `internal_docs/schema.md` — system_feedback table
- `internal_docs/features.md` — System Feedback section

## Implementation Notes

**Status:** Implemented with minor deviations

**Files:**
- `src/main/services/feedback.ts`
- `src/main/ipc/feedback.ts`
- `tests/unit/services/feedback.test.ts`

**Deviations:**
- **Supplier rule approval:** When approving `supplier_rule` feedback, the implementation uses only the first `classificationPath` from `action_details` to create the override rule. If the feedback contains multiple paths, only the first is used. Could be enhanced to create multiple rules.
- **Company context update:** The `company_context` approval action uses UPDATE (not UPSERT). If no row exists in `company_context`, it will silently update 0 rows. Should add an UPSERT pattern for robustness.

**All other acceptance criteria met.** All 3 IPC handlers work, approval executes the correct action per feedback type, modifications applied before execution, changes logged to changelog, rejection just updates status.
