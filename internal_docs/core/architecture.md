# Architecture

Technical architecture for the AP Classifier, organized by the project flow. Each section maps flow steps to tables, services, IPC channels, agents, and pages.

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
    └── ColabIP (fs read)  → shared taxonomies, rules, supplier universe
```

---

## Database Schema

Each project is a single `.c91` DuckDB file. Tables below.

### project (key-value)

Stores all project-level metadata as key-value pairs. Replaces the current split between `settings` and `company_context` tables.

| Key | Value | Set At |
|-----|-------|--------|
| `project_name` | string | creation |
| `created_at` | timestamp | creation |
| `company_name` | string | step 2 |
| `industry` | string | step 2 |
| `sector` | string | step 2 |
| `description` | text | step 2 |
| `business_focus` | text | step 2 |
| `procurement_nuances` | text | step 2 |
| `taxonomy_name` | string | step 2 |
| `tail_spend_threshold` | number | step 2 |
| `column_mapping_json` | JSON | step 3 |
| `invoice_grouping_columns` | JSON array | step 3 |

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
| `invoice_group_key` | VARCHAR | Derived from grouping columns |
| `taxonomy_node_id` | VARCHAR | FK → taxonomy.id |
| `classification_status` | VARCHAR | `unclassified`, `classified_by_rule`, `classified_by_ai`, `human_reviewed` |
| `classification_reasoning` | TEXT | LLM reasoning or rule name |
| `review_score` | INTEGER | 0 = no review needed |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

**Canonical columns** (added dynamically based on column mapping):

`supplier_name`, `line_description`, `gl_description`, `spend_amount`, `gl_code`, `department`, `invoice_date`, `creation_date`, `company`, `cost_center`, `po_number`, `supplier_address`, `currency`, `memo`

### project_suppliers

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID (or supplier universe UID) |
| `supplier_name` | VARCHAR UNIQUE | Normalised name |
| `aliases` | JSON | Array of alternative names |
| `parent_supplier_id` | VARCHAR | FK → project_suppliers.id |
| `parent_name` | VARCHAR | Denormalized for display |
| `supplier_info` | JSON | Research results (type, industry, etc.) |
| `category_a` | BOOLEAN | Has deterministic taxonomy mapping |
| `category_a_taxonomy_node_id` | VARCHAR | FK → taxonomy.id |
| `transaction_count` | INTEGER | |
| `total_spend` | DECIMAL | |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

### override_rules

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `name` | VARCHAR | Human-readable name |
| `rule_type` | VARCHAR | `supplier`, `gl`, `mixed`, etc. — derived from which columns the conditions reference |
| `conditions` | JSON | Array of `{field, operator, value, connector}` |
| `target_taxonomy_node_id` | VARCHAR | FK → taxonomy.id |
| `priority_score` | INTEGER | Unique, positive. User-reorderable |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMP | |

### change_log

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `source` | VARCHAR | `manual`, `pipeline`, `rule`, `feedback` |
| `affected_table` | VARCHAR | |
| `affected_ids` | JSON | Array of affected row IDs |
| `affected_count` | INTEGER | |
| `old_values` | JSON | Pre-change values |
| `new_values` | JSON | Post-change values |
| `description` | TEXT | |
| `created_at` | TIMESTAMP | |

### system_feedback

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR PK | UUID |
| `feedback_type` | VARCHAR | `company_context`, `taxonomy_description`, `supplier_rule`, `uncategorized_feedback` |
| `affected_transaction_ids` | JSON | |
| `suggestion` | JSON | Action-specific payload |
| `status` | VARCHAR | `pending`, `approved`, `rejected` |
| `created_at` | TIMESTAMP | |

---

## Services

Services are the business logic layer. Each service owns one concern. Services call the database directly; IPC handlers call services.

### Core

| Service | Responsibility |
|---------|---------------|
| `database` | DuckDB connection management, query execution, schema init, migrations |
| `project` | Create/open/close project, read/write project metadata |
| `settings` | App-level settings (LLM provider, model, API keys). Persisted to filesystem, not project DB |
| `recent-projects` | Track recently-opened project files |
| `app-paths` | Resolve cross-platform directories |

### Data Pipeline

| Service | Responsibility |
|---------|---------------|
| `upload` | File selection dialog, CSV parsing (encoding/delimiter detection), preview with LLM mapping suggestion |
| `canonicalization` | Save confirmed column mappings, invoice grouping columns |
| `transactions` | Query/filter/paginate transactions, column discovery, stats |
| `export` | CSV export with classification paths |

### Classification

| Service | Responsibility |
|---------|---------------|
| `classification-pipeline` | Orchestrate full pipeline: identify rows → research → rules → AI classify. Emits progress events. Handles cancellation |
| `rules` | Override rules CRUD, condition-to-SQL conversion, rule evaluation against transactions, priority management |
| `reclassification` | Manual reclassification: update transactions, log to changelog, trigger feedback agent |

### Supplier

| Service | Responsibility |
|---------|---------------|
| `suppliers` | Project supplier CRUD (list, get, update, upsert) |
| `supplier-research` | Orchestrate supplier research: check universe → Exa search → LLM research → store results |
| `supplier-matcher` | Build in-memory index from supplier universe for O(1) name/alias matching |
| `exa-search` | Web search via Exa API for supplier information |
| `colabip` | Read ColabIP filesystem: taxonomies, rule packs, supplier universe CSV |

### Audit + Feedback

| Service | Responsibility |
|---------|---------------|
| `changelog` | Immutable audit log: record changes, revert by applying old values + appending new log entry |
| `feedback` | System feedback CRUD, approve (auto-execute action), reject |

### Infrastructure

| Service | Responsibility |
|---------|---------------|
| `llm-client` | LLM API calls (provider-agnostic, supports Anthropic/OpenAI/OpenRouter) |
| `rate-limiter` | Adaptive concurrency control for batch operations (halves on 429, recovers on success streaks) |
| `taxonomy-utils` | Taxonomy path resolution helpers |

---

## Agents

Each agent owns: system prompt, user prompt construction, response parsing + validation.

| Agent | Used In | Purpose |
|-------|---------|---------|
| `canonicalization-agent` | Step 3.1 | Suggest CSV→canonical column mappings from headers + sample data |
| `research-agent` | Step 6 | Research supplier: extract type, industry, products, NAICS codes, business model |
| `classification-agent` | Step 7.2 | Classify transaction group into taxonomy. Validates L1, depth, closest match |
| `feedback-agent` | Step 8.3 | Analyze reclassification, suggest systemic improvement (context/taxonomy/rule/uncategorized) |

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
| `project:isOpen` | invoke | Check if a project is open |
| `project:getMetadata` | invoke | Read project metadata |
| `project:updateMetadata` | invoke | Update company context, settings |
| `project:selectSavePath` | invoke | Save dialog for new project |
| `project:selectOpenPath` | invoke | Open dialog for existing project |

### Upload + Canonicalization

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `upload:selectFile` | invoke | File picker for CSV |
| `upload:parsePreview` | invoke | Parse CSV + LLM mapping suggestion |
| `upload:csv` | invoke | Import CSV with confirmed mappings |
| `canonicalization:save` | invoke | Save confirmed mappings |

### Classification

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `classification:start` | invoke | Start pipeline (returns runId) |
| `classification:getStatus` | invoke | Poll current run status |
| `classification:cancel` | invoke | Cancel running pipeline |
| `classification:progress` | event | Progress updates (main→renderer) |

### Data Access

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `transactions:query` | invoke | Filter/paginate/sort transactions |
| `transactions:stats` | invoke | Aggregate stats |
| `transactions:getColumns` | invoke | Discover dynamic columns |
| `transactions:reclassify` | invoke | Manual reclassification |

### Taxonomy

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `taxonomy:get` | invoke | Taxonomy metadata |
| `taxonomy:getNodes` | invoke | All taxonomy nodes |
| `taxonomy:set` | invoke | Replace entire taxonomy |
| `taxonomy:importFromColabip` | invoke | Import from ColabIP |

### Suppliers

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `suppliers:list` | invoke | List project suppliers |
| `suppliers:update` | invoke | Update supplier fields |
| `suppliers:research` | invoke | Trigger supplier research |

### Rules

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `rules:list` | invoke | List all rules |
| `rules:create` | invoke | Create rule |
| `rules:update` | invoke | Update rule |
| `rules:delete` | invoke | Delete rule |
| `rules:importFromColabip` | invoke | Import rule pack |

### Audit + Feedback

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `changelog:list` | invoke | List change log entries |
| `changelog:revert` | invoke | Revert a change |
| `feedback:list` | invoke | List feedback suggestions |
| `feedback:approve` | invoke | Approve + execute feedback |
| `feedback:reject` | invoke | Reject feedback |

### Export + Settings

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `export:selectPath` | invoke | Save dialog for CSV |
| `export:export` | invoke | Write CSV |
| `settings:get` | invoke | Current app settings |
| `settings:update` | invoke | Update provider/model/keys |
| `settings:getModels` | invoke | Available models for provider |
| `settings:getProviders` | invoke | Available LLM providers |

### ColabIP

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `colabip:listTaxonomies` | invoke | Available taxonomies |
| `colabip:listRulePacks` | invoke | Available rule packs |

### Recent Projects

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `recentProjects:list` | invoke | List recent projects |
| `recentProjects:clear` | invoke | Clear recent list |
| `recentProjects:remove` | invoke | Remove one entry |

---

## Pages

Pages map to project flow steps. Each page uses IPC hooks to call the backend.

| Page | Flow Step | Purpose |
|------|-----------|---------|
| (Project landing) | 1 | New / Open / Recent projects |
| `CompanyContextPage` | 2.1 | Company context text fields |
| `TaxonomyPage` | 2.2, 9 | Choose taxonomy + edit nodes |
| `UploadPage` | 3.1–3.2 | CSV upload, column mapping review |
| `DataReviewPage` | 4 | Time period + spend shape |
| `OverrideRulesPage` | 5 | Rules grouped by type, priority reorder, CRUD |
| `SuppliersPage` | 6 | Supplier review, edit fields |
| `ClassificationPage` | 7 | Start pipeline, progress display |
| `ReviewPage` | 8 | Review classified data, mark correct, reclassify |
| `PivotPage` | 9 | Pivot table view (view-only mode) |
| `VersionHistoryPage` | 10 | Change log, revert |
| `OutputPage` | 11 | CSV export |
| `FeedbackDashboardPage` | (auxiliary) | Review/approve/reject feedback suggestions |

---

## Key Conventions

### IPC Response Envelope

All invoke handlers return `{ success: boolean; data?: T; error?: string }`.
Events (main→renderer) are unwrapped.

### Taxonomy Paths

Pipe-delimited, 3 levels: `"Corporate Services|IT|Software"`. Always depth 3 for classification output.

### Column Mapping

Stored as JSON: `{ canonical_name: csv_column_name }`. LLM suggests, human confirms. Canonical columns are snake_case.

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
