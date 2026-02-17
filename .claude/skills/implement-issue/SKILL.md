---
name: implement-issue
description: Read a GitHub issue, gather context, implement the feature on a branch, run tests, and create a PR to dev.
user-invocable: true
argument-hint: "<issue_number>"
---

# Implement Issue

You are implementing a GitHub issue for the Colab91 AP Classifier.

**Argument:** `$ARGUMENTS` — a GitHub issue number (e.g., `65`).

Examples:
- `/implement-issue 65`
- `/implement-issue 70`

If no argument is provided, ask the user which issue to implement.

---

## Phase 1: Context Gathering

### 1.1 Read the Issue

```bash
gh issue view $ISSUE_NUM --repo kavyald/colab-ap-classifier --json number,title,body,comments
```

Extract:
- **Title and body** — what to build, acceptance criteria
- **Comments** — look for:
  - "Modified by PR #XX" comments (cross-impact from other PRs)
  - "Pre-Implementation Notes" from previous work
  - Any deviations or updates

### 1.1b Check Sub-Issue Relationships

```bash
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='{ repository(owner:"kavyald", name:"colab-ap-classifier") { issue(number:'$ISSUE_NUM') { trackedInIssues(first:1) { nodes { number title } } trackedIssues(first:20) { nodes { number title state } } } } }'
```

- **If the issue has open sub-issues:** Stop and warn the user. Parent issues should not be implemented directly — implement the sub-issues instead.
- **If the issue is a sub-issue:** Read closed siblings' comments for cross-impact context (especially "Modified by PR #XX" comments that may affect shared code areas).

### 1.2 Read Board Fields

Fetch the issue's project board fields to determine Track, Thread, and Type:

```bash
gh project item-list 1 --owner @me --format json --limit 200 \
  | python3 -c "import json,sys; items=json.load(sys.stdin)['items']; [print(json.dumps(i)) for i in items if i.get('content',{}).get('number')==$ISSUE_NUM]"
```

Extract:
- **Track** (Backend / Frontend / Docs) — determines branch naming, assignee, test strategy
- **Thread** (Project Mgmt / Data Import / Taxonomy / Supplier / Classification / System Feedback / Export & Sync / Infrastructure / Misc Process) — determines which specs to read
- **Type** (Feature / Bug / Docs) — determines commit prefix

### 1.3 Read Relevant Specs

Based on the board **Thread** value, read the relevant spec sections:

| Thread | Read (all in `internal_docs/core/`) |
|--------|------|
| Project Mgmt | `features.md` (sec 1), `backend_spec.md` (project service), `ipc_contract.md` (project channels) |
| Data Import | `features.md` (sec 2), `backend_spec.md` (upload/canonicalization), `ipc_contract.md` (upload channels) |
| Taxonomy | `features.md` (sec 3), `backend_spec.md` (taxonomy service), `schema.md` (taxonomy table) |
| Supplier | `features.md` (sec 4), `backend_spec.md` (research agent, supplier service), `schema.md` (suppliers table) |
| Classification | `features.md` (sec 5-9), `backend_spec.md` (pipeline, agents), `schema.md` (transactions) |
| Export & Sync | `features.md` (sec 10), `backend_spec.md` (export, colabip), `ipc_contract.md` (export channels) |
| Infrastructure | `backend_spec.md` (architecture), `schema.md`, `ipc_contract.md` |
| Misc Process | No specs needed — these are workflow, planning, or operational tasks |

Only read sections relevant to the issue — don't read entire files. For Track=Docs issues or Misc Process threads, you may not need specs at all.

### 1.4 Read Existing Code

Read the files this issue will modify or extend. Understand:
- Existing patterns (how similar services/components are structured)
- Imports and dependencies
- Test patterns used in the codebase

### 1.5 Check Cross-Impact

If the issue has "Modified by PR #XX" comments, read those PRs to understand what changed:
```bash
gh pr view {PR_NUM} --repo kavyald/colab-ap-classifier --json body,files
```

---

## Phase 2: Implementation Planning

Plan the implementation approach autonomously:
- Which files to create or modify
- Function signatures and data flow
- Test strategy (unit tests, what to mock)

**Only stop and ask the user if:**
- The issue body is missing acceptance criteria or is ambiguous
- Cross-impact comments indicate the codebase has changed in ways that conflict with the issue's assumptions
- A design decision has multiple valid approaches and no clear winner

Otherwise, proceed directly to implementation.

---

## Phase 3: Implementation

### 3.1 Create Feature Branch

```bash
git fetch origin dev
git checkout dev
git pull origin dev
```

Determine branch name from board **Track** and **Type** fields:
- Track=Backend + Type=Feature: `git checkout -b feature/s2-{NN}-{short-slug}`
- Track=Frontend + Type=Feature: `git checkout -b feature/s2-fe-{NN}-{short-slug}`
- Track=Backend + Type=Bug: `git checkout -b fix/s2-{short-slug}`
- Track=Frontend + Type=Bug: `git checkout -b fix/s2-fe-{short-slug}`
- Track=Docs (any Type): `git checkout -b docs/s2-{NN}-{short-slug}`

Where `{NN}` is derived from the issue title (e.g., S2-03 → 03) and `{short-slug}` is a kebab-case description.

### 3.2 Implement

**For Track=Backend:**
- IPC handlers: `src/main/ipc/{namespace}.ts`, return `IPCResponse<T>`
- Services: `src/main/services/{name}.ts`
- Agents: `src/main/agents/{name}.ts`
- Types: `src/shared/types/{domain}.ts`

**For Track=Frontend:**
- Pages: `src/renderer/pages/{PageName}.tsx`
- Components: `src/renderer/components/{Name}.tsx`
- Hooks: `src/renderer/hooks/use{Domain}.ts`
- IPC calls: `window.electronAPI.namespace.method(args)`

**For Track=Docs:**
- Markdown files in `internal_docs/` or spec updates
- No code changes required (though spec updates may reference code)

### 3.3 Write Tests

**For Track=Backend:** `tests/unit/{service-or-agent}.test.ts`
- Use vitest (`describe`, `it`, `expect`, `vi.mock`)
- Mock DB for service tests, mock LLM for agent tests

**For Track=Frontend:** `tests/unit/components/{Name}.test.tsx` or `tests/unit/pages/{Name}.test.tsx`
- Use `@testing-library/react`
- Mock `window.electronAPI`

**For Track=Docs:** No tests needed.

### 3.4 Verify

**For Track=Backend or Frontend:**
```bash
npm run test
npx tsc --noEmit
```
All tests must pass and TypeScript must compile cleanly. If tests fail, fix them before proceeding.

**For Track=Docs:** Skip tests/typecheck. Verify the deliverable exists and is well-structured.

---

## Phase 4: Review & PR Creation

### 4.1 Present Summary to User

**Stop and ask the user before committing.** Present:

```
Implementation complete. Here's what was done:

Files changed:
- {list of files created or modified}

Commit message:
  {prefix} {short description}

  Implements #{ISSUE_NUMBER}: {issue title}

  - {bullet point summary of what was built}

  Closes #{ISSUE_NUMBER}

Deviations from issue spec:
- {list deviations, or "None"}

Ready to commit, push, and create a PR to dev?
```

Wait for user confirmation before proceeding. If the user wants changes, make them first.

### 4.2 Commit

Determine commit prefix from board **Type**:
- Type=Feature: `feat(s2-{NN}):`
- Type=Bug: `fix(s2-{NN}):`
- Type=Docs: `docs(s2-{NN}):`

```bash
git add src/ tests/  # or git add internal_docs/ .claude/ for docs track
git commit -m "{prefix} {short description}

Implements #{ISSUE_NUMBER}: {issue title}

- {bullet point summary of what was built}

Closes #{ISSUE_NUMBER}"
```

### 4.3 Push

```bash
git push -u origin {branch-name}
```

### 4.4 Create PR

```bash
gh pr create --repo kavyald/colab-ap-classifier \
  --base dev \
  --title "S2-{NN}: {Issue Title}" \
  --body "$(cat <<'EOF'
## Summary

Implements #{ISSUE_NUMBER}: {title}

## Changes

- {what was added/changed}

## Testing

- [ ] New tests added and passing
- [ ] All existing tests still pass
- [ ] TypeScript compilation clean

## Deviations

{Document ANY deviations from the issue spec. If none, write 'None.'}

Closes #{ISSUE_NUMBER}
EOF
)"
```

### 4.5 Document Deviations

If you deviated from the issue spec during implementation, comment on the issue:

```bash
gh issue comment {ISSUE_NUMBER} --repo kavyald/colab-ap-classifier --body "## Implementation Notes

### Deviations from Plan
- {what changed}: {why it changed}

### PR
- PR #{PR_NUMBER}"
```

### 4.6 Done

Output the PR number and URL. Remind the user to run `/merge-pr {PR_NUMBER}` when ready to merge.
