### upload → ingest

`upload:*` IPC channels renamed to `ingest:*`. `ipc.upload` namespace replaced with `ipc.ingest` in renderer IPC client.

- `ipc.upload.selectFile()` → `ipc.ingest.selectFile()`
- `ipc.upload.parsePreview(path)` split into `ipc.ingest.parseCSV(path)` + `ipc.ingest.suggestMappings(columns, sampleRows)` (two sequential calls — show CSV preview immediately, then LLM suggestions)
- `ipc.upload.csv(path, mapping)` → `ipc.ingest.importCSV(path, mapping)` (now returns `{ rowsInserted, uploadId }`)
- new: `ipc.ingest.getUpload()` — reads latest upload record from uploads table

**renderer/pages/UploadPage.tsx** — update all `ipc.upload.*` → `ipc.ingest.*`; split `parsePreview` into two sequential calls
**renderer/stores/workflowStore.ts** — `hasUploadedData` derivation broken (uses removed `metadata?.columnMapping`); replace with `ipc.ingest.getUpload()` check; update `UploadDraft.preview` type to accept `CSVPreview` with optional `mappingSuggestion`

### taxonomy

### project settings (KV migration)

`project` table → `project_settings` KV table. IPC channels `project:getMetadata` / `project:updateMetadata` replaced with `project:getSetting` / `project:setSetting` / `project:deleteSetting` / `project:getAllSettings`. Types `ProjectMetadata` and `ProjectMetadataUpdate` removed.

**renderer/lib/ipc.ts** — `ipc.project.getMetadata()` and `ipc.project.updateMetadata()` call removed channels; replace with KV equivalents
**renderer/stores/workflowStore.ts** — uses `ProjectMetadata` type, calls `getMetadata()`, reads `metadata.taxonomyName` and `metadata.columnMapping` for step gating
**renderer/pages/CompanyContextPage.tsx** — calls `updateMetadata({ companyContext })` → use `setSetting('company_context', form)`
**renderer/pages/UploadPage.tsx** — reads `metadata?.columnMapping` for display → field removed, rethink UI
