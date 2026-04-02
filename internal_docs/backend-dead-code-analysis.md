# Backend Dead Code Analysis

**Date:** 2026-04-02
**Scope:** `src/main/`, `src/shared/`, `tests/`, `scripts/`

---

## Summary

| Category | Count |
|----------|-------|
| Dead types/interfaces | 10 |
| Dead standalone functions | 5 |
| Dead service methods (interface + impl) | 5 |
| Dead exported constants | 2 |
| Duplicate type definitions | 1 (2 files) |
| Test/script-only exports (candidates for review) | 7 |
| Internal-only public methods (could be private) | 6 |
| **Total dead symbols** | **~23** |

---

## 1. Dead Types & Interfaces

### `src/shared/types/taxonomy.ts`

| Symbol | Notes |
|--------|-------|
| `TaxonomyMetadata` | Never imported anywhere. Only `TaxonomyNode` from this file is used. |
| `TaxonomySetInput` | Never imported anywhere. |
| `TaxonomyInfo` | Never imported. Duplicate of `TaxonomyMetadata` (same fields). |
| `RulePackInfo` | Never imported. Leftover from an earlier design. |

**Recommendation:** Delete all four — only `TaxonomyNode` needs to remain.

### `src/shared/types/column-mapping.ts`

| Symbol | Notes |
|--------|-------|
| `CSVPreviewWithMappings` | Extends `CSVPreview` but never imported. Spec artifact from S1-26. |
| `CanonicalColumnType` | Only used within `column-mapping.ts` itself (in `CanonicalColumnDefinition`). Never imported externally. |
| `ColumnMappingEntry` | Only used within `column-mapping.ts` itself (as value type of `ColumnMappingWithPriority`). Never imported externally. |

**Recommendation:** Remove export from `CanonicalColumnType` and `ColumnMappingEntry` (keep as unexported local types). Delete `CSVPreviewWithMappings`.

### `src/shared/types/suppliers.ts`

| Symbol | Notes |
|--------|-------|
| `Supplier` | The "shared supplier universe" model. Never imported — only `ProjectSupplier`, `ProjectSupplierView`, `SupplierInfo`, `SupplierType`, `SupplierParent`, `SupplierConfirmationStatus`, `SupplierUpdateInput`, `CsvApplyRow`, `CsvApplyDiff` are used. |

**Recommendation:** Delete the `Supplier` interface.

### `src/shared/types/services.ts`

| Symbol | Notes |
|--------|-------|
| `ResearchProgressCallback` | `type ResearchProgressCallback = (progress: ResearchProgress) => void` — never referenced outside this file. |

**Recommendation:** Delete.

### `src/shared/virtual-columns.ts`

| Symbol | Notes |
|--------|-------|
| `VirtualColumnDef` | Only used within `virtual-columns.ts` to type `VIRTUAL_COLUMN_REGISTRY`. Never imported externally. |

**Recommendation:** Remove export keyword (keep as local type).

### `src/main/services/llm-client.ts`

| Symbol | Notes |
|--------|-------|
| `ChatOptions` | Only used within `llm-client.ts`. The `LLMClient` interface in `services.ts` defines its own options shape. |

**Recommendation:** Remove export (keep as local interface) or delete if fully redundant with the `services.ts` definition.

### `src/main/agents/research-agent.ts`

| Symbol | Notes |
|--------|-------|
| `ResearchParseResult` | Only used within `research-agent.ts`. Never imported externally. |
| `SupplierResearchResult` | Only used within `research-agent.ts`. Duplicate exists in `supplier-research.ts`. |

### `src/main/agents/cat-a-agent.ts`

| Symbol | Notes |
|--------|-------|
| `CatAResolution` | Only used within `cat-a-agent.ts`. Never imported externally. |

**Recommendation for all agent types above:** Remove `export` keyword, keep as local types.

---

## 2. Dead Standalone Functions

### `src/main/services/exa-search.ts` (lines 70-76)

```typescript
// Backward compatibility exports
const defaultInstance = new ExaWebSearch();
export function isAvailable(): boolean { ... }
export async function searchSupplier(...): Promise<ExaSearchResult[]> { ... }
export function resetClient(): void { ... }
```

All three standalone functions are never imported. Production uses the `ExaWebSearch` class via DI.

**Recommendation:** Delete all three + the `defaultInstance`.

### `src/main/services/rules.ts`

| Symbol | Notes |
|--------|-------|
| `generateSingleCategoryRule` (line 83) | Exported but only called internally by `generate_rules_preview()` in the same file. |
| `generateMultiCategoryRules` (line 101) | Same — only called internally. |

**Recommendation:** Remove `export` keyword from both.

---

## 3. Dead Service Methods

These methods exist on service interfaces (`src/shared/types/services.ts`) AND implementations but are never called from any IPC handler, orchestrator, or other service:

### `AppConfigService`

| Method | Notes |
|--------|-------|
| `clearSupplierUniversePath()` | Interface (line 42) + impl (app-config.ts:172). Only appears in mock stubs (tests, scripts). |
| `clearLicenseKey()` | Interface (line 46) + impl (app-config.ts:204). Only in mock stubs. |
| `setLicenseServerUrl()` | Interface (line 50) + impl (app-config.ts:225). Only in mock stubs. |
| `setLicensePublicKey()` | Interface (line 52) + impl (app-config.ts:234). Only in mock stubs. |

### `LicenseService`

| Method | Notes |
|--------|-------|
| `stopPeriodicChecks()` | Interface (line 32) + impl (license-service.ts:103). `startPeriodicChecks` is called in `index.ts`, but `stop` is never called anywhere. |

**Recommendation:** Remove from interfaces, implementations, and mock stubs. For `stopPeriodicChecks`, consider if it should be wired to app quit — if not needed, delete.

---

## 4. Dead Exported Constants

### `src/main/utils/dedup-groups.ts`

| Symbol | Notes |
|--------|-------|
| `EXCLUDED_FIELDS` | Used internally in `dedup-groups.ts` but export is never consumed. |
| `DEFAULT_GROUP_BATCH_SIZE` | Same — used internally but never imported externally. |

**Recommendation:** Remove `export` keyword from both.

---

## 5. Duplicate Type Definitions

### `SupplierResearchResult`

Defined identically in two files:
- `src/main/agents/research-agent.ts:9`
- `src/main/services/supplier-research.ts:22`

Both extend `SupplierInfo` with `{ supplierType: string }`. Neither is imported by external files.

**Recommendation:** Consolidate into one definition (either in `shared/types/suppliers.ts` or keep in one file and import from there). Remove the duplicate.

---

## 6. Test/Script-Only Exports

These are only used in tests or `scripts/test-llm-config.ts`, never in production code. Per CLAUDE.md, agent pure functions are "intentionally exported for testing" — so the agent functions below are **by design**. The others are worth reviewing.

### By design (agent pure functions for testing)

- `classification-agent.ts`: ~18 exported prompt builder/parser functions (e.g., `buildCategorySelectionSystemPrompt`, `parseCategorySelectionResponse`, etc.)
- `cat-a-agent.ts`: `buildUserPrompt`, `parseResponse`
- `column-mapping-agent.ts`: `parseResponse`
- `research-agent.ts`: `buildSystemPrompt`, `buildUserPrompt`, `parseResponse`
- `feedback-agent.ts`: `buildSystemPrompt`, `buildUserPrompt`, `parseResponse`

### Worth reviewing

| Symbol | File | Used by |
|--------|------|---------|
| `researchSupplier()` | `agents/research-agent.ts` | Only `scripts/test-llm-config.ts` |
| `suggestMappings()` | `agents/column-mapping-agent.ts` | Only `scripts/test-llm-config.ts` |
| `chat()` standalone fn | `services/llm-client.ts` | Only tests + scripts |
| `resetEnvLoaded()` | `load-env.ts` | Only integration tests |
| `isTraceEnabled()` | `utils/llm-trace.ts` | Only tests |
| `TraceAgentType` | `utils/llm-trace.ts` | Only internal to `TraceEntry` type |
| `DedupGroup` | `utils/dedup-groups.ts` | Only internal |

**Recommendation:** Keep test-fixture exports (`resetEnvLoaded`, `isTraceEnabled`) if tests need them. The standalone legacy functions (`researchSupplier`, `suggestMappings`, `chat`) could be deleted if `scripts/test-llm-config.ts` is updated to use the DI classes instead.

---

## 7. Internal-Only Public Methods

These are public on service interfaces but only called by sibling methods within the same class. They could be made private (and removed from interfaces) unless they need to be independently testable:

| Service | Method | Called by |
|---------|--------|-----------|
| `TransactionStore` | `queryTransactions()` | Own `queryTransactionsPaginated()` + tests |
| `TransactionStore` | `getCount()` | Own `queryTransactionsPaginated()` |
| `ChangelogStore` | `getCount()` | Own `listChangesPaginated()` |
| `TaxonomyStore` | `createFromText()` | Own `importFromFile()` + tests |
| `ClassificationRunner` | `classifySupplierTransactions()` | Own `classifyAll()` + tests |
| `SupplierService` | `normalizeSupplierName()` | Own `normalizeAllTransactions()` + tests |

### Test-only service methods

| Service | Method | Notes |
|---------|--------|-------|
| `ClassificationRunner` | `getIsRunning()` | On interface, but no IPC handler (unlike QC's `getIsRunning` which IS in IPC) |
| `ProjectStore` | `isProjectOpen()` | On interface, no IPC handler. Flagged in `internal_docs/refactor/actual.html` |
| `TransactionStore` | `applyRule()` | Only in `tests/unit/services/transactions.test.ts` |
| `DuckDBSupplierUniverse` | `upsertSupplier()` | Only in integration tests. `upsertSupplierFull()` is the production method. |
| `ExaWebSearch` | `resetClient()` | Only in `exa-search.test.ts` |

---

## Suggested Cleanup Order

1. **Quick wins (type deletions):** Remove dead types from `taxonomy.ts`, `column-mapping.ts`, `suppliers.ts`, `services.ts` — zero risk, no runtime impact.
2. **Standalone function cleanup:** Delete backward-compat exports in `exa-search.ts`. Remove `export` from internal-only functions in `rules.ts` and `dedup-groups.ts`.
3. **Service interface cleanup:** Remove dead methods from `IAppConfigService` and `ILicenseService` interfaces + implementations + mock stubs.
4. **Consolidate duplicates:** Merge the two `SupplierResearchResult` definitions.
5. **Demote exports:** Remove `export` from types/constants only used internally (`VirtualColumnDef`, `ChatOptions`, `CatAResolution`, `ResearchParseResult`, `TraceAgentType`, `DedupGroup`).
6. **Optional:** Evaluate whether legacy standalone functions (`chat`, `researchSupplier`, `suggestMappings`) and `scripts/test-llm-config.ts` should be kept or modernized.
