# PR 6: Test Infrastructure — Mock Factories + Smoke Tests

## Problem
The architecture mandates constructor-injection testing with mock factories in
`tests/helpers/mock-services.ts`. No test infrastructure currently exists.

## Changes

### 1. Create mock factory file
- `tests/helpers/mock-services.ts` with factories for every interface in `shared/types/services.ts`:
  - `createMockDatabase()` — returns vi.fn() stubs for all Database methods
  - `createMockEventBus()` — returns working EventEmitter or vi.fn() stubs
  - `createMockLLMClient()` — returns canned responses
  - `createMockWebSearch()` — returns canned search results
  - `createMockTransactionStore()`, `createMockProjectStore()`, etc.
  - `createMockSupplierUniverse()`

### 2. Container wiring smoke test
- `tests/main/container.test.ts` — verify `createContainer()` doesn't throw,
  all service properties are defined and are the right type

### 3. Agent pure function tests
- `tests/main/agents/classification-agent.test.ts` — test `buildSystemPrompt()`,
  `parseClassificationResponse()`, `formatTaxonomyTree()` with known inputs/outputs
- `tests/main/agents/column-mapping-agent.test.ts` — test inverted mapping correction
- `tests/main/agents/research-agent.test.ts` — test prompt building + response parsing

### 4. Query builder tests
- `tests/main/utils/query-builder.test.ts` — test `buildWhereClause()` with various
  `FilterCondition[]` inputs, verify SQL output + params

### 5. Vitest config
- Ensure `vitest.config.ts` exists with correct paths, TypeScript support, and aliases

## Dependencies
- Independent of PRs 1-5 (can be done in parallel)

## Files touched
- New: `tests/helpers/mock-services.ts`
- New: `tests/main/container.test.ts`
- New: `tests/main/agents/classification-agent.test.ts`
- New: `tests/main/agents/column-mapping-agent.test.ts`
- New: `tests/main/agents/research-agent.test.ts`
- New: `tests/main/utils/query-builder.test.ts`
- `vitest.config.ts` (create or update)
- `package.json` (add test script if missing)
