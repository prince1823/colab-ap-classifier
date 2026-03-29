# Remaining Fix: Export CSV — Backend Broken, No Frontend Surface

## Status

The export feature is broken end-to-end:
1. **Test is broken** — `tests/unit/services/export.test.ts` hangs/fails due to an infinite loop in the mock
2. **Frontend doesn't use it** — no UI component calls the `export:exportCSV` IPC channel
3. **Backend needs verification** — `ExportService.exportCSV` was refactored to use batched streaming but is untested

---

## Failing test

`tests/unit/services/export.test.ts > ExportService > exportCSV > should export transactions to CSV` (~5s timeout)

**Root cause:** `ExportService.exportCSV` uses a batched while-loop:

```ts
while (!writeError) {
  const rows = await this.db.all(`... LIMIT ${EXPORT_BATCH_SIZE} OFFSET ${offset}`, ...);
  if (rows.length === 0) break;
  ...
  offset += EXPORT_BATCH_SIZE;
}
```

The test mock uses `mockImplementation` that always returns 1 row for non-schema queries. The loop never reaches `rows.length === 0` so it runs until the test runner terminates it.

**Fix for the test mock:**
```ts
vi.mocked(db.all)
  .mockResolvedValueOnce([...schemaRows])   // information_schema call
  .mockResolvedValueOnce([...dataRows])     // first batch
  .mockResolvedValue([]);                   // subsequent batches → break
```

---

## Backend export concerns

Looking at `ExportService.exportCSV` in `src/main/services/export.ts`:

1. **Column discovery** — reads `information_schema.columns` for `transactions` table. Correctly excludes meta columns. Good.

2. **Virtual columns** — hardcodes `supplier_name` and `classification_path` in the SELECT and headers. `supplier_name` might also appear in `canonicalColumns` if the CSV was imported with a `supplier_name` column → duplicate header. Needs a dedup guard.

3. **Classification path format** — splits on `|` (pipe delimiter) but the taxonomy `full_path` field may use `|` while `classification_path` in the SELECT alias resolves `tax.full_path` directly. This is correct as-is but should be verified.

4. **No progress events** — large exports give no feedback to the renderer. Consider emitting `eventBus` progress.

5. **Export scope** — currently exports all transactions. Needs to support exporting only classified rows or a filtered subset (UI requirement).

---

## Frontend surface

There is currently no button, menu item, or route that triggers export. The feature was planned for the Output workflow step but not implemented.

**Required frontend work:**
- Add "Export CSV" button on the Output/Review page
- Call `window.api.invoke('export:exportCSV', filters)` with current filter state
- Show progress indicator and file-saved confirmation

**IPC handler location:** `src/main/ipc/export.ts` — verify it exists and is registered.

---

## Action items

- [ ] Fix the test mock to use `mockResolvedValueOnce` for first batch and `mockResolvedValue([])` for subsequent calls
- [ ] Add dedup guard for `supplier_name` in canonical columns detection
- [ ] Implement frontend export button on Output page
- [ ] Add optional `filters` param pass-through from UI to IPC call
- [ ] Add progress emission via `eventBus` for large exports

---

## Related files

- `src/main/services/export.ts` — `ExportService.exportCSV`
- `src/main/ipc/export.ts` — IPC handler registration
- `tests/unit/services/export.test.ts` — failing test
- `src/renderer/pages/` — Output page (export button needed here)
