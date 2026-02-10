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
├── internal_docs/          # Specs — dev branch only, not pushed to main
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

## Spec Documents

Authoritative specs live in `internal_docs/` (dev branch only). Read before implementing.

| File | Covers |
|------|--------|
| `internal_docs/features.md` | Product spec — business rules, feature definitions (the "what" and "why") |
| `internal_docs/backend_spec.md` | Backend architecture, classification pipeline, LLM config |
| `internal_docs/frontend_spec.md` | UI layouts, interactions, workflow constraints |
| `internal_docs/ipc_contract.md` | Full IPC API contract with TypeScript types (50+ channels) |
| `internal_docs/schema.md` | DuckDB schema — 10 tables with SQL and field descriptions |
| `internal_docs/sprint_docs/` | Sprint feature checklists (v1 in-progress, v2 planned) |

## Key Conventions

### IPC
- Channels follow `namespace:method` naming (e.g., `project:new`, `classification:start`)
- All handlers return `IPCResponse<T>`: `{ success: boolean; data?: T; error?: string }`
- Events (main→renderer) do NOT use the response envelope

### Taxonomy
- 3-level hierarchy: L1 → L2 → L3
- L1 is constrained to exactly: **Direct**, **Indirect**, **Exempt**
- Paths are pipe-delimited: `"Direct|IT|Software"`
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
- Env vars: `CLASSIFIER_LLM_PROVIDER`, `CLASSIFIER_MODEL`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`

## Development

### Branches
- `dev` — active development
- `main` — stable, PRs target here

## Current Status

**Pre-development.** No source code yet. Specs complete in `internal_docs/`.
- Sprint 1 (v1): in-progress — see `internal_docs/sprint_docs/sprint_1.md`
- Sprint 2 (v2): not started
