# Backend Dead Code Analysis

**Date:** 2026-04-02
**Updated:** 2026-04-02 (revised with API contract lens)
**Status:** ✅ Complete — all removals and unexports implemented
**Scope:** `src/main/`, `src/shared/`, `tests/`, `scripts/`

---

## Methodology

Original analysis identified ~23 symbols with zero callers. Revised analysis applies an additional filter: **does the symbol complete an API contract?** A method with zero callers today is still valuable if it's the natural counterpart to a method that *is* called (get/set/clear, start/stop, create/delete). Removing it creates an asymmetric API that's a footgun for future development.

Only symbols that are both unused AND from abandoned/superseded designs are recommended for removal.

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| Abandoned types (from superseded designs) | 7 | **Delete** |
| Internal-only exported types/constants | 11 | **Unexport** (remove `export` keyword) |
| Superseded standalone functions | 3 | **Delete** |
| Internal-only exported functions | 2 | **Unexport** |
| Duplicate type definitions | 1 (2 files) | **Consolidate** (unexport one copy) |
| Service methods with zero callers | 5 | **Keep** — complete API contracts |
| Internal-only public interface methods | 6 | **Keep** — building blocks, tested independently |
| Test/script-only exports | 7 | **Keep** — by design or needed by tests |
| **Symbols to remove/unexport** | **~24** | |
| **Symbols to keep (false positives)** | **~18** | |

---

## 1. Abandoned Types — DELETED

These types were from designs that were fully replaced.

| Symbol | File | Why it's dead |
|--------|------|---------------|
| `TaxonomyMetadata` | `shared/types/taxonomy.ts` | S1 design. Current taxonomy API uses `TaxonomyNode` only. |
| `TaxonomySetInput` | `shared/types/taxonomy.ts` | S1 design. `TaxonomyStore.createFromText()` replaced this shape. |
| `TaxonomyInfo` | `shared/types/taxonomy.ts` | Duplicate of `TaxonomyMetadata` — doubly dead. |
| `RulePackInfo` | `shared/types/taxonomy.ts` | ColabIP "rule packs" concept was dropped entirely. |
| `CSVPreviewWithMappings` | `shared/types/column-mapping.ts` | S1-26 spec artifact. Ingest pipeline returns `CSVPreview` + `ColumnMappingResult` separately. |
| `Supplier` | `shared/types/suppliers.ts` | Old flat universe model. Replaced by FK-based `ProjectSupplier` + `SupplierInfo` in v2 refactor. `SupplierUniverse.getSupplierRecord()` returns a different shape. |
| `ResearchProgressCallback` | `shared/types/services.ts` | Never referenced. Progress goes through `EventBus`, not callbacks. |

---

## 2. Internal-Only Exports — UNEXPORTED

These symbols were used within their own file but never imported externally. `export` keyword removed to tighten visibility.

### Types/Interfaces

| Symbol | File | Used by (within file) |
|--------|------|-----------------------|
| `CanonicalColumnType` | `shared/types/column-mapping.ts` | `CanonicalColumnDefinition.type` |
| `ColumnMappingEntry` | `shared/types/column-mapping.ts` | `ColumnMappingWithPriority` value type |
| `VirtualColumnDef` | `shared/virtual-columns.ts` | `VIRTUAL_COLUMN_REGISTRY` record type |
| `ChatOptions` | `main/services/llm-client.ts` | `OpenRouterLLMClient.chat()` param type |
| `ResearchParseResult` | `main/agents/research-agent.ts` | `parseResponse()` return type |
| `SupplierResearchResult` | `main/agents/research-agent.ts` | `parseResponse()` result field (duplicate exists in `supplier-research.ts`) |
| `CatAResolution` | `main/agents/cat-a-agent.ts` | `parseResponse()` return type |
| `TraceAgentType` | `main/utils/llm-trace.ts` | `TraceEntry.agent` field type |
| `DedupGroup` | `main/utils/dedup-groups.ts` | Structural type, never imported |

### Constants

| Symbol | File | Used by (within file) |
|--------|------|-----------------------|
| `EXCLUDED_FIELDS` | `main/utils/dedup-groups.ts` | `extractFields()`, column filtering |
| `DEFAULT_GROUP_BATCH_SIZE` | `main/utils/dedup-groups.ts` | `batchDedupGroups()` default param |

---

## 3. Superseded Standalone Functions — DELETED

### `src/main/services/exa-search.ts`

```typescript
const defaultInstance = new ExaWebSearch();
export function isAvailable(): boolean { ... }
export async function searchSupplier(...): Promise<ExaSearchResult[]> { ... }
export function resetClient(): void { ... }
```

Pre-DI backward compatibility shim. Production uses `ExaWebSearch` class injected via container. Tests rewritten to use class directly.

### `src/main/services/rules.ts` — UNEXPORTED

| Symbol | Action | Reason |
|--------|--------|--------|
| `generateSingleCategoryRule` | **Unexported** | Only called by `generate_rules_preview()` in the same file. |
| `generateMultiCategoryRules` | **Unexported** | Only called by `generate_rules_preview()` in the same file. |

---

## 4. Duplicate Type — CONSOLIDATED

### `SupplierResearchResult`

Was defined identically in two files:
- `src/main/agents/research-agent.ts`
- `src/main/services/supplier-research.ts`

Both extend `SupplierInfo` with `{ confidence, sources }`. Neither is imported externally.

**Done:** Unexported the copy in `research-agent.ts` (kept as local type). The copy in `supplier-research.ts` remains as-is.

---

## 5. NOT Dead — API Contract Methods (KEEP)

These methods have zero callers today but complete a coherent API. Removing them creates asymmetric interfaces.

### `IAppConfigService`

| Method | Counterpart(s) in active use | Why keep |
|--------|------------------------------|----------|
| `clearSupplierUniversePath()` | `getSupplierUniversePath()` ✓, `setSupplierUniversePath()` ✓ | get/set/clear triad. "Disconnect universe" is a valid future action. |
| `clearLicenseKey()` | `getLicenseKey()` ✓, `setLicenseKey()` ✓ | get/set/clear triad. License deactivation needs this. Also clears cached license data. |
| `setLicenseServerUrl()` | `getLicenseServerUrl()` ✓ | get/set pair. Server URL must be configurable for self-hosted license servers. |
| `setLicensePublicKey()` | `getLicensePublicKey()` ✓ | get/set pair. Key rotation requires this. |

### `ILicenseService`

| Method | Counterpart in active use | Why keep |
|--------|---------------------------|----------|
| `stopPeriodicChecks()` | `startPeriodicChecks()` ✓ (called in `index.ts`) | start/stop pair. Should be wired to app quit for clean shutdown. Removing creates an interval leak. |

---

## 6. NOT Dead — Building Block Methods (KEEP)

These are public on interfaces and only called by sibling methods + tests. They're independently testable building blocks, not dead code.

| Service | Method | Why keep |
|---------|--------|----------|
| `TransactionStore` | `queryTransactions()` | Fundamental query. Used by `queryTransactionsPaginated()` + tests. |
| `TransactionStore` | `getCount()` | Used by `queryTransactionsPaginated()` + tests. |
| `ChangelogStore` | `getCount()` | Used by `listChangesPaginated()`. |
| `TaxonomyStore` | `createFromText()` | Used by `importFromFile()` + tests. Valid standalone operation. |
| `ClassificationRunner` | `classifySupplierTransactions()` | Per-supplier entry point. Used by `classifyAll()` + tests. |
| `SupplierService` | `normalizeSupplierName()` | Used by `normalizeAllTransactions()` + tests. |

---

## 7. NOT Dead — Test/Script Exports (KEEP)

### By design (agent pure functions — per CLAUDE.md)

Agent prompt builders and parsers are intentionally exported for standalone test use.

### Test infrastructure

| Symbol | File | Why keep |
|--------|------|----------|
| `resetEnvLoaded()` | `load-env.ts` | Integration test fixture — resets module state between tests. |
| `isTraceEnabled()` | `utils/llm-trace.ts` | Test assertion helper. |
| `chat()` standalone | `services/llm-client.ts` | Used by tests + `scripts/test-llm-config.ts`. Convenience wrapper. |
| `researchSupplier()` | `agents/research-agent.ts` | Used by `scripts/test-llm-config.ts`. |
| `suggestMappings()` | `agents/column-mapping-agent.ts` | Used by `scripts/test-llm-config.ts`. |

---

## Cleanup Order (completed)

1. ~~Delete abandoned types (Section 1)~~ — done
2. ~~Unexport internal symbols (Section 2)~~ — done
3. ~~Delete superseded functions (Section 3)~~ — done, exa-search tests rewritten
4. ~~Consolidate duplicate (Section 4)~~ — done
