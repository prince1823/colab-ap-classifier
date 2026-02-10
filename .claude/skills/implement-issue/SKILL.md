---
name: implement-issue
description: Pick a Sprint 1 issue (backend or frontend track) from GitHub, implement it on a feature branch, test it, and open a PR to dev.
user-invocable: true
argument-hint: "[backend|frontend] [issue-number or 'next']"
---

# Implement Issue

You are implementing a GitHub issue for the Colab91 AP Classifier.

**Argument:** `$ARGUMENTS` — two tokens separated by a space:
1. **Track:** `backend` or `frontend`
2. **Selector:** a GitHub issue number (e.g., `42`) or the word `next` to auto-select the next available issue

Examples:
- `/implement-issue backend next` — auto-pick the next ready backend issue
- `/implement-issue frontend 42` — implement frontend issue #42
- `/implement-issue backend 15` — implement backend issue #15

If the track is missing or invalid, **STOP** and report:
> "Usage: `/implement-issue [backend|frontend] [issue-number|next]`"

---

## Phase 1: Issue Selection & Preparation

### 1.1 Parse Arguments

Split `$ARGUMENTS` on whitespace into `TRACK` (first token) and `SELECTOR` (second token).

- Validate `TRACK` is `backend` or `frontend`
- Validate `SELECTOR` is a positive integer or `next`
- If invalid, STOP and show usage

### 1.2 Select the Issue

If `SELECTOR` is a number:
- Run: `gh issue view $SELECTOR --repo kavyald/colab-ap-classifier`
- Read the issue body, labels, and comments
- Verify the issue has the expected track label (`backend` or `frontend`). If not, warn:
  > "Issue #N is labeled '{actual_label}', not '{TRACK}'. Did you mean `/implement-issue {actual_label} N`?"

If `SELECTOR` is `next`:
- Run: `gh issue list --repo kavyald/colab-ap-classifier --label sprint-1 --label $TRACK --state open --json number,title,labels`
- Read the track-appropriate dependency graph:
  - **Backend:** `.github/issues/DEPENDENCY_GRAPH.md`
  - **Frontend:** `.github/issues/FRONTEND_DEPENDENCY_GRAPH.md`
- Get the list of closed sprint-1 issues for this track:
  ```
  gh issue list --repo kavyald/colab-ap-classifier --label sprint-1 --label $TRACK --state closed --json number,title
  ```
- For frontend issues, also get closed backend issues (for cross-track prerequisites):
  ```
  gh issue list --repo kavyald/colab-ap-classifier --label sprint-1 --label backend --state closed --json number,title
  ```
- For each open issue (in dependency order from the graph), check if all its dependencies are closed — including cross-track prerequisites for frontend
- Pick the first issue whose dependencies are all satisfied

### 1.3 Check for Dependency Issues

Read the issue body for the **Dependencies** section. For each dependency:
- Verify the dependency issue is **closed** (merged)
- If a dependency is still open, **STOP** and report: "Cannot implement this issue — dependency S1-XX is still open."
- Read closed dependency issues and their PR comments for any deviations from the original plan

For **frontend** issues, also check the **Cross-Track Prerequisites** section in `FRONTEND_DEPENDENCY_GRAPH.md`. These are backend issues that must be closed before this frontend issue can start.

### 1.4 Update Issue with Implementation Plan

If any closed dependencies documented deviations:
- Post a comment on the current issue with an updated plan:
  ```
  gh issue comment {NUMBER} --repo kavyald/colab-ap-classifier --body "## Pre-Implementation Notes

  Reviewed closed dependencies. Adjustments needed:
  - [list any deviations from closed dependency issues]
  - [updated approach if needed]"
  ```

### 1.5 Create Feature Branch

```bash
git fetch origin dev
git checkout dev
git pull origin dev
```

**Backend:**
```bash
git checkout -b feature/s1-{NN}-{short-slug}
```

**Frontend:**
```bash
git checkout -b feature/s1-fe-{NN}-{short-slug}
```

Where `{NN}` is the zero-padded issue suffix (e.g., `01`, `14`) and `{short-slug}` is a kebab-case description (e.g., `project-scaffolding`, `upload-page`).

---

## Phase 2: Implementation

### 2.1 Read the Specs

Before writing any code, read the relevant spec documents referenced in the issue.

**If TRACK is `backend`:**
- `internal_docs/backend_spec.md` — architecture, agents
- `internal_docs/ipc_contract.md` — IPC channel definitions, types
- `internal_docs/schema.md` — DuckDB table definitions
- `internal_docs/features.md` — business rules, feature definitions
- `internal_docs/frontend_spec.md` — UI interactions (for context on what the frontend expects)

**If TRACK is `frontend`:**
- `internal_docs/frontend_spec.md` — UI layouts, interactions, constraints
- `internal_docs/ipc_contract.md` — IPC channels available from the renderer
- `internal_docs/features.md` — business rules, feature definitions
- `internal_docs/backend_spec.md` — architecture (for context on what the backend provides)

Only read the sections relevant to the current issue.

### 2.2 Review Existing Code

Before implementing:
- Read existing files in the areas you'll modify
- Understand patterns already established (e.g., how other services/components are structured)
- Check imports and dependencies

### 2.3 Implement the Feature

Follow the acceptance criteria in the issue body. Key conventions differ by track:

---

#### Backend Conventions

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

**Key Backend Rules:**
- L1 taxonomy values: exactly `Direct`, `Indirect`, `Exempt`
- Taxonomy paths: pipe-delimited (`"Direct|IT|Software"`)
- Canonical column names: snake_case
- Override rule priority bands: project=100-199, taxonomy=200-299, supplier=300-399
- UUIDs for all entity IDs
- Timestamps in ISO format

---

#### Frontend Conventions

**Pages (workflow tabs):**
- File: `src/renderer/pages/{PageName}.tsx`
- Each workflow step is a page component
- Pages use hooks for data fetching and state management
- Pages compose smaller, reusable components

**Components (reusable UI elements):**
- File: `src/renderer/components/{ComponentName}.tsx`
- Props interface at top of file: `interface {ComponentName}Props { ... }`
- Prefer composition over inheritance
- Colocate styles alongside components

**Hooks (data fetching & state):**
- File: `src/renderer/hooks/use{Domain}.ts`
- Wrap IPC calls: `const result = await window.electronAPI.namespace.method(args)`
- Always check `result.success` before accessing `result.data`
- Return `{ data, loading, error }` state tuple
- Example pattern:
  ```typescript
  export function useProjectMetadata(projectId: string) {
    const [data, setData] = useState<ProjectMetadata | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      const fetch = async () => {
        const result = await window.electronAPI.project.getMetadata(projectId);
        if (result.success) {
          setData(result.data);
        } else {
          setError(result.error);
        }
        setLoading(false);
      };
      fetch();
    }, [projectId]);

    return { data, loading, error };
  }
  ```

**Types:**
- Shared types: `src/shared/types/{domain}.ts` (shared with backend — never duplicate)
- Frontend-only types (component props, UI state): `src/renderer/types/` if needed

**Key Frontend Rules:**
- All IPC calls go through `window.electronAPI` (exposed via preload contextBridge)
- Always use the `IPCResponse<T>` pattern: check `.success` before accessing `.data`
- Form state is cached locally (page reload must not lose in-progress work)
- Disabled tabs show tooltips explaining why they are disabled
- Only one classification job at a time — lock UI accordingly
- Block uploads while classification is running

---

### 2.4 Write Tests

Every issue must have tests. Write them alongside the implementation.

#### Backend Tests

**Unit Tests:** `tests/unit/{service-or-agent}.test.ts`
- Test service methods in isolation
- Mock database for service tests
- Mock LLM responses for agent tests
- Test error cases and edge cases

**Test Pattern:**
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

#### Frontend Tests

**Component Tests:** `tests/unit/components/{ComponentName}.test.tsx`
**Page Tests:** `tests/unit/pages/{PageName}.test.tsx`
**Hook Tests:** `tests/unit/hooks/use{Domain}.test.ts`

- Use `@testing-library/react` (`render`, `screen`, `fireEvent`, `waitFor`)
- Mock `window.electronAPI` for all IPC calls
- Test user interactions and rendered output
- Test loading, success, and error states

**Test Pattern:**
```typescript
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentName } from '../../src/renderer/components/ComponentName';

const mockElectronAPI = {
  project: {
    getMetadata: vi.fn(),
    updateMetadata: vi.fn(),
  },
};

beforeEach(() => {
  (window as any).electronAPI = mockElectronAPI;
});

describe('ComponentName', () => {
  it('should render data when IPC call succeeds', async () => {
    mockElectronAPI.project.getMetadata.mockResolvedValue({
      success: true,
      data: { name: 'Test Project' },
    });

    render(<ComponentName projectId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText('Test Project')).toBeInTheDocument();
    });
  });

  it('should show error when IPC call fails', async () => {
    mockElectronAPI.project.getMetadata.mockResolvedValue({
      success: false,
      error: 'Not found',
    });

    render(<ComponentName projectId="bad-id" />);

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });
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

**Backend:**
```bash
git add src/ tests/
git commit -m "feat(s1-{NN}): {short description}

Implements S1-{NN}: {issue title}

- {bullet point summary of what was built}
- {another key point}

Closes #{ISSUE_NUMBER}"
```

**Frontend:**
```bash
git add src/ tests/
git commit -m "feat(s1-fe-{NN}): {short description}

Implements S1-FE-{NN}: {issue title}

- {bullet point summary of what was built}
- {another key point}

Closes #{ISSUE_NUMBER}"
```

### 4.2 Push

**Backend:**
```bash
git push -u origin feature/s1-{NN}-{short-slug}
```

**Frontend:**
```bash
git push -u origin feature/s1-fe-{NN}-{short-slug}
```

### 4.3 Create Pull Request

**Backend:**
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

**Frontend:**
```bash
gh pr create \
  --base dev \
  --title "S1-FE-{NN}: {Issue Title}" \
  --body "## Summary

Implements #{ISSUE_NUMBER}: {Issue Title}

## Changes
- {what was added/changed}

## Testing
- [ ] Component/page/hook tests added and passing
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

### Backend (Electron Main Process)

```
src/main/               # Electron main process (Node.js)
  ├── index.ts          # Entry point, creates BrowserWindow
  ├── ipc/              # IPC handler files (one per namespace)
  │   ├── index.ts      # Registers all handlers
  │   └── {ns}.ts       # Handler for each IPC namespace
  ├── services/         # Business logic services
  │   └── {name}.ts
  └── agents/           # LLM agent implementations
      └── {name}.ts

src/shared/types/       # TypeScript interfaces (shared main ↔ renderer)
  ├── index.ts          # Barrel export
  └── {domain}.ts

src/preload/            # Electron preload (contextBridge)
  └── index.ts
```

### Frontend (React Renderer)

```
src/renderer/           # React frontend (Chromium renderer process)
  ├── main.tsx          # React entry point
  ├── App.tsx           # Root component, routing
  ├── components/       # Reusable UI components
  │   └── {Name}.tsx
  ├── pages/            # Workflow tab pages
  │   ├── UploadPage.tsx
  │   ├── CanonicalizationPage.tsx
  │   ├── DataReviewPage.tsx
  │   ├── ClassificationPage.tsx
  │   ├── ReviewPage.tsx
  │   └── OutputPage.tsx
  ├── hooks/            # Custom React hooks (IPC wrappers, state)
  │   └── use{Domain}.ts
  └── types/            # Frontend-only types (if needed)
```

### Tests

```
tests/
  ├── unit/
  │   ├── {service-or-agent}.test.ts   # Backend unit tests
  │   ├── components/                   # Frontend component tests
  │   │   └── {Name}.test.tsx
  │   ├── pages/                        # Frontend page tests
  │   │   └── {Name}.test.tsx
  │   └── hooks/                        # Frontend hook tests
  │       └── use{Domain}.test.ts
  ├── integration/                      # Integration tests
  └── helpers/                          # Test utilities, fixtures
```

## Troubleshooting

### Backend
- **DuckDB import errors:** Make sure to use the async bindings (`duckdb-async` or `@duckdb/node-bindings`)
- **IPC not reaching renderer:** Check preload script is loaded in BrowserWindow config
- **LLM mock in tests:** Use `vi.mock()` to mock the LLM client module
- **Type errors across processes:** Types must be in `src/shared/types/`, not in main or renderer directories

### Frontend
- **IPC calls not working in tests:** Mock `window.electronAPI` in `beforeEach` — see test pattern above
- **`@testing-library/react` not found:** Ensure it's in `devDependencies` (`npm i -D @testing-library/react @testing-library/jest-dom`)
- **Component not re-rendering after IPC:** Ensure state updates happen inside the async callback, check `useEffect` dependency array
- **Preload types not available:** Import types from `src/shared/types/`, ensure preload exposes the channel via `contextBridge`
