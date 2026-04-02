# Type Extraction Refactor

**Date:** 2026-04-02
**Status:** ✅ Complete
**Scope:** `src/shared/types/`

---

## Summary

Two areas where inline/anonymous types should be extracted into named types to reduce duplication and improve clarity.

| Area | Files affected | Inline occurrences | Named type(s) to create |
|------|---------------|-------------------|------------------------|
| Supplier universe record shape | `services.ts`, `suppliers.ts`, `supplier-universe.ts`, `mock-services.ts` | 2 (input + output) | `SupplierRecord`, `SupplierRecordInput` |
| Progress event types | `classification.ts` | 3 identical + 1 variant | `SupplierProgress` |

---

## 1. SupplierUniverse Record Shape

### Problem (resolved)

The `SupplierUniverse` interface in `src/shared/types/services.ts` had two methods with nearly identical inline types:

**`getSupplierRecord` return type (lines 85-91):**
```typescript
Promise<{
  supplierInfo: SupplierInfo;
  aliases: string[];
  parentName: string | null;
  mappedTaxonomyPaths: string[];
  categoryASupplier: boolean;
} | null>
```

**`upsertSupplierFull` input type (lines 78-84):**
```typescript
{
  supplierInfo?: Partial<SupplierInfo>;
  aliases?: string[];
  parentName?: string | null;
  mappedTaxonomyPaths?: string[];
  categoryASupplier?: boolean;
}
```

Same 5 fields, different optionality. Neither shape has a name.

### Differences

| Field | `getSupplierRecord` (output) | `upsertSupplierFull` (input) |
|-------|------------------------------|------------------------------|
| `supplierInfo` | `SupplierInfo` (required) | `Partial<SupplierInfo>` (optional) |
| `aliases` | `string[]` (required) | `string[]` (optional) |
| `parentName` | `string \| null` (required) | `string \| null` (optional) |
| `mappedTaxonomyPaths` | `string[]` (required) | `string[]` (optional) |
| `categoryASupplier` | `boolean` (required) | `boolean` (optional) |

### Types Added

Added to `src/shared/types/suppliers.ts`:

```typescript
/** Full supplier record from the shared supplier universe. */
export interface SupplierRecord {
  supplierInfo: SupplierInfo;
  aliases: string[];
  parentName: string | null;
  mappedTaxonomyPaths: string[];
  categoryASupplier: boolean;
}

/** Partial input for upserting a supplier into the universe. */
export interface SupplierRecordInput {
  supplierInfo?: Partial<SupplierInfo>;
  aliases?: string[];
  parentName?: string | null;
  mappedTaxonomyPaths?: string[];
  categoryASupplier?: boolean;
}
```

### Changes Applied to `services.ts`

```typescript
// Before
upsertSupplierFull(name: string, data: {
  supplierInfo?: Partial<SupplierInfo>;
  aliases?: string[];
  parentName?: string | null;
  mappedTaxonomyPaths?: string[];
  categoryASupplier?: boolean;
}): Promise<void>;
getSupplierRecord(name: string): Promise<{
  supplierInfo: SupplierInfo;
  aliases: string[];
  parentName: string | null;
  mappedTaxonomyPaths: string[];
  categoryASupplier: boolean;
} | null>;

// After
upsertSupplierFull(name: string, data: SupplierRecordInput): Promise<void>;
getSupplierRecord(name: string): Promise<SupplierRecord | null>;
```

### Downstream (done)

Updated:
- `src/main/services/supplier-universe.ts` — imports and uses `SupplierRecord` and `SupplierRecordInput` explicitly in method signatures
- `tests/helpers/mock-services.ts` — `getSupplierRecord` mock uses `SupplierRecord | null` type annotation

---

## 2. Progress Event Types

### Problem (resolved)

`src/shared/types/classification.ts` defined four progress interfaces. Three of them (`QCProgress`, `ResearchProgress`, `ClassificationProgress`) shared an identical base shape. Two of them (`ResearchProgress` and `ClassificationProgress`) were exactly identical — literally the same 6 fields.

### Current definitions

**`ResearchProgress` (lines 65-72):**
```typescript
export interface ResearchProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}
```

**`ClassificationProgress` (lines 74-81):**
```typescript
export interface ClassificationProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}
```

These are **exactly identical**.

**`QCProgress` (lines 52-63):**
```typescript
export interface QCProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
  outcome?: QCOutcome;
  consolidatedTo?: string;
}
```

Same 6 base fields + 2 QC-specific optional fields.

**`IngestProgress` (lines 83-91):**
```typescript
export interface IngestProgress {
  status: 'running' | 'completed' | 'failed';  // no 'cancelled'
  totalRows: number;                            // not totalSuppliers
  processedRows: number;                        // not processedSuppliers
  percentage: number;
  currentStep: string;                          // no currentSupplier
  result?: { rowsInserted: number; uploadId: string };
  error?: string;
}
```

Different enough to not share the base (different status union, rows vs suppliers, no currentSupplier).

### Types Applied

```typescript
/** Base shape for supplier-oriented progress events. */
export interface SupplierProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalSuppliers: number;
  processedSuppliers: number;
  percentage: number;
  currentSupplier: string | null;
  currentStep: string;
}

export interface QCProgress extends SupplierProgress {
  outcome?: QCOutcome;
  consolidatedTo?: string;
}

// ResearchProgress and ClassificationProgress become type aliases
export type ResearchProgress = SupplierProgress;
export type ClassificationProgress = SupplierProgress;
```

`IngestProgress` stays as-is — it's structurally different (rows, not suppliers; different status union; has result/error).

### Downstream (verified)

- `IPCEventMap` in `ipc-contract.ts` references `ClassificationProgress`, `ResearchProgress`, `QCProgress` — all still exported, no changes needed.
- EventBus emitters in services that construct progress objects should use explicit type annotations (e.g. `const progress: ClassificationProgress = { ... }`) so the compiler catches field drift.
- Renderer components that consume progress events via `IPCEventMap` — no changes needed, they already use the named types through the event map.

---

## Scope Exclusion: Inline Result Types in services.ts / ipc-contract.ts

Types like `{ rowsInserted: number; uploadId: string }`, `{ matchedCount: number; ruleCount: number }`, etc. appear inline in both `services.ts` and `ipc-contract.ts`. These were considered for extraction but **excluded** because:

1. The service interface and IPC contract are conceptually independent layers. They happen to match today but should be free to diverge.
2. Coupling them with a shared type means changing a service return shape silently changes the IPC contract — a worse outcome than duplication.
3. The inline types are small (2-3 fields) and self-documenting at point of use.
4. High churn (~12 types across 2 files) for low value.

---

## Implementation (completed)

1. ~~Supplier record types~~ — types added to `suppliers.ts`, `services.ts` interface updated, `supplier-universe.ts` and `mock-services.ts` updated with explicit annotations. `tsc` clean.
2. ~~Progress base type~~ — `SupplierProgress` added to `classification.ts`, `QCProgress` extends it, `ResearchProgress` and `ClassificationProgress` are type aliases. `tsc` clean, all 620 tests pass.
