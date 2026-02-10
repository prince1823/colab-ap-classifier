## Summary

Implement the Supplier service for managing project suppliers — listing, updating, and Category A management.

## Scope

### Service (`src/main/services/suppliers.ts`)

**Operations:**
- `listSuppliers(): Promise<ProjectSupplier[]>` — query all project_suppliers with computed fields
- `updateSupplier(supplierName: string, updates: SupplierUpdateInput): Promise<void>` — update supplier fields:
  - `parentSupplierId` — link to parent company
  - `supplierType` — company/individual/government/null
  - `categoryA` — boolean, marks predetermined classification
  - `categoryATaxonomyNodeId` — taxonomy node for Category A classification
  - `supplierInfo` — JSON research data
- `getSupplierByName(name: string): Promise<ProjectSupplier | null>` — lookup by name
- `upsertSupplier(supplier: Partial<ProjectSupplier>): Promise<void>` — insert or update (used by CSV import and research)

**Category A Logic:**
- When a supplier is marked Category A with a taxonomy node:
  - At classification time (not here), this becomes an override rule with source='supplier'
  - The supplier service just stores the flag and target node
  - The pipeline (S1-20) handles rule sync

### IPC Handlers (`src/main/ipc/suppliers.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `suppliers:list` | none | `ProjectSupplier[]` |
| `suppliers:update` | `supplierName: string, updates: SupplierUpdateInput` | `void` |

Note: `suppliers:research` is implemented in S1-15.

### Tests
- List suppliers → correct data shape
- Update supplier type → persisted
- Update Category A → flag and node stored
- Upsert → creates if new, updates if exists
- Get by name → correct supplier or null

### Acceptance Criteria
- [ ] Both IPC handlers registered and functional
- [ ] Supplier CRUD operations work correctly
- [ ] Category A flag + taxonomy node stored correctly
- [ ] JSON supplier_info stored and retrieved correctly
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-05** (Project Service) — project must be open

## Spec References
- `internal_docs/ipc_contract.md` — Suppliers section (channels 31-32)
- `internal_docs/schema.md` — project_suppliers table
