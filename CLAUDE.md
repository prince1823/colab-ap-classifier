# Colab91 AP Classifier

Electron desktop app for automated classification of accounts payable transactions using LLMs. Users import CSV transaction data, configure taxonomy and company context, run an AI classification pipeline, then review and correct results.

## Tech Stack

- **Runtime:** Electron (main: Node.js, renderer: Chromium)
- **Frontend:** React + TypeScript
- **Backend:** Node.js + TypeScript (Electron main process)
- **Database:** DuckDB — embedded, per-project `.c91` files
- **LLM:** OpenRouter API (routes to Claude, GPT, etc. with one key)
- **Data sync:** Git/GitHub (ColabIP shared repo for taxonomy, rules, suppliers)
- **Package manager:** npm

## Architecture

```
Renderer (React) <-- IPC --> Main Process (Node.js)
                                 ├── IPC Handlers
                                 ├── Classification Pipeline
                                 ├── LLM Agents --> OpenRouter
                                 ├── DuckDB (.c91 files)
                                 └── Git Sync --> ColabIP (GitHub)
```

- **Renderer:** React UI with workflow tabs — Upload → Canonicalization → Data Review → Classification → Review → Output
- **Main process:** IPC handlers, classification pipeline, git sync, DB access
- **4 LLM agents:** ClassificationAgent, CanonicalizationAgent, ResearchAgent, FeedbackAgent
- **Storage:** each project is a single `.c91` DuckDB file (portable, self-contained). Default location: `./projects/` (gitignored). Recent projects tracked in `~/.config/Colab91 Classifier/recent-projects.json`
- **ColabIP:** shared GitHub repo with master taxonomies, override rules, and supplier universe. Data is copied into projects at import time — projects don't reference ColabIP at runtime.

## Project Structure

```
colab-ap-classifier/
├── CLAUDE.md
├── .gitignore
├── .claude/                # Claude Code skills
│   └── skills/             # Slash command skills (/implement-issue)
├── .github/                # GitHub config
│   └── issues/             # Archive only (S1 artifacts in archive/sprint-1/)
├── claude/                 # Claude Code config (agents, skills)
├── projects/               # .c91 project files (gitignored)
├── colabip/                # Local ColabIP clone
├── src/
│   ├── main/               # Electron main process
│   │   ├── ipc/            # IPC handler registrations
│   │   ├── services/       # DB, git-sync, classification pipeline
│   │   └── agents/         # LLM agent implementations
│   ├── renderer/           # React frontend
│   │   ├── components/
│   │   ├── pages/          # Workflow tab pages
│   │   └── hooks/
│   ├── shared/             # Shared types, constants
│   │   └── types/          # TypeScript interfaces (IPC, DB models)
│   └── preload.ts          # Electron preload (contextBridge)
├── package.json
└── tsconfig.json
```

## Key Conventions

### IPC
- Channels follow `namespace:method` naming (e.g., `project:new`, `classification:start`)
- All handlers return `IPCResponse<T>`: `{ success: boolean; data?: T; error?: string }`
- Events (main→renderer) do NOT use the response envelope

### Taxonomy
- 3-level hierarchy: L1 → L2 → L3
- Paths are pipe-delimited: `"Corporate Services|IT|Software"`
- Each project has its own copy of the taxonomy (imported from ColabIP)

### Override Rules
- Priority score bands by source: project (100-199), taxonomy (200-299), supplier (300-399)
- Conditions: JSON array of `{field, operator, value}` — AND logic, first match wins
- Rule-matched rows get review_score = 0

### Canonical Columns
- CSV columns are mapped to snake_case canonical names (`supplier_name`, `spend_amount`, `gl_description`, etc.)
- `transactions` table has a dynamic schema — canonical columns added via ALTER TABLE at runtime
- Frontend discovers available columns via `transactions:getColumns` IPC call

### LLM Configuration
- Default model: `claude-3-5-haiku-latest`
- Env vars (loaded from `.env` at startup via `src/main/load-env.ts`): `CLASSIFIER_LLM_PROVIDER`, `CLASSIFIER_MODEL`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- LLM response parsing is hardened: canonicalization agent auto-corrects inverted mappings, classification agent unwraps `{"transactions": [...]}` envelopes

## Development

### Branches
- `dev` — active development (feature PRs target here)
- `main` — stable (release PRs from dev)
- Feature/fix/docs branches: follow naming conventions in skill files

### Development Workflow

Skills-based, issue-driven development.

```
/create-issue  →  /implement-issue  →  /close-session  →  /update-docs  →  /merge-pr
  (define)         (build + PR)       (log session)  (sync specs)     (merge + track)
```

- `/create-issue` — reads specs, plans scope with user, creates GitHub issue with board fields
- `/implement-issue` — reads issue + board fields, implements on branch, presents summary, creates PR to `dev` after user approval
- `/close-session` — classifies session (Feature/Scratchpad), captures verbatim summary with session link
- `/update-docs <PR_number>` — reads PR diff + connected daily logs/sessions, detects spec drift, proposes doc updates
- `/merge-pr` — merges PR into `dev`, posts cross-impact comments on affected issues
- All issue metadata lives on the GitHub Project board (Thread, Track, Type, Priority, Size)
- Issues support sub-issues for decomposing large features

### GitHub Setup

```bash
# Authenticate gh CLI (one-time)
GH_TOKEN=ghp_your_token bash .github/setup-gh-auth.sh
```

## Current Status

- Sprint 1 (v1): **complete** — 25 backend + 17 frontend issues closed. Artifacts archived in `.github/issues/archive/sprint-1/`.
- Sprint 2 (v2): **in progress**
