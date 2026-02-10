---
name: implement-issue
description: Pick a Sprint 1 backend issue from GitHub, implement it on a feature branch, test it, and open a PR to dev.
user-invocable: true
argument-hint: "[issue-number or 'next' to auto-pick]"
---

# Implement Issue

You are implementing a GitHub issue for the Colab91 AP Classifier backend.

**Argument:** `$ARGUMENTS` — either a GitHub issue number (e.g., `42`) or the word `next` to auto-select the next available issue based on dependency order.

---

## Phase 1: Issue Selection & Preparation

### 1.1 Select the Issue

If `$ARGUMENTS` is a number:
- Run: `gh issue view $ARGUMENTS --repo kavyald/colab-ap-classifier`
- Read the issue body, labels, and comments

If `$ARGUMENTS` is `next` or empty:
- Run: `gh issue list --repo kavyald/colab-ap-classifier --label sprint-1 --state open --json number,title,labels`
- Read `.github/issues/DEPENDENCY_GRAPH.md` for dependency order
- For each open issue (in dependency order), check if all its dependencies are closed:
  ```
  gh issue list --repo kavyald/colab-ap-classifier --label sprint-1 --state closed --json number,title
  ```
- Pick the first issue whose dependencies are all closed

### 1.2 Check for Dependency Issues

Read the issue body for the **Dependencies** section. For each dependency:
- Verify the dependency issue is **closed** (merged)
- If a dependency is still open, **STOP** and report: "Cannot implement this issue — dependency S1-XX is still open."
- Read closed dependency issues and their PR comments for any deviations from the original plan

### 1.3 Update Issue with Implementation Plan

If any closed dependencies documented deviations:
- Post a comment on the current issue with an updated plan:
  ```
  gh issue comment {NUMBER} --repo kavyald/colab-ap-classifier --body "## Pre-Implementation Notes

  Reviewed closed dependencies. Adjustments needed:
  - [list any deviations from closed dependency issues]
  - [updated approach if needed]"
  ```

### 1.4 Create Feature Branch

```bash
git fetch origin dev
git checkout dev
git pull origin dev
git checkout -b feature/s1-{NN}-{short-slug}
```

Where `{NN}` is the zero-padded issue suffix (e.g., `01`, `14`) and `{short-slug}` is a kebab-case description (e.g., `project-scaffolding`, `duckdb-service`).

---

## Phase 2: Implementation

### 2.1 Read the Specs

Before writing any code, read the relevant spec documents referenced in the issue:
- `internal_docs/backend_spec.md` — architecture, agents
- `internal_docs/ipc_contract.md` — IPC channel definitions, types
- `internal_docs/schema.md` — DuckDB table definitions
- `internal_docs/features.md` — business rules, feature definitions
- `internal_docs/frontend_spec.md` — UI interactions (for context)

Only read the sections relevant to the current issue.

### 2.2 Review Existing Code

Before implementing:
- Read existing files in the areas you'll modify
- Understand patterns already established (e.g., how other services are structured)
- Check imports and dependencies

### 2.3 Implement the Feature

Follow the acceptance criteria in the issue body. Key conventions:

**IPC Handlers:**
- File: `src/main/ipc/{namespace}.ts`
- Pattern: register handlers using the IPC registration framework
- All handlers return `IPCResponse<T>`: `{ success: boolean; data?: T; error?: string }`
- Channel names: `namespace:method` (e.g., `project:new`)

**Services:**
- File: `src/main/services/{service-name}.ts`
- Export functions or a class
- Use DuckDB service for all database operations
- Use parameterized queries (prevent SQL injection)

**Agents (LLM):**
- File: `src/main/agents/{agent-name}.ts`
- Use the shared LLM client (`src/main/services/llm-client.ts`)
- Include structured output parsing
- Handle LLM errors gracefully

**Types:**
- File: `src/shared/types/{domain}.ts`
- Barrel export from `src/shared/types/index.ts`
- Types are shared between main and renderer

**Key Rules:**
- L1 taxonomy values: exactly `Direct`, `Indirect`, `Exempt`
- Taxonomy paths: pipe-delimited (`"Direct|IT|Software"`)
- Canonical column names: snake_case
- Override rule priority bands: project=100-199, taxonomy=200-299, supplier=300-399
- UUIDs for all entity IDs
- Timestamps in ISO format

### 2.4 Write Tests

Every issue must have tests. Write them alongside the implementation:

**Unit Tests:** `tests/unit/{service-or-agent}.test.ts`
- Test service methods in isolation
- Mock database for service tests
- Mock LLM responses for agent tests
- Test error cases and edge cases

**Test Patterns:**
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ServiceName', () => {
  beforeEach(async () => {
    // Setup test database, mocks
  });

  afterEach(async () => {
    // Cleanup
  });

  it('should do the thing', async () => {
    // Arrange, Act, Assert
  });
});
```

---

## Phase 3: Verification

### 3.1 Run All Tests

```bash
npm run test
```

**All tests must pass** — both new tests for this issue AND all existing tests from previous issues.

If tests fail:
1. Fix the failing tests
2. If the fix requires changes to previously-implemented code, document what changed and why
3. Re-run all tests until green

### 3.2 Type Check

```bash
npx tsc --noEmit
```

Zero TypeScript errors required.

### 3.3 Lint (if configured)

```bash
npm run lint 2>/dev/null || echo "No lint script configured"
```

---

## Phase 4: Commit & PR

### 4.1 Commit

Stage and commit with a descriptive message:
```bash
git add src/ tests/
git commit -m "feat(s1-{NN}): {short description}

Implements S1-{NN}: {issue title}

- {bullet point summary of what was built}
- {another key point}

Closes #{ISSUE_NUMBER}"
```

### 4.2 Push

```bash
git push -u origin feature/s1-{NN}-{short-slug}
```

### 4.3 Create Pull Request

```bash
gh pr create \
  --base dev \
  --title "S1-{NN}: {Issue Title}" \
  --body "## Summary

Implements #{ISSUE_NUMBER}: {Issue Title}

## Changes
- {what was added/changed}

## Testing
- [ ] Unit tests added and passing
- [ ] All existing tests still pass
- [ ] TypeScript compilation clean

## Acceptance Criteria
{Copy acceptance criteria from issue with checkmarks}

## Deviations from Plan
{Document ANY deviations from the original issue spec. If none, write 'None.'}

Closes #{ISSUE_NUMBER}"
```

### 4.4 Document Deviations

If you had to deviate from the issue spec during implementation:
- Comment on the issue with what changed and why
- This is critical — future issues with dependencies will read this

```bash
gh issue comment {ISSUE_NUMBER} --repo kavyald/colab-ap-classifier --body "## Implementation Notes

### Deviations from Plan
- {what changed}: {why it changed}

### PR
- PR #{PR_NUMBER}"
```

---

## Architecture Quick Reference

```
src/main/           # Electron main process (Node.js)
  ├── index.ts      # Entry point, creates BrowserWindow
  ├── ipc/          # IPC handler files (one per namespace)
  │   ├── index.ts  # Registers all handlers
  │   └── {ns}.ts   # Handler for each IPC namespace
  ├── services/     # Business logic services
  │   └── {name}.ts
  └── agents/       # LLM agent implementations
      └── {name}.ts

src/shared/types/   # TypeScript interfaces (shared main ↔ renderer)
  ├── index.ts      # Barrel export
  └── {domain}.ts

src/preload/        # Electron preload (contextBridge)
  └── index.ts

tests/
  ├── unit/         # Unit tests (vitest)
  ├── integration/  # Integration tests
  └── helpers/      # Test utilities, fixtures
```

## Troubleshooting

- **DuckDB import errors:** Make sure to use the async bindings (`duckdb-async` or `@duckdb/node-bindings`)
- **IPC not reaching renderer:** Check preload script is loaded in BrowserWindow config
- **LLM mock in tests:** Use `vi.mock()` to mock the LLM client module
- **Type errors across processes:** Types must be in `src/shared/types/`, not in main or renderer directories
