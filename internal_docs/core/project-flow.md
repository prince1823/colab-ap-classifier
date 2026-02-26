# Project Flow

The end-to-end workflow for classifying accounts payable transactions. Each step is a discrete phase with defined inputs, outputs, and user interactions.

---

## 1. New Project

Create a new `.c91` project file (DuckDB). Initializes schema and default settings.

## 2. Project Details

### 2.1 Company Context

Blank text fields the user fills in to describe the purchasing company. Saved to the project database.

Fields: company name, industry, sector, description, business focus, procurement nuances.

### 2.2 Choose Taxonomy

Select from available ColabIP taxonomies. Creates the `taxonomy` table with the chosen 3-level hierarchy (L1 | L2 | L3).

### 2.3 Settings

Configure project-level settings (e.g., tail spend threshold). Saved to the project database.

## 3. Upload CSV

### 3.1 Column Mapping — LLM Suggestion

LLM analyzes CSV headers + sample rows and outputs a column mapping JSON (`{canonical_name: csv_column_name}`).

The mapping is stored as JSON because the structural interpretation of columns may evolve (e.g., invoice grouping inferred from multiple columns, address composed from parts, etc.).

`supplier_address` is included in the canonical column list.

### 3.2 Column Mapping — Human Confirmation

User reviews, edits, and confirms the LLM-suggested mappings. User also selects which columns define invoice grouping.

Confirmed mappings and invoice grouping columns are saved to the project database.

### 3.3 Import Transactions

Transactions table is created with mapped canonical columns plus default system columns (`classification_status`, `classification_reasoning`, `taxonomy_node_id`, etc.). Unmapped CSV columns are dropped.

Distinct supplier names are extracted and inserted into `project_suppliers`.

## 4. Review Shape of Data

Quick sanity check before classification proceeds. Typical checks:

### 4.1 Time Period

Show the number of transactions over the time period to verify correct date range and that data is uniformly distributed (or distributed as expected).

### 4.2 General Shape of Spend

Show top suppliers by spend. Normalization is not required at this stage — raw supplier names are fine.

## 5. Load + Review Override Rules

### 5.1 Load Rules

Load rules and group them by **rule type** (which column the rule applies to): supplier rule, GL rule, mixed rule, etc.

### 5.2 Rule Table

Each rule has:
- **Rule name**
- **Priority number** (unique, positive integer)
- **Filter condition** (based on any column, AND/OR logic)
- **Target taxonomy node** (L1|L2|L3)

### 5.3 Priority Reordering

In a rule prioritization view, move rows up/down to set priority. Priority scores update accordingly.

### 5.4 Add / Edit / Delete Rules

Users can create, modify, or remove rules within the project. Rule fields:
- Priority score — automatically set, user-adjustable
- Conditions — based on any column name, supports AND/OR filtering
- Target taxonomy node

## 6. Supplier Research

### 6.1 Send Suppliers to Supplier Service

Read list of suppliers and related columns (e.g., address) from the project. Send to supplier research service.

### 6.2 Supplier Service Returns

Per supplier:
- **UID** of supplier
- **Normalised supplier list:**
  - Normalised name
  - Parent (if exists)
  - Supplier context:
    - Supplier info (type, industry, products/services, etc.)
- **Supplier universe rules** (Category A rules — deterministic supplier-to-taxonomy mappings)

### 6.3 Supplier Review Page

As suppliers are returned, user reviews/edits on a supplier review page.
- Shows supplier table (`supplier_universe.db`) — default filter for project suppliers
- User can manually edit any fields (e.g., parent company, supplier info)

## 7. Classification

### 7.1 Override Rules Engine

For each confirmed supplier, send all transactions to the override rules engine.
- Compare transaction data against rule conditions, match to the highest-priority matching rule.
  - If rule matches: set `classification_status = "classified_by_rule"`, set taxonomy node
  - If no rule matches: `classification_status` remains `"unclassified"`

### 7.2 AI Classification

Send remaining unclassified rows (per supplier batch) to the AI classification engine.
- Construct LLM payload with: supplier info, transaction data, taxonomy, company context
- Use prompt caching and context engineering for efficiency
- On result: set `taxonomy_node_id`, set `classification_status = "classified_by_ai"`

## 8. Review Returned Data

### 8.1 Batch Review

For every batch sent to classification, show results in a review pane. Allow viewing multiple batches together.

### 8.2 User Actions

User selects one or more rows and either:
1. **Mark correct** — set `classification_status = "human_reviewed"`
2. **Reclassify** — select rows via filters, assign a new taxonomy node. Backend handles filtering via SQL queries.

### 8.3 update_transaction()

1. Update the `transactions` table
2. Every change is recorded in `change_log`

## 9. Taxonomy Editing

Manually add/edit/delete taxonomy nodes.

- On delete: transactions classified under the deleted node are surfaced for manual reclassification.
- In **pivot table mode**: viewing only.
- In **review mode**: editing allowed.

## 10. View / Revert Changes

View the change log. If a change is reverted, append a new `change_log` row (never delete existing entries).

## 11. Download

Export dataset as CSV with all canonicalized columns and taxonomy classifications.
