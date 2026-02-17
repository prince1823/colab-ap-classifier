## Summary

Implement the DuckDB database service that manages per-project `.c91` file connections and initializes all 10 tables from the schema spec.

## Scope

### Database Service (`src/main/services/database.ts`)

**Connection Management:**
- `openDatabase(filePath: string): Promise<Database>` — open or create a .c91 DuckDB file
- `closeDatabase(): Promise<void>` — close current connection
- `getDatabase(): Database` — get current connection (throw if none open)
- `isOpen(): boolean` — check if a database is currently open
- Singleton pattern — only one project open at a time

**Schema Initialization (`initializeSchema`):**
Create all 10 tables if they don't exist:

1. `settings` — key/value config (key VARCHAR PK, value VARCHAR, updated_at TIMESTAMP)
2. `company_context` — single-row company info (id=1 CHECK)
3. `column_mappings` — canonical_name → csv_column_name
4. `invoice_grouping_columns` — canonical_name + position
5. `taxonomy` — 3-level hierarchy (id, full_path, l1, l2, l3, depth, description, parent_path)
6. `transactions` — fixed columns + dynamic canonical columns added later
7. `project_suppliers` — supplier info, category A, spend aggregates
8. `override_rules` — conditions JSON, priority scoring
9. `change_log` — audit trail
10. `system_feedback` — AI-generated suggestions

**Seed Data:**
- Insert default settings: `tail_spend_threshold=10000`, `created_at=CURRENT_TIMESTAMP`
- Insert empty company_context row (id=1)

**Query Helpers:**
- `run(sql, params?)` — execute statement
- `all(sql, params?)` — query returning rows
- `get(sql, params?)` — query returning single row

### Tests (`tests/unit/services/database.test.ts`)
- Schema creation: open a temp .c91 file, verify all 10 tables exist
- Default settings: verify seed data
- Connection lifecycle: open, close, reopen
- Error handling: operations on closed database throw

### Acceptance Criteria
- [ ] All 10 tables created with exact column definitions from schema.md
- [ ] Default settings seeded on creation
- [ ] Connection lifecycle works (open → query → close → reopen)
- [ ] Indexes created (supplier_name, taxonomy_node_id on transactions)
- [ ] Unit tests pass
- [ ] Uses duckdb-async or equivalent async bindings

## Dependencies
- **S1-01** (Project Scaffolding) — project structure, duckdb dependency

## Spec References
- `internal_docs/schema.md` — all 10 table definitions with SQL
