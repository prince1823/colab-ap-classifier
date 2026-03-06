# Frontend Improvements

Planned improvements for the UI that aren't yet implemented.

---

## Data View — Reuse previous column mappings

**Current behavior:** When a user selects a CSV file in Step 1 (Upload), the LLM is called immediately to suggest column mappings. There's no way to reuse mappings from a previous upload.

**Desired behavior:** After the CSV is parsed and previewed, show a "Map Columns" dropdown with two options:
1. **Use previous mapping from: `<filename>`** — reuse column mappings from a compatible past upload (one whose mapped CSV columns overlap with the new file's columns)
2. **Suggest new mappings (LLM)** — call the LLM to analyze columns (current behavior)

**What's needed:**
- A new IPC channel (`ingest:getUploadHistory`) to expose the existing `IngestService.getUploadHistory()` method. The method already exists in the backend but isn't exposed via IPC.
- Update `DataUploadStep` to: (a) defer the LLM `suggestMappings` call until the user explicitly chooses it, (b) fetch upload history on mount, (c) filter for compatible past uploads, and (d) show the dropdown.
- The `IngestService.getStoredMappings(columns)` method could also be used — it finds the first past upload whose mapped columns are a subset of the new CSV's columns.

**Backend readiness:** The `getUploadHistory()` and `getStoredMappings(columns)` methods exist in `src/main/services/ingest.ts`. The `uploads` table stores column mappings as enriched JSON (with priorities). Only IPC exposure and frontend UI are missing.
