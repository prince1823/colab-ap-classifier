## Summary

Redesign canonicalization so the LLM produces mappings **automatically** as the default step. The human's role shifts from "configure mappings from scratch" to "review, edit, and approve" what the LLM already mapped.

### Current Flow (being replaced)

1. User uploads CSV → sees preview
2. User **manually requests** LLM suggestions via `canonicalization:suggest`
3. LLM returns suggested mappings
4. User edits/approves mappings in a manual mapping UI
5. User saves mappings via `canonicalization:save`
6. User uploads full CSV

### New Flow (LLM-first)

1. User uploads CSV → `upload:parsePreview` returns preview as before
2. **Immediately and automatically**, the backend calls the CanonicalizationAgent to produce mappings — no user action required
3. The `upload:parsePreview` response is extended to include the LLM's `CanonicalizationResult` alongside the CSV preview
4. Frontend shows the **pre-populated mappings** for review — the user sees what the LLM chose and can:
   - Edit any mapping (change which CSV column maps to which canonical column)
   - Remove a mapping (unmap a canonical column)
   - Add a mapping the LLM missed
   - Set invoice grouping columns
   - Approve all mappings
5. User saves confirmed mappings via `canonicalization:save` (unchanged)
6. User uploads full CSV via `upload:csv` (unchanged)

### Key Differences

| Aspect | Before | After |
|--------|--------|-------|
| When LLM runs | User explicitly clicks "Suggest" | Automatically during preview |
| `canonicalization:suggest` IPC | Separate call from frontend | **Removed** — folded into `upload:parsePreview` |
| What user sees first | Empty mapping form + "Suggest" button | Pre-filled mapping form ready for review |
| User's role | Configure mappings (with optional LLM assist) | Review & approve LLM mappings |
| Number of IPC round-trips | 3 (preview → suggest → save) | 2 (preview+suggest → save) |

## Scope

### Backend Changes

#### 1. Extend `upload:parsePreview` response

The `upload:parsePreview` IPC handler should call the CanonicalizationAgent automatically after parsing the CSV preview, and return both the preview and the suggested mappings in a single response.

**Updated return type:**
```typescript
interface CSVPreviewWithMappings {
  columns: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  mappingSuggestion: CanonicalizationResult;  // NEW — LLM suggestions included
}
```

**Implementation in upload service / IPC handler:**
- After parsing CSV headers + sample rows, call `canonicalizationAgent.suggestMappings(columns, sampleRows)`
- Bundle the result into the response
- If the LLM call fails, still return the preview but with a fallback empty `CanonicalizationResult` (confidence: 'low', empty mappings) so the user can map manually

#### 2. Remove `canonicalization:suggest` IPC channel

This channel is no longer needed since suggestions are returned as part of `upload:parsePreview`. Remove:
- IPC handler registration in `src/main/ipc/canonicalization.ts`
- The `suggestMappings` export from `src/main/services/canonicalization.ts` (the agent function remains — it's called from the upload flow now)

#### 3. No changes to `canonicalization:save` or `upload:csv`

These remain exactly as-is. The save flow and CSV import pipeline are unchanged.

#### 4. Update shared types

- Add `CSVPreviewWithMappings` type to `src/shared/types/canonicalization.ts` (or update `CSVPreview`)
- Alternatively, extend `CSVPreview` with an optional `mappingSuggestion` field

### Frontend Implications (future frontend issues)

The frontend canonicalization page needs to change from a "configure from scratch" workflow to a "review what the LLM did" workflow:
- On receiving the preview response, immediately display pre-filled mappings from `mappingSuggestion`
- Remove the "Suggest Mappings" button (suggestions come automatically)
- Add visual indicators showing LLM confidence per mapping
- Keep all editing capabilities (add/edit/remove mappings, grouping columns)
- The "Save" action remains the same

### Spec Documents to Update

- `internal_docs/features.md` — Section 2 (Data Import): describe LLM-first flow
- `internal_docs/backend_spec.md` — Section 2.2 (Canonicalization): update flow description
- `internal_docs/frontend_spec.md` — Section 2.2 (Column Canonicalization): describe review-first UI
- `internal_docs/ipc_contract.md` — Remove `canonicalization:suggest`, update `upload:parsePreview` response type

### Tests

- Update `upload:parsePreview` tests to verify `CanonicalizationResult` is included in response
- Update canonicalization service tests: remove `suggestMappings` service tests (the agent tests remain)
- Add test for graceful LLM failure fallback during preview
- Existing `canonicalization:save` and `importCSV` tests are unchanged

### Acceptance Criteria

- [ ] `upload:parsePreview` returns `CSVPreviewWithMappings` with LLM suggestions
- [ ] `canonicalization:suggest` IPC channel is removed
- [ ] LLM failure during preview gracefully degrades to empty mappings
- [ ] `canonicalization:save` and `upload:csv` continue to work unchanged
- [ ] Spec documents updated to reflect new flow
- [ ] All existing tests pass (with updates for changed interfaces)

## Dependencies

- **S1-08** (Upload Service) — `upload:parsePreview` handler
- **S1-09** (Canonicalization Agent) — LLM mapping logic (reused, not changed)
- **S1-10** (Canonicalization Service) — save + import (unchanged)

## Spec References

- `internal_docs/ipc_contract.md` — `upload:parsePreview`, `canonicalization:suggest` (being removed)
- `internal_docs/backend_spec.md` — Section 2.2 Canonicalization
- `internal_docs/features.md` — Section 2 Data Import
- `internal_docs/frontend_spec.md` — Section 2.2 Column Canonicalization

## Implementation Notes

**Status:** Implemented

**Files changed:**
- `src/shared/types/canonicalization.ts` — Added `CSVPreviewWithMappings` type extending `CSVPreview`
- `src/shared/types/ipc.ts` — Removed `canonicalization:suggest` from channel union (53 → 52 channels)
- `src/main/services/upload.ts` — `parsePreview` is now async, calls CanonicalizationAgent, returns `CSVPreviewWithMappings`. Exported sync `parseCSVPreview` for cases that don't need LLM suggestions. Graceful fallback on LLM failure.
- `src/main/services/canonicalization.ts` — Removed `suggestMappings` wrapper (no longer needed; upload service calls agent directly)
- `src/main/ipc/canonicalization.ts` — Removed `canonicalization:suggest` handler registration
- `tests/unit/services/upload.test.ts` — Added tests for LLM-first flow (mapping suggestions in preview, graceful degradation on LLM failure). Updated existing tests to use `parseCSVPreview`.
- `tests/unit/services/canonicalization.test.ts` — Removed `suggestMappings` tests
- `tests/integration/pipeline-e2e.test.ts` — Updated Phase 3a to async `parsePreview`, added canonicalization mock response to LLM mock

**Spec documents updated:**
- `internal_docs/features.md` — Section 2 describes LLM-first flow
- `internal_docs/backend_spec.md` — Section 2.2 updated with new IPC handlers and flow
- `internal_docs/frontend_spec.md` — Section 2.2 describes review-first UI with pre-populated mappings
- `internal_docs/ipc_contract.md` — `upload:parsePreview` returns `CSVPreviewWithMappings`, `canonicalization:suggest` removed, channel count updated

**No deviations from issue spec.**
