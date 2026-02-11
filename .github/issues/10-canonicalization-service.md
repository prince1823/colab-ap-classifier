## Summary

Implement the canonicalization service (suggest & save mappings) and the full CSV import pipeline that applies mappings, inserts transactions, and extracts suppliers.

## Scope

### Canonicalization Service (`src/main/services/canonicalization.ts`)

**Operations:**
- `suggestMappings(columns, sampleData)` — delegate to CanonicalizationAgent
- `saveMappings(mapping, groupingColumns)` — persist to column_mappings + invoice_grouping_columns tables
- Validate that mappings don't conflict with existing saved mappings (once saved, locked for project)

### Full CSV Import (`src/main/services/upload.ts` — extend)

**`importCSV(filePath: string): Promise<{ rowsInserted: number }>`**

1. Read the full CSV file
2. Get saved column_mappings from database
3. For each row:
   - Map CSV columns to canonical names using saved mappings
   - Generate UUID for row `id`
   - Set `row_index` as sequential number
   - Store original row as `raw_data` JSON (NOTE: raw_data column should be added to transactions table)
4. ALTER TABLE transactions to add any canonical columns that don't exist yet
5. Bulk INSERT rows into transactions table
6. Extract distinct supplier_name values → INSERT INTO project_suppliers (deduplicate against existing)
7. Update transaction_count and total_spend on project_suppliers

### IPC Handlers

| Channel | Args | Response |
|---------|------|----------|
| `canonicalization:suggest` | `columns: string[], sampleData: Record<string, string>[]` | `CanonicalizationResult` |
| `canonicalization:save` | `mapping: Record<string, string>, groupingColumns: string[]` | `void` |
| `upload:csv` | `filePath: string` | `{ rowsInserted: number }` |

### Constraints
- Once column mappings are saved for a project, all future uploads must use the same mapping
- Only mapped canonical columns are stored as typed columns; unmapped CSV data goes into `raw_data` JSON
- Supplier extraction must deduplicate — don't create duplicate project_suppliers rows

### Tests
- Save mapping → verify in DB
- Import CSV → verify transactions created with correct canonical columns
- Import CSV → verify suppliers extracted
- Second import → verify no duplicate suppliers
- Import with existing mappings → verify same mappings used

### Acceptance Criteria
- [ ] Canonicalization suggest delegates to agent correctly
- [ ] Save persists mappings and grouping columns
- [ ] Full CSV import creates transactions with dynamic columns
- [ ] Suppliers extracted and deduplicated
- [ ] Existing mapping enforcement works
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries, ALTER TABLE
- **S1-08** (Upload Service) — CSV parsing
- **S1-09** (Canonicalization Agent) — LLM mapping suggestions

## Spec References
- `internal_docs/ipc_contract.md` — Canonicalization section (channels 15-16), Upload channel 14
- `internal_docs/schema.md` — column_mappings, invoice_grouping_columns, transactions, project_suppliers
- `internal_docs/features.md` — Data Import section

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/services/canonicalization.ts`
- `src/main/ipc/canonicalization.ts`
- `tests/unit/services/canonicalization.test.ts`

**No deviations.** Suggest delegates to agent, save persists mappings and grouping columns, full CSV import creates transactions with dynamic columns, suppliers extracted and deduplicated.
