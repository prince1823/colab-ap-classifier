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
                                            ├── Orchestrators (ClassificationRunner, SupplierResearcher, QCRunner)
                                            ├── Data Services (stores, ingest, export)
                                            ├── Agents (Classification, Research, ColumnMapping, Feedback, QC, CatA) → OpenRouter
                                            ├── Leaf Layer (DuckDB, LLMClient, ExaWebSearch)
                                            └── EventBus → webContents.send (progress events)
                                       ┌────────┼────────────┐
                                  .c91 Files   supplier_    OpenRouter
                                  (DuckDB)     universe.db  / Exa APIs
```

- **Renderer:** React UI with two route groups — **workflow steps** (Upload → DataReview → Classification → Review → Output) and **project views** (CompanyContext, Taxonomy, Suppliers, OverrideRules, VersionHistory). State managed via Zustand (`workflowStore`) and `useIPC<T>` hook.
- **Main process:** DI container (`container.ts`), IPC handlers, orchestrators, DB access. No git sync.
- **6 LLM agents:** ClassificationAgent, ResearchAgent, ColumnMappingAgent, FeedbackAgent, QCAgent, CatAAgent
- **Orchestrators:** ClassificationRunner, SupplierResearcher, QCRunner
- **DI Container:** `createContainer()` in `src/main/container.ts` — lightweight factory, no framework. All services receive dependencies via constructor.
- **EventBus:** single typed event emitter for async progress (classification, supplier research). Services emit events; entry point forwards to renderer via `webContents.send`.
- **Storage:** each project is a single `.c91` DuckDB file (portable, self-contained). Project location is user-chosen via Electron's save dialog (no app-managed default directory) — the OS remembers the last-used location. The shared `supplier_universe.db` path is also user-chosen — `AppConfig.getSupplierUniversePath()` returns whatever the user configured (or `null` if unset); there is no built-in default. The repo's `./projects/` and `./colabip/` directories are dev/test conventions only (gitignored) — the packaged app does not write to or read from them.
- **ColabIP:** local directory with master taxonomy files imported into projects. No runtime sync or git integration in the app.

## Project Structure

```
colab-ap-classifier/
├── CLAUDE.md
├── .gitignore
├── .claude/                # Claude Code config (settings, launch)
├── .github/                # GitHub config
│   └── issues/             # Archive only (S1 artifacts in archive/sprint-1/)
├── internal_docs/          # Architecture docs, refactor notes
│   └── refactor/           # Post-refactor architecture HTML
├── projects/               # dev/test scratch dir for .c91 files (gitignored; not used at runtime)
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
│   │   ├── pages/          # Workflow + project view pages
│   │   ├── stores/         # Zustand stores (workflowStore)
│   │   └── hooks/
│   ├── shared/             # Shared types, constants
│   │   ├── types/          # TypeScript interfaces (IPC, DB models, services)
│   │   └── canonical-columns.ts  # Canonical column name definitions
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
- Priority is a simple integer ordering (higher = evaluated first; rules sorted `ORDER BY priority DESC`), no predefined bands
- Conditions use `GroupedFilter` (`src/shared/types/transactions.ts`): groups of `{field, operator, value, connector}` conditions, where conditions within a group and groups themselves are joined by per-level AND/OR connectors. Highest-priority matching rule wins.

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
- `SupplierUniverse` is a shared DuckDB file with global supplier data, aliases, and research info; its path is user-configured via `AppConfig.setSupplierUniversePath()` (no built-in default)

### LLM Configuration
- Default model: `claude-3-5-haiku-latest`, default provider: `openrouter`
- **Primary:** Settings UI writes to `llm-config.json` (via `LLMConfigService`, stored in `app.getPath('userData')`). Keys are encrypted via Electron `safeStorage`.
- **Fallback env vars** (loaded from `.env` via `src/main/load-env.ts`): `CLASSIFIER_LLM_PROVIDER`, `CLASSIFIER_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`
- LLM response parsing is hardened: column mapping agent auto-corrects inverted mappings, classification agent unwraps `{"transactions": [...]}` envelopes
- Agent prompt builders and parsers are exported as pure functions alongside classes for standalone test use

## Development

### Branches
- `main` — stable
- `dev` — integration branch and current active development branch; PRs may target here or directly to main
- Feature/fix/docs branches: short descriptive names

### Development Workflow

Issue-driven development via GitHub.

- All issue metadata lives on the GitHub Project board (Thread, Track, Type, Priority, Size)
- Issues support sub-issues for decomposing large features
- PRs describe changes with test plan; merge into `dev` or directly to `main`

### Debug Logging

Logging is opt-in via `LOG_FILE` env var. Noop by default — no I/O overhead in normal dev.

```bash
npm run dev          # no logging
npm run dev:log      # logs to /tmp/c91-debug.log
LOG_FILE=/custom/path.log npm run dev  # logs to custom path
```

`tail -f /tmp/c91-debug.log` to follow live. Implementation: `src/main/utils/debug-log.ts`.

### GitHub Setup

```bash
# Authenticate gh CLI (one-time)
GH_TOKEN=ghp_your_token bash .github/setup-gh-auth.sh
```

## Current Status

- Sprint 1 (v1): **complete** — 25 backend + 17 frontend issues closed. Artifacts archived in `.github/issues/archive/sprint-1/`.
- Sprint 2 (v2): **refactor complete** — DI container, FK-based supplier model, 3-agent system, user-driven workflow. Architecture documented in `internal_docs/refactor/architecture.html`.
