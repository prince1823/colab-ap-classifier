# Refactor Implementation Decisions

Decisions made during implementation that were not explicitly covered in the architecture doc or PR plans.

## PR 1: Foundation

### `human_reviewed` kept as separate boolean column
The architecture called for removing `human_reviewed` from `ClassificationStatus`. We removed it from the enum but kept it as a separate boolean column on the `transactions` table (matching the `human_reviewed BOOLEAN DEFAULT FALSE` in the schema). This preserves the ability to track human review status independently.

### EventBus exported as singleton
`src/main/event-bus.ts` exports `eventBus` as a module-level singleton rather than being constructed by the container. The container references it directly. This is simpler than making it constructable since there's only ever one event bus.

## PR 2: Backend Services + Container + IPC Wiring

### ProjectStore takes SupplierUniverse as third constructor param
The PR plan specified `ProjectStore(db, transactions)`. We added `supplierUniverse` as a third param because `createProject()` and `openProject()` both need to open/close the supplier universe DB alongside the project DB. Without this, the supplier universe lifecycle would need to be managed elsewhere.

### ClassificationRunner takes SupplierUniverse as ninth constructor param
The PR plan specified 8 params for ClassificationRunner. We added `supplierUniverse` because `classifySupplier()` needs to look up supplier research data from the universe. Previously this was done via the `supplierUniverseService` singleton.

### Old `suppliers.ts` deleted, replaced by `supplier-service.ts`
The old `suppliers.ts` mixed universe CRUD with project supplier listing. The new `SupplierService` class in `supplier-service.ts` focuses on project supplier management with FK-based model. Universe operations go through the `SupplierUniverse` interface.

### SupplierResearcher.researchAll() is minimal
The `researchAll()` method in the new `SupplierResearcher` currently emits a starting progress event but doesn't iterate through suppliers. The old implementation queried `transactions.supplier_name` directly, but the new architecture uses `project_suppliers` table. The full batch research flow needs the caller to provide supplier names or query project_suppliers — this will be connected in PR 3 when the frontend triggers research.

### IPC channel renames
- `suppliers:research` → `suppliers:researchAll` (matches architecture IPC channel map)
- `suppliers:research:cancel` removed (cancel is handled via `SupplierResearcher.cancel()` — not exposed as separate IPC, can be added if needed)
- `taxonomy:importFromColabip` → `taxonomy:importFromFile` (ColabIP removed)
- Pipeline IPC channels removed entirely (`pipeline:*`)
- `classification:start` and `classification:cancel` are new IPC channels (previously was `pipeline:start`)

### Classification uses `project_supplier_id` FK for grouping
The old classification queried `WHERE supplier_name = ?` directly. The new ClassificationRunner queries `WHERE project_supplier_id = ?` and JOINs with `project_suppliers` to get the supplier name for research lookup. This matches the FK-based supplier model.

### IngestService stores file_path in uploads
The old `importCSV` didn't store the file path. The new implementation stores it for potential re-import or audit trail. The `UploadRecord` interface includes optional `filePath`.

### Backward-compatible standalone exports preserved in agents
The three agent files (`classification-agent.ts`, `research-agent.ts`, `column-mapping-agent.ts`) keep their standalone pure function exports (`buildSystemPrompt`, `parseResponse`, etc.) alongside the new DI classes. This allows tests and other consumers to use the pure functions directly without needing the full DI setup.
