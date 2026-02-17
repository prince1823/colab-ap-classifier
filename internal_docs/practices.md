# Development Practices

## Workflow

```
/create-issue  →  /implement-issue  →  /close-session  →  /update-docs  →  /merge-pr
  (define)         (build + PR)       (log session)  (sync specs)     (merge + track)
```

### `/create-issue <topic>`

Use when starting new work. Reads specs, plans scope with you, creates an issue on GitHub.

- Gathers context from `internal_docs/core/` specs and existing issues
- Proposes acceptance criteria — you refine before it creates
- Sets all project board fields (Thread, Track, Type, Priority, Size, dates)
- Auto-assigns: Backend → kavyald, Frontend → prince1823, Docs → unassigned
- Works for coding **and** non-coding tasks (planning, research, documentation)

### `/implement-issue <number>`

Use when an issue exists and is ready to build.

- Reads the issue body and board fields (Track, Thread, Type)
- Creates a feature branch, implements, writes tests, verifies
- **Presents summary to user before committing** — user reviews and approves
- Creates PR to `dev` after approval
- For Track=Docs issues: uses `docs/` branch, skips tests, writes markdown

### `/close-session`

Use at the end of a session to log what you worked on.

- Asks user to classify session: **Feature** (progressed an issue) or **Scratchpad** (exploration/research)
- Captures session summary and key decisions (**preserved verbatim**)
- Saves log to `internal_docs/daily_logs/{developer}.md` (one persistent file per developer, date sections appended)
- `/update-docs` only deep-analyzes Feature sessions for spec drift; Scratchpad sessions are logged for reference only

### `/update-docs <PR_number>`

Use after a PR is created to sync specs with code changes.

- Reads the PR diff and finds connected daily logs by branch name
- Follows session JSONL links to read full conversation transcripts
- Detects spec drift in `internal_docs/core/`, `practices.md`, and `CLAUDE.md`
- Proposes targeted updates — user approves each individually
- Commits doc changes after user approval

### `/merge-pr <PR_number>`

Use when a PR is ready to land. Merges and tracks cross-impact.

- Merges PR into `dev` (or runs comment-only mode if already merged)
- GitHub auto-closes the linked issue via `Closes #NN`
- Identifies other issues whose code was modified by this PR
- Posts "Modified by PR #XX" comments on affected issues
- Updates stale cross-impact comments from earlier PRs

---

## Project Board (Single Source of Truth)

All issue metadata lives on the GitHub Project board. There are **no labels** — everything is a board field.

| Field | Options | Purpose |
|-------|---------|---------|
| **Status** | Todo, In Progress, Done | Workflow state |
| **Thread** | Project Mgmt, Data Import, Taxonomy, Supplier, Classification, System Feedback, Export & Sync, Infrastructure, Misc Process | Feature area / work category |
| **Track** | Backend, Frontend, Docs | Determines branch naming + assignee |
| **Type** | Feature, Bug, Docs | Determines commit prefix |
| **Priority** | P0 Must Have, P1 Should Have, P2 Nice to Have | Urgency |
| **Size** | XS, S, M, L, XL | Effort estimate |
| **Milestone** | Sprint 1, Sprint 2 | Sprint |
| **Creation Date** | date | When created |
| **Due Date** | date | Target completion |

Skills read board fields via `gh project item-list` — no labels needed.

---

## Branches

| Track + Type | Pattern | Example |
|-------------|---------|---------|
| Backend + Feature | `feature/s2-{NN}-{slug}` | `feature/s2-03-tail-spend` |
| Frontend + Feature | `feature/s2-fe-{NN}-{slug}` | `feature/s2-fe-02-sync-ui` |
| Backend + Bug | `fix/s2-{slug}` | `fix/s2-sync-rules-taxonomy` |
| Frontend + Bug | `fix/s2-fe-{slug}` | `fix/s2-fe-review-toggle` |
| Docs (any) | `docs/s2-{NN}-{slug}` | `docs/s2-09-qc-architecture` |

All PRs target `dev`. Release PRs from `dev` to `main`.

---

## Non-Coding Issues

Not all issues require code. Planning, research, and documentation tasks use Track=Docs:

- **Branch:** `docs/s2-{NN}-{slug}`
- **Commit prefix:** `docs(s2-{NN}):`
- **Deliverables:** Markdown files in `internal_docs/`, spec updates, or decision records
- **No tests/typecheck** — PR review is the quality gate
- **Examples:** "Plan QC agent architecture", "Research NAICS data sources", "Reorganize GitHub project"

Same 3-skill workflow applies: `/create-issue` → `/implement-issue` → `/merge-pr`

---

## Cross-Impact Tracking

When `/merge-pr` merges a PR that modifies files created by other issues, it posts comments like:

```markdown
## Modified by PR #XX

Added searchResults parameter to researchSupplier().

- Backward compatible: yes
- Files: `src/main/services/supplier-research.ts`

See PR #XX for details.
```

These comments are read by `/implement-issue` during context gathering, so future implementations account for what changed.

---

## Sub-Issues

GitHub sub-issues allow decomposing large features into independently implementable units.

### When to Use

- Features spanning multiple tracks (e.g., backend + frontend)
- Size L or XL features
- Features with natural decomposition into independently implementable units

### When NOT to Use

- Bug fixes (keep standalone unless part of a cleanup epic)
- Size XS/S/M single-track features
- Features that are already focused and single-track

### Conventions

- **Parent title:** `S2-{NN}: {Feature Name}` (same as regular issues)
- **Sub-issue title:** `S2-{NN}.{X}: {Sub-feature Name}` (e.g., `S2-01.1: ColabIP Git Sync Backend`)
- **Parent body:** Summary + acceptance criteria for the whole feature. May include a "Planned Sub-Issues" checklist.
- **Sub-issue body:** Detailed scope for that piece, links to parent.
- **Board fields:** Sub-issues inherit Thread/Priority/Milestone from parent, get their own Track/Type/Size.
- **Implementation:** Implement sub-issues, not parents. Parent closes when all sub-issues close.
- **Decomposition:** Flexible — each parent decides its own breakdown based on complexity.
- **Incremental:** Parents don't need sub-issues at creation time. Sub-issues are added as work is scoped. Existing standalone issues can become parents retroactively.

### Sub-Issue Commands

The `gh` CLI doesn't natively support sub-issues yet. Use GraphQL:

```bash
# Get issue node IDs
PARENT_ID=$(gh issue view {PARENT_NUM} --json id --jq '.id')
CHILD_ID=$(gh issue view {CHILD_NUM} --json id --jq '.id')

# Link child as sub-issue of parent
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='mutation { addSubIssue(input: {issueId: "'$PARENT_ID'", subIssueId: "'$CHILD_ID'"}) { issue { title } subIssue { title } } }'

# Check sub-issues on an issue
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='{ repository(owner:"kavyald", name:"colab-ap-classifier") { issue(number:{NUM}) { trackedInIssues(first:1) { nodes { number title } } trackedIssues(first:20) { nodes { number title state } } } } }'
```

### Cross-Impact with Sub-Issues

When `/merge-pr` detects that a changed file was created by a sub-issue, it posts:
1. "Modified by PR #XX" on the **originating sub-issue** (same as regular issues)
2. A summary on the **parent issue**: "Sub-issue #{NN} modified by PR #XX — {brief description}"

This ensures parent issues accumulate a log of all changes across their sub-issues.

---

## What NOT to Do

- Don't merge PRs manually — use `/merge-pr` so cross-impact is tracked
- Don't create issues without `/create-issue` — ensures board fields and milestone are set
- Don't add labels — all metadata lives on the project board
- Don't skip board fields — they drive skill automation and dashboard views
- Don't implement parent issues directly — implement sub-issues instead
