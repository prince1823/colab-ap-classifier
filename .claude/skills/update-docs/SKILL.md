---
name: update-docs
description: Read a PR and connected daily logs to detect spec drift and propose targeted doc updates.
user-invocable: true
argument-hint: "<PR_number>"
---

# Update Docs

You are detecting spec drift and proposing documentation updates for the Colab91 AP Classifier.

**Argument:** `$ARGUMENTS` — a PR number (e.g., `85`).

Examples:
- `/update-docs 85`
- `/update-docs 70`

If no argument is provided, ask the user which PR to analyze.

---

## Phase 1: PR Analysis

### 1.1 Read the PR

```bash
gh pr view $PR_NUM --repo kavyald/colab-ap-classifier --json title,body,headRefName,createdAt,updatedAt,files,state
```

Extract:
- **Title and body** — what was built
- **Head branch** — for matching daily logs
- **Date range** — createdAt to updatedAt
- **Changed files** — list of files modified by the PR

### 1.2 Get the Full Diff

```bash
gh pr diff $PR_NUM --repo kavyald/colab-ap-classifier
```

Read the diff to understand what actually changed in the code.

### 1.3 Identify Linked Issue

Parse the PR body for `Closes #NN` or `Implements #NN`. If found, read the issue for additional context:

```bash
gh issue view $ISSUE_NUM --repo kavyald/colab-ap-classifier --json title,body
```

---

## Phase 2: Find Connected Daily Logs & Sessions

### 2.1 Search Daily Logs by Branch

The PR's head branch name connects it to daily logs. Each developer has a persistent log file (`{developer}.md`). Search all log files for matching branch references:

```bash
grep -rl "Branch:.*{head_branch}" internal_docs/daily_logs/ 2>/dev/null
```

### 2.2 Read Matching Logs

For each matching log, extract:
- **Type** — `Feature` or `Scratchpad`
- **User's notes** — what they worked on, key decisions, lingering thoughts
- **Session JSONL filename** — for reading the full conversation transcript

**Filter by session type:** Only follow session JSONL links for **Feature** sessions. Scratchpad sessions are logged for reference but are unlikely to contain meaningful spec-affecting changes — skip their transcript analysis.

### 2.3 Read Session Transcripts

Daily logs store only the session filename (e.g., `f8f477de.jsonl`). Resolve the full path by deriving the project session directory from the working directory:

```bash
PROJECT_DIR=$(pwd | sed 's|/|-|g; s|^-||')
SESSION_PATH=~/.claude/projects/${PROJECT_DIR}/{session_filename}
```

Parse the JSONL to extract:

```bash
# Extract user messages (intent and decisions)
python3 -c "
import json, sys
for line in open('{session_jsonl_path}'):
    obj = json.loads(line)
    if obj.get('type') == 'user' and isinstance(obj.get('message', {}).get('content'), str):
        print(obj['message']['content'][:200])
" 2>/dev/null | head -50
```

```bash
# Extract files written/edited (tool uses)
python3 -c "
import json
for line in open('{session_jsonl_path}'):
    obj = json.loads(line)
    if obj.get('type') == 'assistant':
        msg = obj.get('message', {})
        for c in msg.get('content', []):
            if c.get('type') == 'tool_use' and c.get('name') in ('Write', 'Edit'):
                inp = c.get('input', {})
                print(f\"{c['name']}: {inp.get('file_path', 'unknown')}\")
" 2>/dev/null
```

This gives you the developer's intent (user messages) and what was actually changed (tool uses).

### 2.4 No Logs Found

If no daily logs match the PR branch:

```
No daily logs found for branch `{branch}`.

Proceeding with PR diff analysis only. For richer context in future PRs, run `/close-session` at the end of each session.
```

Continue to Phase 3 — daily logs are supplementary, not required.

---

## Phase 3: Drift Detection

### 3.1 Map Changed Files to Doc Sections

For each source file changed in the PR, determine which documentation sections might be affected:

| File Pattern | Check These Docs |
|--------------|-----------------|
| `src/main/ipc/*.ts` | `internal_docs/core/ipc_contract.md`, `internal_docs/core/backend_spec.md` |
| `src/main/services/*.ts` | `internal_docs/core/backend_spec.md`, `internal_docs/core/features.md` |
| `src/main/agents/*.ts` | `internal_docs/core/backend_spec.md`, `internal_docs/core/features.md` |
| `src/shared/types/*.ts` | `internal_docs/core/ipc_contract.md`, `internal_docs/core/schema.md` |
| `src/renderer/pages/*.tsx` | `internal_docs/core/frontend_spec.md`, `internal_docs/core/features.md` |
| `src/renderer/components/*.tsx` | `internal_docs/core/frontend_spec.md` |
| `src/renderer/hooks/*.ts` | `internal_docs/core/frontend_spec.md` |
| `src/preload.ts` | `internal_docs/core/ipc_contract.md` |
| `.claude/skills/**` | `CLAUDE.md` (development workflow section), `internal_docs/practices.md` |
| `internal_docs/practices.md` | `CLAUDE.md` (if practices references changed) |
| `package.json` | `CLAUDE.md` (tech stack section, if deps changed significantly) |

Files in `tests/` — no doc changes needed (tests document code, not vice versa).

### 3.2 Read Relevant Doc Sections

For each doc file identified in 3.1, search for references to the changed code:

```bash
# Find references to a service or function name
grep -n "{service_name}\|{function_name}" internal_docs/core/{spec_file}.md
```

Read the surrounding section to understand what the doc currently says.

### 3.3 Identify Drift

Compare what the doc says vs. what the code now does (from the PR diff + session context). Look for:

- **Signature changes** — function or IPC channel signatures that differ from spec
- **New additions** — new IPC channels, services, or agents not yet documented
- **Behavior changes** — logic changes (e.g., LLM parsing hardening) not reflected in specs
- **Removed features** — things deleted in code but still described in docs
- **Schema changes** — new fields or tables not in `schema.md`
- **Workflow changes** — new skills, branch patterns, or conventions not in `practices.md` or `CLAUDE.md`

For each drift found, record:
- **Doc file** to update
- **Section** (heading and line range)
- **Current text** (what the doc says)
- **Code reality** (what the code now does)
- **Proposed change** (minimal edit to align)

---

## Phase 4: Propose Updates

### 4.1 Present Findings

Show the user a numbered summary:

```
Spec drift analysis complete for PR #{PR_NUM}.

Sources analyzed:
- PR diff: {N} files changed
- Daily logs: {N} matching logs found
- Session transcripts: {N} sessions reviewed

Found {N} areas where docs are out of sync:

1. **internal_docs/core/backend_spec.md** (Section: Classification)
   - Current: describes Phase 4 override rules
   - Code reality: Phase 4 removed, pipeline is pure LLM
   - Proposed: remove Phase 4 description, update flow

2. **internal_docs/core/ipc_contract.md** (Section: Classification)
   - Current: missing `classification:getLLMConfig` channel
   - Code reality: new channel added
   - Proposed: add channel with request/response types

{etc.}
```

If no drift detected:

```
No spec drift detected for PR #{PR_NUM}.

Analyzed:
- {N} source files in PR diff
- {N} doc sections checked

All documentation appears up to date with the code changes.
```

### 4.2 Get User Approval

```
How would you like to proceed?

- "yes" or "all" — apply all proposed changes
- "skip N" — apply all except item N
- "only N" — apply only item N
- "show N" — show the exact before/after for item N
- "cancel" — don't update anything
```

Wait for the user to respond.

---

## Phase 5: Apply Updates

### 5.1 Make Edits

For each approved update, apply a minimal, surgical edit to the doc file:

- **Adding a section:** Insert in the appropriate place
- **Updating text:** Edit only the affected sentences/paragraphs
- **Removing outdated text:** Delete only what's no longer accurate

Use the Edit tool for targeted changes. Do NOT rewrite entire sections.

### 5.2 Report Progress

After each edit:

```
Updated internal_docs/core/backend_spec.md (Section: Classification) — removed Phase 4 description
```

### 5.3 Final Summary & Commit

Present the summary and ask whether to commit:

```
Doc updates complete for PR #{PR_NUM}.

Updated files:
- internal_docs/core/backend_spec.md
- internal_docs/core/ipc_contract.md

Changes: {N} sections updated, {N} added, {N} removed

Would you like me to commit these changes?
```

If the user confirms, commit:

```bash
git add internal_docs/ CLAUDE.md
git commit -m "docs: sync specs with PR #{PR_NUM}"
```

If the user declines, leave the changes uncommitted and let them review with `git diff internal_docs/`.

---

## Edge Cases

### PR Already Merged

Still works — `gh pr diff` returns the diff for merged PRs too. Proceed normally.

### No Source Files Changed

If the PR only changes tests, docs, or config with no `src/` files:

```
PR #{PR_NUM} contains no source code changes (only tests/docs/config).

No spec drift analysis needed — specs track source code behavior, not tests.
```

### Session JSONL Not Found

If a daily log references a session file that no longer exists:

```
Warning: Session file referenced in daily log not found:
  {path}

Proceeding with PR diff and daily log summary only.
```

### Conflicting Changes

If a doc file has uncommitted changes:

```
Warning: {doc_file} has uncommitted changes.

Options:
- Commit or stash current changes first
- Proceed anyway (may need manual conflict resolution)
- Cancel
```
