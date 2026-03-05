# PR 6: Test Infrastructure — Mock Factories + Smoke Tests

## Problem
The architecture mandates constructor-injection testing with mock factories in
`tests/helpers/mock-services.ts`. No test infrastructure currently exists.

## Core Type Rules (apply everywhere in this PR)

- Mock factories must return the **exact interface type** from `src/shared/types/services.ts`,
  not `any`. Every mock stub is typed against the interface it mocks.
- `vi.fn()` stubs need explicit return type annotations:
  `vi.fn<() => Promise<X>>()` not `vi.fn()` (which infers `any`)
- Test data must use real shared types — `FilterCondition[]`, `DashboardTransactionRow`,
  `ReviewTableConfig`, etc. Never use `as any` to satisfy test data shapes.

---

## Changes

### 1. Create typed mock factory file

`tests/helpers/mock-services.ts` with factories for every interface in `shared/types/services.ts`.
Each factory returns the interface type explicitly:

```typescript
import type { Database, TransactionStore, ProjectStore, EventBus, LLMClient, WebSearch, SupplierUniverse } from '../../src/shared/types/services'
import type { FilterCondition } from '../../src/shared/types/transactions'

export function createMockDatabase(): Database {
  return {
    run: vi.fn<(sql: string, params?: unknown[]) => Promise<void>>(),
    all: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
    get: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
    close: vi.fn<() => Promise<void>>(),
  }
}

export function createMockTransactionStore(): TransactionStore {
  return {
    queryTransactionsPaginated: vi.fn<(conditions: FilterCondition[], page: number, limit: number) => Promise<...>>(),
    // all methods typed against the interface
  }
}

// etc. for createMockEventBus, createMockLLMClient, createMockWebSearch,
// createMockProjectStore, createMockSupplierUniverse
```

**Rule:** If a mock method accepts `FilterCondition[]`, annotate it as `FilterCondition[]` —
not `any[]`. If it returns a `Transaction`, return a `Transaction`, not `Record<string, any>`.

### 2. Container wiring smoke test

`tests/main/container.test.ts` — verify `createContainer()` doesn't throw,
all service properties are defined and are the right type:

```typescript
it('creates all services', () => {
  const container = createContainer({ db: createMockDatabase(), ... })
  expect(container.transactionStore).toBeDefined()
  expect(container.classificationAgent).toBeDefined()
  // etc.
})
```

### 3. Agent pure function tests

**`tests/main/agents/classification-agent.test.ts`**
Test the pure exported functions — prompt builders and parsers:
```typescript
import { buildSystemPrompt, parseClassificationResponse, formatTaxonomyTree } from '../../../src/main/agents/classification-agent'
```
- Input/output are string → string or string → typed object, no mocking needed
- Test with known taxonomy paths (pipe-delimited: `"Corporate Services|IT|Software"`)
- Test `parseClassificationResponse` with valid response, malformed JSON, wrapped `{"transactions":[...]}` envelope

**`tests/main/agents/column-mapping-agent.test.ts`**
- Test inverted mapping correction (if canonical → CSV, it should be CSV → canonical)
- Input is `string[]` (headers) + field description, output is typed `ColumnMapping`

**`tests/main/agents/research-agent.test.ts`**
- Test prompt building with known supplier name
- Test response parsing

### 4. Query builder tests

`tests/main/utils/query-builder.test.ts` — test `buildWhereClause()` with typed inputs:

```typescript
import { buildWhereClause } from '../../../src/main/utils/query-builder'
import type { FilterCondition } from '../../../src/shared/types/transactions'

const conditions: FilterCondition[] = [
  { field: 'supplier_name', operator: 'in_list', value: ['Acme', 'Beta'] },
  { field: 'L1', operator: 'equals', value: 'IT' },
]
const { sql, params } = buildWhereClause(conditions)
expect(sql).toBe('supplier_name IN (?, ?) AND L1 = ?')
expect(params).toEqual(['Acme', 'Beta', 'IT'])
```

All `FilterCondition[]` test data uses real values — no `as any`.

### 5. Vitest config

Ensure `vitest.config.ts` exists with correct paths, TypeScript support, and path aliases
matching `tsconfig.json` (e.g., `@shared/` → `src/shared/`).

---

## Type Checklist
Before opening the PR, verify:
- [ ] Every mock factory return type explicitly matches the service interface (no implicit `any`)
- [ ] No `as any` in test data construction — use real types from `src/shared/types/`
- [ ] `vi.fn()` calls have explicit generic type parameters where return type matters
- [ ] `tsc --noEmit` passes in the test directory too (Vitest respects tsconfig)

## Dependencies
- Independent of PRs 1-5 (can be done in parallel, but mock types will be easier after PR 5 fixes shared types)

## Files touched
- New: `tests/helpers/mock-services.ts`
- New: `tests/main/container.test.ts`
- New: `tests/main/agents/classification-agent.test.ts`
- New: `tests/main/agents/column-mapping-agent.test.ts`
- New: `tests/main/agents/research-agent.test.ts`
- New: `tests/main/utils/query-builder.test.ts`
- `vitest.config.ts` (create or update)
- `package.json` (add test script if missing)
