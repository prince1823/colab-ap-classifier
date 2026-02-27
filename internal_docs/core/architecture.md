# Architecture

Technical architecture for the AP Classifier, organized by the project flow.

---

## Runtime

```
Renderer (React + TypeScript)
    ↕  IPC (contextBridge)
Main Process (Node.js + TypeScript)
    ├── IPC Handlers      → route renderer calls to services
    ├── Services           → business logic, DB access
    ├── Agents             → LLM prompt construction + response parsing
    ├── DuckDB             → per-project .c91 files
    └── ColabIP (fs read)  → shared taxonomies, supplier universe
```

---

## Database Schema

Each project is a single `.c91` DuckDB file. Supplier data lives in a separate shared `supplier_universe.db`.

### project (single row)

One row per project. Company context is stored as a single JSON blob since it's always read/written together (e.g. for LLM prompts).

| Column | Type | Set At | Notes |
|--------|------|--------|-------|
| `id` | VARCHAR PK | creation | UUID |
| `project_name` | VARCHAR | creation | |
| `created_at` | TIMESTAMP | creation | |
| `company_context` | JSON | step 2 | `{ company_name, industry, sector, description, business_focus, procurement_nuances }` |
| `taxonomy_name` | VARCHAR | step 2 | |
| `tail_spend_threshold` | DECIMAL | step 2 | |
| `column_mapping` | JSON | step 3 | All column mappings (canonical→CSV, invoice grouping, etc.) |

### taxonomy

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `full_path` | VARCHAR UNIQUE | Pipe-delimited: `L1\|L2\|L3` |
| `l1` | VARCHAR | |
| `l2` | VARCHAR | nullable |
| `l3` | VARCHAR | nullable |
| `depth` | INTEGER | 1, 2, or 3 |
| `description` | TEXT | |
| `parent_path` | VARCHAR | |
| `created_at` | TIMESTAMP | |

### transactions

Dynamic schema. Base columns are fixed; canonical columns added via ALTER TABLE at import time.

**Base columns:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `row_index` | INTEGER | Original CSV row number |
| `taxonomy_node_id` | VARCHAR | FK → taxonomy.id |
| `classification_status` | VARCHAR | `unclassified`, `classified_by_rule`, `classified_by_ai`, `human_reviewed` |
| `classification_reasoning` | TEXT | LLM reasoning or rule name |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

**Canonical columns** (added dynamically based on column mapping):

`supplier_name`, `line_description`, `gl_description`, `spend_amount`, `gl_code`, `department`, `invoice_date`, `creation_date`, `company`, `cost_center`, `po_number`, `supplier_address`, `currency`, `memo`

### override_rules

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `name` | VARCHAR | Human-readable name |
| `conditions` | JSON | Array of `{field, operator, value, connector}` |
| `target_taxonomy_node_id` | VARCHAR | FK → taxonomy.id |
| `priority_score` | INTEGER | Unique, positive. User-reorderable |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMP | |

### change_log

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `source` | VARCHAR | `manual`, `pipeline`, `rule` |
| `affected_table` | VARCHAR | |
| `affected_ids` | JSON | Array of affected row IDs |
| `affected_count` | INTEGER | |
| `old_values` | JSON | Pre-change values |
| `new_values` | JSON | Post-change values |
| `description` | TEXT | |
| `created_at` | TIMESTAMP | |

### supplier_universe.db (shared, separate file)

Not in the project `.c91`. Shared across projects. Single source of truth for all supplier data.

**There is no project_suppliers table.** All per-project supplier state is derived:
- **Supplier list**: `SELECT DISTINCT supplier_name FROM transactions`
- **Research status**: join against supplier_universe.db — if row exists, supplier is researched
- **Classification status per supplier**: `GROUP BY supplier_name` on `classification_status`
- **Review status per supplier**: same query, check for `human_reviewed`

This eliminates sync risk between project and supplier data.

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UID from supplier service |
| `supplier_name` | VARCHAR UNIQUE | Normalised name |
| `aliases` | JSON | Array of alternative names |
| `parent_supplier_id` | VARCHAR | FK → self |
| `parent_name` | VARCHAR | Denormalized for display |
| `supplier_info` | JSON | Research results (type, industry, etc.) |
| `category_a` | BOOLEAN | Has deterministic taxonomy mapping |
| `category_a_taxonomy_node_id` | VARCHAR | FK → taxonomy.id |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

---

## Services

Services are the business logic layer. Each service owns one concern. IPC handlers call services.

### Core

| Service | Responsibility |
|---------|---------------|
| `database` | DuckDB connection management, query execution, schema init |
| `project` | Create/open/close project, read/write project metadata (company context, settings, column mapping) |

### Data Pipeline

| Service | Responsibility |
|---------|---------------|
| `upload` | CSV parsing, LLM mapping suggestion, confirmed mapping save, import rows into transactions table |
| `taxonomy` | Taxonomy CRUD (import from ColabIP, get nodes, add/edit/delete nodes) |
| `transactions` | Query/filter/paginate transactions, column discovery, stats (time period, top suppliers) |
| `export` | CSV export with canonicalized columns and taxonomy classifications |

### Classification

| Service | Responsibility |
|---------|---------------|
| `pipeline` | Coordinates research → approval → classification. Default entry for `classification:start`. Emits unified progress events across all phases |
| `classification` | Per supplier: apply override rules → AI classify remaining unclassified rows. Uses supplier research from supplier_universe.db when available. User can pause/resume. Resumable (skips already-classified suppliers). Emits progress per supplier |
| `rules` | Override rules CRUD, condition-to-SQL conversion, rule evaluation, priority management |

### Supplier

| Service | Responsibility |
|---------|---------------|
| `suppliers` | Derive project suppliers from transactions (`DISTINCT supplier_name`), join with supplier_universe.db for enriched data, update supplier_universe.db fields |
| `supplier-research` | Independent step (step 6). Research all project suppliers: get normalised info, context, category A rules → store in supplier_universe.db. Streams results as each supplier completes |
| `colabip` | Read ColabIP filesystem: available taxonomies, supplier universe CSV |

### Audit

| Service | Responsibility |
|---------|---------------|
| `changelog` | Append-only audit log: record changes, revert by applying old values + appending new log entry |

### Infrastructure

| Service | Responsibility |
|---------|---------------|
| `llm-client` | LLM API calls (provider-agnostic) |

---

## Agents

Each agent owns: system prompt, user prompt construction, response parsing + validation.

| Agent | Used In | Purpose |
|-------|---------|---------|
| `column-mapping-agent` | Step 3.1 | Suggest CSV→canonical column mappings from headers + sample data |
| `research-agent` | Step 6 | Research supplier: extract supplier info |
| `classification-agent` | Step 7.2 | Classify transaction batch into taxonomy node |

---

## IPC Channels

All handlers return `IPCResponse<T>: { success: boolean; data?: T; error?: string }`.
Events (main→renderer) are fire-and-forget, no response envelope.

### Project

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `project:new` | invoke | Create new .c91 file |
| `project:open` | invoke | Open existing .c91 file |
| `project:close` | invoke | Close current project |
| `project:getMetadata` | invoke | Read project metadata |
| `project:updateMetadata` | invoke | Update company context, settings |

### Upload

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `upload:selectFile` | invoke | File picker for CSV |
| `upload:parsePreview` | invoke | Parse CSV + LLM mapping suggestion |
| `upload:csv` | invoke | Import CSV with confirmed mappings |

### Classification

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `classification:start` | invoke | Start pipeline (research → approval → classify) |
| `classification:approve` | invoke | Approve supplier research, continue to classification |
| `classification:cancel` | invoke | Cancel running pipeline |
| `classification:progress` | event | Progress updates (main→renderer) |

### Transactions

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `transactions:query` | invoke | Filter/paginate/sort transactions |
| `transactions:stats` | invoke | Aggregate stats (time period, top suppliers) |
| `transactions:getColumns` | invoke | Discover dynamic columns |
| `transactions:update` | invoke | update_Transaction: update rows + log to change_log |

### Taxonomy

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `taxonomy:getNodes` | invoke | All taxonomy nodes |
| `taxonomy:addNode` | invoke | Add taxonomy node |
| `taxonomy:updateNode` | invoke | Edit taxonomy node |
| `taxonomy:deleteNode` | invoke | Delete taxonomy node |
| `taxonomy:importFromColabip` | invoke | Import from ColabIP |

### Suppliers

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `suppliers:list` | invoke | List project suppliers |
| `suppliers:update` | invoke | Update supplier fields in supplier_universe.db |
| `suppliers:research` | invoke | Trigger supplier research |

### Rules

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `rules:list` | invoke | List all rules, grouped by type |
| `rules:create` | invoke | Create rule |
| `rules:update` | invoke | Update rule (including priority reorder) |
| `rules:delete` | invoke | Delete rule |

### Audit

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `changelog:list` | invoke | List change log entries |
| `changelog:revert` | invoke | Revert a change |

### Export

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `export:csv` | invoke | Download dataset as CSV |

### ColabIP

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `colabip:listTaxonomies` | invoke | Available taxonomies for step 2.2 |

---

## Pages

Pages map to project flow steps.

| Page | Flow Step | Purpose |
|------|-----------|---------|
| Project Landing | 1 | New / Open project |
| Project Details | 2 | Company context, choose taxonomy, settings |
| Upload | 3 | CSV upload, column mapping (LLM suggest → human confirm) |
| Data Review | 4 | Time period check, top suppliers, spend shape |
| Override Rules | 5 | Rules grouped by type, priority reorder, CRUD |
| Supplier Review | 6 | Review/edit supplier research results |
| Classification | 7 | Start pipeline, progress display |
| Review | 8 | Review results, mark correct, reclassify |
| Taxonomy | 9 | Add/edit/delete nodes. Pivot table mode (view) + review mode (edit) |
| Version History | 10 | Change log, revert |
| Export | 11 | CSV download |

---

## Key Conventions

### IPC Response Envelope

All invoke handlers return `{ success: boolean; data?: T; error?: string }`.
Events (main→renderer) are unwrapped.

### Taxonomy Paths

Pipe-delimited, 3 levels: `"Corporate Services|IT|Software"`.

### Column Mapping

Stored as JSON in project table. LLM suggests, human confirms. Canonical columns are snake_case.

### Classification Status

`unclassified` → `classified_by_rule` or `classified_by_ai` → `human_reviewed`

### Change Log

Append-only. Reverts create new entries with swapped old/new values.

### Rule Priority

Unique positive integers. First matching rule wins (lowest number = highest priority). User reorders via drag.

### Rule Type

Derived from which columns the rule conditions reference:
- **supplier** — conditions only on `supplier_name`
- **gl** — conditions only on GL columns
- **mixed** — conditions spanning multiple column types
