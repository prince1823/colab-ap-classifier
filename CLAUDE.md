# Colab91 AP Classifier

Electron desktop app for automated classification of accounts payable transactions using LLMs. Users import CSV transaction data, configure taxonomy and company context, run AI classification (with web research on suppliers), then review and correct results.

## Tech Stack

- **Runtime:** Electron (main: Node.js, renderer: Chromium)
- **Frontend:** React + TypeScript
- **Backend:** Node.js + TypeScript (Electron main process)
- **Database:** DuckDB — embedded, per-project `.c91` files + shared `supplier_universe.db`
- **LLM:** OpenRouter API (routes to Claude, GPT, etc. with one key)
- **Web Search:** Exa API (supplier research)
- **Package manager:** npm

## Architecture

```
Renderer (React + Zustand) <-- IPC --> Main Process (Node.js)
                                            ├── createContainer() → ServiceContainer
                                            ├── IPC Handlers (receive services as args)
                                            ├── Orchestrators (ClassificationRunner, SupplierResearcher)
                                            ├── Data Services (stores, ingest, export)
                                            ├── Agents (Classification, Research, ColumnMapping) → OpenRouter
                                            ├── Leaf Layer (DuckDB, LLMClient, ExaWebSearch)
                                            └── EventBus → webContents.send (progress events)
                                       ┌────────┼────────────┐
                                  .c91 Files   supplier_    OpenRouter
                                  (DuckDB)     universe.db  / Exa APIs
```

- **Renderer:** React UI with workflow pages — Upload → DataReview → Suppliers → Classification → Review → Output. State managed via Zustand (`workflowStore`) and `useIPC<T>` hook.
- **Main process:** DI container (`container.ts`), IPC handlers, orchestrators, DB access. No git sync.
- **3 LLM agents:** ClassificationAgent, ResearchAgent, ColumnMappingAgent
- **DI Container:** `createContainer()` in `src/main/container.ts` — lightweight factory (~60 lines), no framework. All services receive dependencies via constructor.
- **EventBus:** single typed event emitter for async progress (classification, supplier research). Services emit events; entry point forwards to renderer via `webContents.send`.
- **Storage:** each project is a single `.c91` DuckDB file (portable, self-contained). Default location: `./projects/` (gitignored). Recent projects tracked in `~/.config/Colab91 Classifier/recent-projects.json`. Shared `supplier_universe.db` in `colabip/` holds global supplier data across projects.
- **ColabIP:** local directory with master taxonomy files imported into projects. No runtime sync or git integration in the app.

## Project Structure

```
colab-ap-classifier/
├── CLAUDE.md
├── .gitignore
├── .claude/                # Claude Code skills
│   └── skills/             # Slash command skills (/implement-issue)
├── .github/                # GitHub config
│   └── issues/             # Archive only (S1 artifacts in archive/sprint-1/)
├── internal_docs/          # Architecture docs, refactor notes
│   └── refactor/           # Post-refactor architecture HTML
├── projects/               # .c91 project files (gitignored)
├── colabip/                # Local ColabIP clone + supplier_universe.db
├── src/
│   ├── main/               # Electron main process
│   │   ├── container.ts    # DI container factory (createContainer)
│   │   ├── event-bus.ts    # Typed EventBus singleton
│   │   ├── ipc/            # IPC handler registrations
│   │   ├── services/       # Stores, orchestrators, ingest, export
│   │   ├── agents/         # LLM agent implementations
│   │   └── utils/          # Pure functions (query-builder, text)
│   ├── renderer/           # React frontend
│   │   ├── components/
│   │   ├── pages/          # Workflow pages
│   │   └── hooks/
│   ├── shared/             # Shared types, constants
│   │   └── types/          # TypeScript interfaces (IPC, DB models, services)
│   └── preload.ts          # Electron preload (contextBridge)
├── package.json
└── tsconfig.json
```

## Key Conventions

### IPC
- Channels follow `namespace:method` naming (e.g., `project:new`, `classification:start`, `ingest:importCSV`)
- All handlers return `IPCResponse<T>`: `{ success: boolean; data?: T; error?: string }`
- Events (main→renderer) do NOT use the response envelope
- Handler registration pattern: `registerHandler('namespace:method', async (...args) => handler(services.service, ...args))` — each handler receives its service dependency as argument

### Taxonomy
- 3-level hierarchy: L1 → L2 → L3
- Paths are pipe-delimited: `"Corporate Services|IT|Software"`
- Each project has its own copy of the taxonomy (imported from ColabIP)

### Override Rules
- Priority is a simple integer ordering (lower = higher priority), no predefined bands
- Conditions: JSON array of `{field, operator, value}` — AND logic, first match wins

### Canonical Columns
- CSV columns are mapped to snake_case canonical names (`supplier_name`, `spend_amount`, `gl_description`, etc.)
- `transactions` table has a dynamic schema — canonical columns added via ALTER TABLE at runtime
- Frontend discovers available columns via `transactions:getColumns` IPC call
- Column mappings are stored per-upload in the `uploads` table for reuse on subsequent imports
- Column classification priorities (which columns to send to LLM, in what order) are a separate project-level setting in `project_settings.column_priorities`

### Dependency Injection
- All services receive dependencies via constructor — no module-level singletons (except EventBus)
- Interfaces defined in `src/shared/types/services.ts`; implementations in `src/main/services/`
- `createContainer()` in `src/main/container.ts` wires everything in dependency order
- Layers: Leaf (DB, LLM, WebSearch) → Agents → Data Services → Orchestrators

### Supplier Model
- FK-based: `project_suppliers` table holds canonical supplier names per project
- Transactions reference suppliers via `project_supplier_id` FK — no supplier name string on transactions
- `original_supplier_name` on transactions preserves the raw CSV value as audit trail
- `SupplierUniverse` (`colabip/supplier_universe.db`) is a shared DB with global supplier data, aliases, and research info

### LLM Configuration
- Default model: `claude-3-5-haiku-latest`
- Env vars (loaded from `.env` at startup via `src/main/load-env.ts`): `CLASSIFIER_LLM_PROVIDER`, `CLASSIFIER_MODEL`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- LLM response parsing is hardened: column mapping agent auto-corrects inverted mappings, classification agent unwraps `{"transactions": [...]}` envelopes
- Agent prompt builders and parsers are exported as pure functions alongside classes for standalone test use

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
- Sprint 2 (v2): **refactor complete** — DI container, FK-based supplier model, 3-agent system, user-driven workflow. Architecture documented in `internal_docs/refactor/architecture.html`.
