---
name: create-issue
description: Gather context from specs, plan scope with the user, and create a well-defined GitHub issue with proper project board fields.
user-invocable: true
argument-hint: "<topic or description>"
---

# Create Issue

You are creating a new GitHub issue for the Colab91 AP Classifier.

**Argument:** `$ARGUMENTS` — a short topic or description of the work to be done.

Examples:
- `/create-issue tail spend optimization in classification`
- `/create-issue add NAICS lookup table for supplier validation`
- `/create-issue sync conflict resolution UI`
- `/create-issue plan QC agent architecture`
- `/create-issue reorganize GitHub project board`

If no argument is provided, ask the user what they want to create an issue for.

---

## Phase 1: Context Gathering

### 1.1 Understand the Topic

Read the relevant spec sections based on the topic:
- `internal_docs/core/features.md` — business rules, feature definitions
- `internal_docs/core/backend_spec.md` — backend architecture (if backend work)
- `internal_docs/core/frontend_spec.md` — UI layouts, interactions (if frontend work)
- `internal_docs/core/ipc_contract.md` — IPC channel definitions (if IPC changes needed)
- `internal_docs/core/schema.md` — DuckDB schema (if database changes needed)

Only read sections relevant to the topic — don't read entire files. For non-coding issues (planning, research, PM), you may not need to read specs at all.

### 1.2 Check for Overlaps and Parent Relationships

Search existing issues for overlap:
```bash
gh issue list --repo kavyald/colab-ap-classifier --state all --json number,title,state --limit 100
```

Filter results for issues related to the topic. If an existing issue covers the same scope, tell the user and ask how to proceed.

Also check if any open issue could be a parent for this work. For candidate parents, check their sub-issues:
```bash
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='{ repository(owner:"kavyald", name:"colab-ap-classifier") { issue(number:{CANDIDATE_NUM}) { trackedIssues(first:20) { nodes { number title state } } } } }'
```

### 1.3 Understand Current State

Read any closed issues and their comments that relate to this area to understand:
- What has been implemented
- Any cross-impact comments ("Modified by PR #XX") that affect this area
- Known deviations or bugs

### 1.4 Determine Board Fields and Sub-Issue Relationship

Based on the topic, propose values for:
- **Thread:** One of `Project Mgmt`, `Data Import`, `Taxonomy`, `Supplier`, `Classification`, `System Feedback`, `Export & Sync`, `Infrastructure`, `Misc Process`
- **Track:** `Backend`, `Frontend`, or `Docs` (use Docs for planning, research, documentation, PM tasks)
- **Type:** `Feature`, `Bug`, or `Docs`

Autonomously determine sub-issue relationship:
- If an open parent issue clearly relates to this topic → plan to link as a sub-issue after creation
- If the topic is large or spans multiple tracks → plan to create as a parent with "Planned Sub-Issues" in the body
- Otherwise → standalone issue (no sub-issue linking)

---

## Phase 2: Plan with User

### 2.1 Present Findings

Share with the user:
- Relevant spec sections found
- Related existing issues (open or closed)
- Current codebase state in this area (cross-impact comments, known deviations)
- Proposed Thread, Track, and Type
- Sub-issue relationship (if applicable): "This will be linked as a sub-issue of #{NN}" or "This is large enough to be a parent issue"

### 2.2 Propose Issue Scope

Draft the issue with:
- **Title:** A clear, descriptive title (no sprint prefix). Examples:
  - `Tail spend optimization in classification`
  - `Add NAICS lookup table for supplier validation`
- **Summary:** 1-2 sentences describing the work
- **Acceptance Criteria:** Checkboxed list of deliverables
- **Deliverables:** For coding issues, list files to create/modify. For non-coding issues, describe the output (e.g., "Architecture doc in `internal_docs/`", "Updated spec section", "Research summary in issue")
- **Relevant Specs:** Links to spec sections (if applicable)
- **Planned Sub-Issues:** (parent issues only) Text checklist of anticipated sub-issue breakdown

### 2.3 Ask for Project Board Fields

Ask the user to confirm or adjust these fields (will be set on the GitHub Project board):
- **Thread:** (proposed value from 1.4)
- **Track:** (proposed value from 1.4)
- **Type:** (proposed value from 1.4)
- **Priority:** P0 - Must Have, P1 - Should Have, or P2 - Nice to Have
- **Size:** XS, S, M, L, or XL
- **Due Date** (e.g., "Feb 20", "2026-02-25")

### 2.4 Iterate

Ask the user to refine:
- Adjust scope (add/remove acceptance criteria)
- Clarify requirements
- Confirm all board field values

Continue until the user is satisfied.

---

## Phase 3: Create Issue

### 3.1 Create the Issue

Auto-assign based on Track:
- Track=Backend → `--assignee kavyald`
- Track=Frontend → `--assignee prince1823`
- Track=Docs → no `--assignee` flag

```bash
gh issue create --repo kavyald/colab-ap-classifier \
  --title "{descriptive title}" \
  --milestone "Sprint 2" \
  --assignee "{assignee if Backend or Frontend}" \
  --body "$(cat <<'EOF'
## Summary

{summary}

## Acceptance Criteria

- [ ] {criterion 1}
- [ ] {criterion 2}
- [ ] {criterion 3}

## Deliverables

- {For coding: `src/main/services/{file}.ts` — {what changes}}
- {For non-coding: "Architecture doc in `internal_docs/{topic}.md`"}

## Relevant Specs

- `internal_docs/core/features.md` — {section}
- `internal_docs/core/{spec}.md` — {section}
EOF
)"
```

### 3.3 Set Project Board Fields

After the issue is created, add it to the project board and set all fields:

```bash
# Add issue to project and get item ID
ITEM_ID=$(gh project item-add 1 --owner @me \
  --url "https://github.com/kavyald/colab-ap-classifier/issues/{ISSUE_NUM}" \
  --format json --jq '.id')

# Set Creation Date (today)
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTF_lAHOBz9njM4BPG2-zg9nVPk" \
  --date "{YYYY-MM-DD today}"

# Set Due Date (from user input)
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTF_lAHOBz9njM4BPG2-zg9nVG0" \
  --date "{YYYY-MM-DD due date}"

# Set Thread field
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTSSF_lAHOBz9njM4BPG2-zg9tiGQ" \
  --single-select-option-id "{thread option ID}"

# Set Track field
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTSSF_lAHOBz9njM4BPG2-zg9tmAk" \
  --single-select-option-id "{track option ID}"

# Set Type field
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTSSF_lAHOBz9njM4BPG2-zg9tmDw" \
  --single-select-option-id "{type option ID}"

# Set Priority field
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTSSF_lAHOBz9njM4BPG2-zg9tiGU" \
  --single-select-option-id "{priority option ID}"

# Set Size field
gh project item-edit --project-id "PVT_kwHOBz9njM4BPG2-" \
  --id "$ITEM_ID" \
  --field-id "PVTSSF_lAHOBz9njM4BPG2-zg9tiGY" \
  --single-select-option-id "{size option ID}"
```

Thread option IDs:
- Project Mgmt: `b1261713`
- Data Import: `d0f261a6`
- Taxonomy: `21d07415`
- Supplier: `5dc998dd`
- Classification: `86e7628b`
- System Feedback: `190196e5`
- Export & Sync: `d14af73c`
- Infrastructure: `539f4ccd`
- Misc Process: `2260f1ec`

Track option IDs:
- Backend: `0ff51a76`
- Frontend: `7cf945fb`
- Docs: `876b3b31`

Type option IDs:
- Feature: `f692ea98`
- Bug: `f3a15d5c`
- Docs: `2395abc6`

Priority option IDs:
- P0 - Must Have: `79050998`
- P1 - Should Have: `7327fd66`
- P2 - Nice to Have: `ad4bada0`

Size option IDs:
- XS: `5c4518ce`
- S: `171a2345`
- M: `d47219c7`
- L: `794920a3`
- XL: `8e7bca42`

### 3.4 Link as Sub-Issue (if applicable)

If this issue should be a sub-issue of a parent, link it:

```bash
# Get node IDs
PARENT_ID=$(gh issue view {PARENT_NUM} --repo kavyald/colab-ap-classifier --json id --jq '.id')
CHILD_ID=$(gh issue view {NEW_ISSUE_NUM} --repo kavyald/colab-ap-classifier --json id --jq '.id')

# Link as sub-issue
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='mutation { addSubIssue(input: {issueId: "'$PARENT_ID'", subIssueId: "'$CHILD_ID'"}) { issue { title } subIssue { title } } }'
```

### 3.5 Report

Output the issue number and URL so the user can review it. If linked as a sub-issue, mention the parent.
