# Database Schema

> This document is the authoritative source for the database schema. All tables are stored in a per-project `.c91` file (DuckDB database). See [features.md](./features.md) for product-level decisions.

---

## Overview

Each project is a self-contained `.c91` file. Projects are fully portable — they can be shared, moved between machines, or backed up as a single file.

**Project storage:** `./projects/` folder by default (gitignored). Users can also open projects from any location.

**Project discovery:** Recent projects tracked in `~/.config/Colab91 Classifier/recent-projects.json`

**10 tables:** `settings`, `company_context`, `column_mappings`, `invoice_grouping_columns`, `taxonomy`, `transactions`, `project_suppliers`, `override_rules`, `change_log`, `system_feedback`

---

### `settings`

Key-value configuration storage.

```sql
CREATE TABLE settings (
  key VARCHAR PRIMARY KEY,
  value VARCHAR,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Standard keys:**

| Key | Default | Description |
|-----|---------|-------------|
| `tail_spend_threshold` | `10000` | Minimum supplier spend to avoid tail spend treatment |
| `created_at` | CURRENT_TIMESTAMP | Project creation time |
| `taxonomy_name` | — | Name of imported taxonomy (e.g., "General", "Healthcare") |

---

### `company_context`

Company information. Single row per project.

```sql
CREATE TABLE company_context (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name VARCHAR,
  industry VARCHAR,
  sector VARCHAR,
  description TEXT,
  business_focus TEXT,
  procurement_nuances TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Used as context for LLM classification.

---

### `column_mappings`

Maps CSV columns to canonical field names.

```sql
CREATE TABLE column_mappings (
  canonical_name VARCHAR PRIMARY KEY,
  csv_column_name VARCHAR
);
```

Canonical column names are defined in `src/types/index.ts` (`CANONICAL_COLUMNS`). Examples: `supplier_name`, `spend_amount`, `gl_description`, `line_description`, `department`, etc.

---

### `invoice_grouping_columns`

Columns used to group transactions for invoice-level classification.

```sql
CREATE TABLE invoice_grouping_columns (
  canonical_name VARCHAR PRIMARY KEY,
  position INTEGER NOT NULL
);
```

Position determines grouping order. If empty, each transaction is classified individually.

---

### `taxonomy`

Classification hierarchy. 3-level structure: L1 → L2 → L3. Every level is stored as its own row (not just leaf nodes).

```sql
CREATE TABLE taxonomy (
  id VARCHAR PRIMARY KEY,
  full_path VARCHAR NOT NULL UNIQUE,
  l1 VARCHAR NOT NULL,
  l2 VARCHAR,
  l3 VARCHAR,
  depth INTEGER NOT NULL,
  description TEXT,
  parent_path VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Constraints:**
- `depth` is 1, 2, or 3.
- Every level is a row: L1 nodes, L1|L2 nodes, and L1|L2|L3 nodes are all stored.
- `full_path` is pipe-delimited: `"Direct|IT|Software"`
- L1 constrained to: **Direct**, **Indirect**, **Exempt** (see [features.md §3](./features.md))
- `description` is authoritative for LLM classification — the LLM should follow it. Intermediate nodes can have descriptions.
- `parent_path` is the `full_path` of the parent node (null for L1 nodes).
- Other tables reference taxonomy nodes by `id` (not by path string) for rename stability.

**Taxonomy metadata** (name) stored in `settings` table (`taxonomy_name` key).

Each project contains its own complete copy of the taxonomy, imported from ColabIP during project setup.

---

### `transactions`

Transaction data with classification results. **Dynamic schema** — canonical columns are added based on `column_mappings`, not hardcoded.

**Fixed columns (always present):**

```sql
-- Core
id VARCHAR PRIMARY KEY
row_index INTEGER
invoice_group_key VARCHAR

-- Classification output
taxonomy_node_id VARCHAR        -- FK to taxonomy.id
review_score INTEGER
classification_reasoning TEXT

-- Metadata
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

**Dynamic canonical columns:** Added via `ALTER TABLE` after the user saves column mappings. These correspond to the mapped entries in `column_mappings`. For example, if the user maps `"Vendor Name"` → `supplier_name`, a `supplier_name VARCHAR` column is added.

**Field details:**

| Column | Description |
|--------|-------------|
| `row_index` | Position in the original CSV (0-indexed) |
| `invoice_group_key` | Computed grouping key for invoice-level classification |
| `taxonomy_node_id` | References `taxonomy.id`. JOIN to taxonomy to get `full_path` and individual levels. Null = unclassified. |
| `review_score` | 0–100 integer. Higher = more urgent for human review. 0 = deterministic (override rule). See [features.md §5](./features.md). |
| `classification_reasoning` | LLM explanation or rule name |

**Indexes:**

```sql
CREATE INDEX idx_transactions_supplier ON transactions(supplier_name);
CREATE INDEX idx_transactions_taxonomy ON transactions(taxonomy_node_id);
```

---

### `project_suppliers`

Supplier information. Category A suppliers have a predetermined classification that is synced into `override_rules` at classification time. See [features.md §5](./features.md).

```sql
CREATE TABLE project_suppliers (
  id VARCHAR PRIMARY KEY,
  supplier_name VARCHAR NOT NULL UNIQUE,
  parent_supplier_id VARCHAR,
  supplier_type VARCHAR,
  supplier_info JSON,
  category_a BOOLEAN DEFAULT FALSE,
  category_a_taxonomy_node_id VARCHAR,
  transaction_count INTEGER DEFAULT 0,
  total_spend DECIMAL(15,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Field details:**

| Column | Description |
|--------|-------------|
| `supplier_name` | Normalized supplier name. Used for matching and display. |
| `parent_supplier_id` | Self-referencing FK to `project_suppliers.id`. Links subsidiary to parent company for spend aggregation. |
| `supplier_type` | `company`, `individual`, `government`, or null. Passed to LLM as signal (see [features.md §4](./features.md)). |
| `supplier_info` | JSON: research results (website, industry, services, NAICS, research_confidence, etc.) |
| `category_a` | Whether this supplier has a predetermined classification |
| `category_a_taxonomy_node_id` | FK to `taxonomy.id`. The predetermined classification for Category A suppliers. |
| `transaction_count` | Number of transactions for this supplier |
| `total_spend` | Aggregated spend |

---

### `override_rules`

Deterministic classification rules. At classification time, `supplier` and `taxonomy` rules are synced into this table from `project_suppliers` (Category A) and ColabIP respectively. `project` rules are created directly by users and persist in this table.

```sql
CREATE TABLE override_rules (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  conditions JSON NOT NULL,
  target_taxonomy_node_id VARCHAR NOT NULL,
  priority_score INTEGER DEFAULT 100,
  is_active BOOLEAN DEFAULT TRUE,
  imported_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Field details:**

| Column | Description |
|--------|-------------|
| `source` | Where the rule originated: `project`, `taxonomy`, `supplier`. Determines auto-assigned priority_score band. |
| `conditions` | JSON array of `{field, operator, value}` — all must match (AND logic) |
| `target_taxonomy_node_id` | References `taxonomy.id` for the target classification. |
| `priority_score` | Evaluation order. Lower = evaluated first. Auto-assigned based on source (project: 100-199, taxonomy: 200-299, supplier: 300-399), user-adjustable. |
| `is_active` | Toggle without deleting |
| `imported_at` | When synced from ColabIP or project_suppliers. Null for project-created rules. |

**Evaluation order:** Sorted by priority_score ascending. First match wins. See [features.md §5](./features.md).

**Condition operators:** equals, contains, regex, greater_than, less_than, in.

---

### `change_log`

Audit trail for all changes to classifications, taxonomy, rules, and suppliers.

```sql
CREATE TABLE change_log (
  id VARCHAR PRIMARY KEY,
  source VARCHAR NOT NULL,
  affected_table VARCHAR NOT NULL,
  affected_ids JSON NOT NULL,
  affected_count INTEGER NOT NULL,
  old_values JSON,
  new_values JSON,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**source values:** `manual`, `pipeline`

Classification runs log a single summary entry per run (source=`pipeline`).

Revert creates a new entry (never deletes history).

---

### `system_feedback`

AI-generated improvement suggestions from the FeedbackAgent.

```sql
CREATE TABLE system_feedback (
  id VARCHAR PRIMARY KEY,
  feedback_type VARCHAR NOT NULL,
  affected_transaction_ids JSON,
  suggestion JSON NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**feedback_type values:** `company_context`, `taxonomy_description`, `supplier_rule`, `uncategorized_feedback`

**status values:** `pending`, `approved`, `rejected`, `modified`

`suggestion` JSON contains the proposed correction (e.g., new taxonomy description, new override rule, updated company context).

See [features.md §7](./features.md) for feedback workflow.

---

## ColabIP (Shared Repository)

ColabIP is a Git repository that stores master data shared across projects. All ColabIP data is **copied** into each project's `.c91` file during import — projects don't reference ColabIP at runtime. Synced via `src/services/git-sync.ts`.

```
colabip/
├── taxonomies/
│   ├── healthcare/
│   │   ├── taxonomy.txt
│   │   └── rules.csv
│   └── {industry_name}/
│       ├── taxonomy.txt
│       └── rules.csv
└── suppliers/
    └── supplier_universe.csv
```

### Taxonomies

**Path:** `colabip/taxonomies/{industry_name}/taxonomy.txt`

Single flat file per taxonomy. Each industry is a separate folder. Only depth-3 leaf nodes are stored in the file; L1 and L2 parent nodes are auto-generated during import.

**File format (alternating lines):**
- **Path line:** Pipe-delimited depth-3 path (e.g., `Clinical|Clinical Equipment|Diagnostic Imaging Equipment`)
- **Description line:** Tab-indented description text (e.g., `\tDiagnostic imaging equipment suppliers including...`)

```
Clinical|Clinical Equipment|Diagnostic Imaging Equipment
	Diagnostic imaging equipment suppliers including X-ray machines, ultrasound...
Clinical|Clinical Services|Clinical Staffing
	Staffing agencies for temporary clinical labor...
```

### Taxonomy Rules

**Path:** `colabip/taxonomies/{industry_name}/rules.csv`

Each taxonomy has its own rules file, stored alongside the taxonomy file. Synced into the project's `override_rules` table at classification time with `source='taxonomy'`.

CSV with the following columns:

| Column | Description |
|--------|-------------|
| `name` | Rule name |
| `conditions` | JSON array of `{field, operator, value}` (quoted in CSV) |
| `target_taxonomy_path` | Full pipe-delimited taxonomy path |
| `priority_score` | Evaluation order. Auto-assigned in the taxonomy band (200-299). |

### Supplier Universe

**Path:** `colabip/suppliers/supplier_universe.csv`

Single CSV containing all known suppliers globally. Used as the first lookup in the supplier research fallback chain (see [features.md §4](./features.md)).

| Column | Description |
|--------|-------------|
| `supplier_name` | Supplier name |
| `parent_company` | Parent company name |
| `supplier_type` | `company`, `individual`, or `government` |
| `website` | Supplier website |
| `industry` | Industry classification |
