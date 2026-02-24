---
name: merge-pr
description: Merge a PR into dev and post cross-impact comments on issues whose code was modified.
user-invocable: true
argument-hint: "<PR_NUMBER>"
---

# Merge PR

You are merging a pull request into dev and tracking cross-impact for the Colab91 AP Classifier.

**Argument:** `$ARGUMENTS` — a PR number (e.g., `70`).

Examples:
- `/merge-pr 70`
- `/merge-pr 65`

If no argument is provided, ask the user which PR to merge.

---

## Phase 1: Pre-Merge Check

### 1.1 Read the PR

```bash
gh pr view $PR_NUM --repo kavyald/colab-ap-classifier --json title,body,state,baseRefName,headRefName,mergeable,statusCheckRollup
```

Verify:
- PR targets `dev` (not `main`)
- PR is not already merged (if it is, skip to Phase 3)
- No merge conflicts

### 1.2 Get Changed Files

```bash
gh pr diff $PR_NUM --repo kavyald/colab-ap-classifier --stat
```

Save the list of changed source files (files in `src/`). Exclude test files (`tests/`) and docs.

### 1.3 Identify Closed Issue

Parse the PR body for `Closes #NN` or `Fixes #NN` to identify which issue this PR closes.

---

## Phase 2: Merge

### 2.1 Check State

```bash
gh pr view $PR_NUM --repo kavyald/colab-ap-classifier --json state --jq '.state'
```

- If `MERGED`: Print "PR already merged. Running cross-impact analysis only." → skip to Phase 3.
- If `OPEN`: Proceed with merge.

### 2.2 Merge

```bash
gh pr merge $PR_NUM --repo kavyald/colab-ap-classifier --merge
```

Use `--merge` (not squash) to preserve commit history for cross-impact file tracking.

GitHub will auto-close the linked issue via `Closes #NN` in the PR body.

### 2.3 Update Local

```bash
git checkout dev
git pull origin dev
```

### 2.4 Clean Up Branch

Delete the merged feature branch locally if it exists:
```bash
git branch -d <branch-name>
```

---

## Phase 3: Cross-Impact Analysis

### 3.1 Map Files to Issues

For each changed source file (from Phase 1.2), find which issue originally created it:

```bash
git log --follow --diff-filter=A --format="%H %s" -- <file>
```

This shows the commit that first created the file. Parse the commit message for issue references:
- `Closes #NN`
- Issue number reference in commit message (e.g., `#NN`)
- `Implements #NN`

Skip files that:
- Were created by the same issue being closed by this PR
- Are in `tests/` or `internal_docs/`
- Have no traceable originating issue

For each affected issue, also check if it has a parent issue (sub-issue relationship):
```bash
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='{ repository(owner:"kavyald", name:"colab-ap-classifier") { issue(number:{ISSUE_NUM}) { trackedInIssues(first:1) { nodes { number title } } } } }'
```
Track parent issues for step 3.4.

### 3.2 Assess Impact

For each affected issue, read the diff for that file and summarize:
- What functions/signatures changed
- Whether the change is backward compatible
- Any behavioral changes

### 3.3 Check for Stale Comments

For each affected issue, check if there are existing "Modified by PR #XX" comments that reference the same files:

```bash
gh api repos/kavyald/colab-ap-classifier/issues/{ISSUE_NUM}/comments --jq '.[] | select(.body | test("Modified by PR")) | {id: .id, body: .body}'
```

If a previous comment exists for the same file:
- Edit it to append a note that it's been superseded:

```bash
gh api repos/kavyald/colab-ap-classifier/issues/comments/{COMMENT_ID} -X PATCH -f body="$(cat <<'EOF'
{original comment body}

> Superseded by PR #YY — see below
EOF
)"
```

### 3.4 Post Cross-Impact Comments

For each affected issue, post a new comment:

```bash
gh issue comment {ISSUE_NUM} --repo kavyald/colab-ap-classifier --body "$(cat <<'EOF'
## Modified by PR #XX

{1-2 sentence description of what changed in this issue's files}

- Backward compatible: {yes/no}
- Files: `{file path}`

See PR #XX for details.
EOF
)"
```

**Sub-issue propagation:** If the affected issue has a parent (from step 3.1), also post a summary on the parent issue:

```bash
gh issue comment {PARENT_ISSUE_NUM} --repo kavyald/colab-ap-classifier --body "$(cat <<'EOF'
## Sub-issue #{CHILD_NUM} modified by PR #XX

{1-2 sentence description of what changed}

- Backward compatible: {yes/no}
- Files: `{file path}`

See PR #XX for details.
EOF
)"
```

This ensures parent issues accumulate a log of all changes across their sub-issues.

### 3.5 Report

Output a summary:
```
Merged PR #70 into dev.
Issue #65 closed.
Cross-impact comments posted on: #14, #20
Updated stale comment on #14 (from PR #55).
```

If no cross-impact was found:
```
Merged PR #70 into dev.
Issue #65 closed.
No cross-impact detected — only new or test files changed.
```
