## Summary

Implement CSV file selection, parsing, and preview generation. This handles the first part of data import — getting the file into memory and showing the user what's in it.

## Scope

### Service (`src/main/services/upload.ts`)

**Operations:**
- `selectFile(): Promise<string | null>` — Electron dialog.showOpenDialog for .csv files
- `parsePreview(filePath: string): Promise<CSVPreview>` — parse CSV file, return:
  ```typescript
  interface CSVPreview {
    columns: string[];          // header names
    sampleRows: Record<string, string>[]; // first 10 rows
    totalRows: number;          // total row count
  }
  ```
- Handle various CSV formats (comma, semicolon, tab delimited)
- Handle quoted fields, newlines within quotes
- Detect encoding (UTF-8, Latin-1)

### IPC Handlers (`src/main/ipc/upload.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `upload:selectFile` | none | `string \| null` |
| `upload:parsePreview` | `filePath: string` | `CSVPreview` |

Note: `upload:csv` (full import) is implemented in S1-10 after canonicalization is ready.

### Tests
- Parse standard CSV → correct columns and sample rows
- Parse CSV with special characters, quotes, newlines in fields
- Large file → totalRows count accurate, only 10 sample rows returned
- Empty file → appropriate error
- Missing file → appropriate error

### Acceptance Criteria
- [ ] File dialog filters for .csv files
- [ ] Preview returns correct columns, 10 sample rows, total row count
- [ ] Handles various delimiters and encodings
- [ ] Unit tests pass with test CSV fixtures

## Dependencies
- **S1-03** (IPC Infrastructure) — handler registration
- **S1-05** (Project Service) — project must be open to upload

## Spec References
- `internal_docs/ipc_contract.md` — Upload section (channels 12-13)
- `internal_docs/features.md` — CSV upload with preview

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/services/upload.ts`
- `src/main/ipc/upload.ts`
- `tests/unit/services/upload.test.ts`

**No deviations.** File dialog filters for .csv, preview returns correct columns/sample rows/total count, various delimiters handled.
