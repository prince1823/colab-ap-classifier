## Summary

Implement the Export service — CSV export of classified transactions with all corrections applied.

## Scope

### Service (`src/main/services/export.ts`)

**Operations:**
- `selectExportPath(): Promise<string | null>` — Electron dialog.showSaveDialog for .csv files
- `exportCSV(filePath: string): Promise<{ rowsExported: number }>`:
  1. Query all transactions (no filters, all rows)
  2. JOIN with taxonomy to get classification_path (full_path)
  3. Include all canonical columns + classification columns
  4. Export columns:
     - All canonical columns (supplier_name, spend_amount, gl_description, etc.)
     - `classification_path` (L1|L2|L3)
     - `classification_l1`, `classification_l2`, `classification_l3` (split for convenience)
     - `review_score`
     - `classification_reasoning`
  5. Write to CSV at filePath
  6. Return row count

### IPC Handlers (`src/main/ipc/export.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `export:selectPath` | none | `string \| null` |
| `export:export` | `filePath: string` | `{ rowsExported: number }` |

### Tests
- Export with classified transactions → valid CSV with correct columns
- Export with unclassified transactions → empty classification columns
- Export path dialog → returns path or null
- Large dataset → export completes without memory issues

### Acceptance Criteria
- [ ] Both IPC handlers work
- [ ] CSV includes all canonical + classification columns
- [ ] Classification path split into L1/L2/L3 separate columns
- [ ] Handles unclassified rows gracefully
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-18** (Transactions Service) — transaction data
- **S1-12** (Taxonomy Service) — taxonomy paths

## Spec References
- `internal_docs/ipc_contract.md` — Export section (channels 44-45)
- `internal_docs/features.md` — Export & Sync section
