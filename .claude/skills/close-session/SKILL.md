---
name: close-session
description: Close the current session — classify as scratchpad or feature, capture a log with session link and verbatim user notes.
user-invocable: true
argument-hint: ""
---

# Close Session

You are closing a development session for the Colab91 AP Classifier.

**Argument:** None required.

Examples:
- `/close-session`

When invoked, this skill classifies the session type, captures a brief summary from the user, and saves a log file linked to the session transcript.

---

## Phase 1: Classify Session

### 1.1 Ask Session Type

Prompt the user:

```
What type of session was this?

1. **Feature** — implemented, fixed, or progressed a specific issue/feature
2. **Scratchpad** — explored, experimented, researched, or did ad-hoc work
```

Wait for the user to choose.

**Why this matters:** `/update-docs` uses this classification to decide whether to deeply analyze the session for spec drift. Feature sessions are likely to have meaningful code changes that affect docs. Scratchpad sessions are informational only — they're logged for reference but won't trigger drift analysis.

---

## Phase 2: Identify Session

### 2.1 Find Current Session

The current Claude Code session is stored as a JSONL file. Derive the project's session directory from the working directory:

```bash
PROJECT_DIR=$(pwd | sed 's|/|-|g; s|^-||')
ls -t ~/.claude/projects/${PROJECT_DIR}/*.jsonl | head -1 | xargs basename
```

Record only the filename (e.g., `f8f477de.jsonl`). Never store full paths in the log.

### 2.2 Get Developer Identity

```bash
git config user.name
```

Derive a short identifier from the git user name — take the first name, lowercase (e.g., `Kavya Devanathan` → `kavya`, `Prince Kumar` → `prince`).

### 2.3 Get Branch

```bash
git branch --show-current
```

Record the current git branch name.

### 2.4 Get Commit ID

```bash
git rev-parse --short HEAD
```

Record the short commit hash (e.g., `a1b2c3d`).

### 2.5 Check for Existing Log

Each developer has one persistent log file: `{developer}.md`.

```bash
DEVELOPER={developer from 2.2}
test -f internal_docs/daily_logs/${DEVELOPER}.md && echo "exists" || echo "new"
```

- If the file **exists**: append a new section
- If the file **doesn't exist**: create a new file

---

## Phase 3: Collect User Summary

### 3.1 Ask User

Present this to the user:

```
Brief notes for your session log:

1. **What did you work on?**
2. **Key decisions & outcomes?**
3. **Lingering questions or thoughts?**
```

Wait for the user to respond.

### 3.2 Verbatim Rules

**ABSOLUTE REQUIREMENT:** The user's words must be preserved character-for-character.

**You MUST NOT:**
- Rephrase or reword anything the user writes
- Fix grammar, spelling, or punctuation
- Reorganize bullets or lists
- Summarize or condense their text
- Add your own interpretations or clarifications

**You MUST:**
- Copy the user's text exactly as provided
- Preserve their original formatting, line breaks, indentation
- Keep their bullet style, capitalization, and punctuation
- Include typos or informal language if present

Example — if the user writes:
> fixed the parser thing that was breaking on gpt-4o-mini responses (the array wrapping bug)

You write in the log:
> fixed the parser thing that was breaking on gpt-4o-mini responses (the array wrapping bug)

NOT:
> Fixed parser bug where GPT-4o-mini responses were incorrectly wrapped in arrays

---

## Phase 4: Save Log

### 4.1 Ensure Directory Exists

```bash
mkdir -p internal_docs/daily_logs
```

### 4.2 Determine File

The file is always `internal_docs/daily_logs/{developer}.md` (one persistent file per developer).

### 4.3 Write or Append

**If creating a new file**, write:

```markdown
# Session Log — {developer}

---

## {YYYY-MM-DD}

### {Feature | Scratchpad}

**Branch:** `{git branch}`
**Commit:** `{short commit hash}`
**Session:** `{session filename}`

#### What I worked on

{VERBATIM}

#### Key decisions & outcomes

{VERBATIM}

#### Lingering questions / thoughts

{VERBATIM}
```

**If appending to an existing file**, check whether today's date heading (`## {YYYY-MM-DD}`) already exists.

**If today's date section exists** (second session same day), append under it:

```markdown

---

### {Feature | Scratchpad}

**Branch:** `{git branch}`
**Commit:** `{short commit hash}`
**Session:** `{session filename}`

#### What I worked on

{VERBATIM}

#### Key decisions & outcomes

{VERBATIM}

#### Lingering questions / thoughts

{VERBATIM}
```

**If today's date section does NOT exist** (new day), append:

```markdown

---

## {YYYY-MM-DD}

### {Feature | Scratchpad}

**Branch:** `{git branch}`
**Commit:** `{short commit hash}`
**Session:** `{session filename}`

#### What I worked on

{VERBATIM}

#### Key decisions & outcomes

{VERBATIM}

#### Lingering questions / thoughts

{VERBATIM}
```

### 4.4 Confirm

Tell the user:

```
Session log saved to: internal_docs/daily_logs/{filename}

Your session notes have been preserved exactly as written.
```

If session type was **Feature**:
```
Next steps:
- Run `/update-docs <PR_number>` to check for spec drift from this work
```

If session type was **Scratchpad**:
```
Logged for reference. No further action needed.
```

---

## Edge Cases

### Empty Sections

If the user says "none" or leaves a section blank, omit that `####` heading entirely from the log entry.

### Multiple Sessions

Each `/close-session` call appends a new section to the developer's persistent log file. Same-day sessions go under the existing date heading. Never overwrite — always append.

### User Wants to Edit

If the user asks to change something after seeing the saved log, re-save with their corrections (still verbatim — use their corrected text exactly).
