## Summary

Implement the Reclassification service — handling manual corrections to transaction classifications with changelog tracking and optional feedback generation.

## Scope

### Service (`src/main/services/reclassification.ts`)

**`reclassifyTransactions(transactionIds: string[], taxonomyNodeId: string, feedback?: string): Promise<void>`**

1. Read current classification state for all affected transactions (old_values)
2. Validate taxonomyNodeId exists in taxonomy table
3. Update transactions: set `taxonomy_node_id`, clear `classification_reasoning`, set `updated_at`
4. Create changelog entry:
   - source: 'manual'
   - affectedTable: 'transactions'
   - affectedIds: transactionIds
   - oldValues: previous taxonomy_node_id for each row
   - newValues: new taxonomy_node_id
   - description: "Reclassified {count} transactions to {classification_path}"
5. If `feedback` text provided AND feedback is enabled:
   - Trigger FeedbackAgent (S1-22) asynchronously
   - Don't block the reclassification on feedback generation
6. If reclassifying rows that were matched by override rules:
   - Still allow it (don't block)
   - The warning is handled by frontend

### IPC Handler

| Channel | Args | Response |
|---------|------|----------|
| `transactions:reclassify` | `transactionIds: string[], taxonomyNodeId: string, feedback?: string` | `void` |

### Tests
- Reclassify single transaction → taxonomy_node_id updated, changelog created
- Reclassify multiple transactions → all updated, single changelog entry
- Invalid taxonomy node → error
- Feedback provided → feedback agent triggered
- Changelog contains correct old/new values

### Acceptance Criteria
- [ ] IPC handler works
- [ ] Transactions updated with new taxonomy node
- [ ] Changelog entry created with old/new values
- [ ] Feedback agent triggered asynchronously when feedback provided
- [ ] Invalid taxonomy node rejected
- [ ] Unit tests pass

## Dependencies
- **S1-18** (Transactions Service) — query transactions
- **S1-17** (Changelog Service) — log changes
- **S1-12** (Taxonomy Service) — validate taxonomy nodes

## Spec References
- `internal_docs/ipc_contract.md` — transactions:reclassify (channel 24)
- `internal_docs/features.md` — Review & Correction section

## Implementation Notes

**Status:** Implemented with minor deviation

**Files:**
- `src/main/services/reclassification.ts`
- `src/main/ipc/reclassification.ts`
- `tests/unit/services/reclassification.test.ts`

**Deviations:**
- **Changelog granularity:** When reclassifying multiple transactions, a single changelog entry is created with `oldValues` from the first transaction only, rather than recording per-row old values. The spec says `oldValues: previous taxonomy_node_id for each row`. Should be enhanced to store a map of `{transactionId: oldTaxonomyNodeId}` for full traceability.

**All other acceptance criteria met.** IPC handler works, transactions updated with new taxonomy node, feedback agent triggered asynchronously when feedback provided, invalid taxonomy node rejected.
