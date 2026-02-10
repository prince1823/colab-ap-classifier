## Summary

Implement the Project service and its 8 IPC handlers for creating, opening, closing projects and managing project metadata.

## Scope

### Service (`src/main/services/project.ts`)

**Core Operations:**
- `createProject(name: string): Promise<{ filePath: string; name: string }>` — create `.c91` file in `./projects/{name}.c91`, initialize schema, seed defaults
- `openProject(filePath: string): Promise<{ filePath: string; name: string }>` — open existing .c91 file, validate it has expected schema
- `closeProject(): Promise<void>` — close DB connection, clear in-memory state
- `isProjectOpen(): boolean`

**Metadata:**
- `getMetadata(): Promise<ProjectMetadata>` — read from settings + company_context + column_mappings + invoice_grouping_columns
- `updateMetadata(updates: ProjectMetadataUpdate): Promise<void>` — update company_context and/or tail_spend_threshold

**File Dialogs:**
- `selectSavePath(): Promise<string | null>` — Electron dialog.showSaveDialog for .c91 files
- `selectOpenPath(): Promise<string | null>` — Electron dialog.showOpenDialog for .c91 files

### IPC Handlers (`src/main/ipc/project.ts`)

Register 8 handlers:
| Channel | Args | Response |
|---------|------|----------|
| `project:isOpen` | none | `boolean` |
| `project:selectSavePath` | none | `string \| null` |
| `project:selectOpenPath` | none | `string \| null` |
| `project:new` | `projectName: string` | `{ filePath, name }` |
| `project:open` | `filePath: string` | `{ filePath, name }` |
| `project:close` | none | `void` |
| `project:getMetadata` | none | `ProjectMetadata` |
| `project:updateMetadata` | `updates: ProjectMetadataUpdate` | `void` |

### Side Effects
- On `project:new` and `project:open`: update recent projects list
- On `project:new`: create `./projects/` directory if it doesn't exist

### Tests
- Create project → verify .c91 file exists, schema initialized
- Open project → verify metadata readable
- Close project → verify operations throw after close
- Get/update metadata roundtrip
- File dialog mocking for selectSavePath/selectOpenPath

### Acceptance Criteria
- [ ] All 8 IPC handlers registered and functional
- [ ] Project creation writes .c91 file with full schema
- [ ] Metadata get/update works correctly
- [ ] Projects directory auto-created
- [ ] Unit tests pass

## Dependencies
- **S1-03** (IPC Infrastructure) — handler registration framework
- **S1-04** (DuckDB Service) — database connection & schema init

## Spec References
- `internal_docs/ipc_contract.md` — Project section (channels 1-8)
- `internal_docs/schema.md` — settings, company_context tables
