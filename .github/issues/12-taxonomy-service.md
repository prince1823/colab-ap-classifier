## Summary

Implement the Taxonomy service for importing, querying, and managing the 3-level taxonomy hierarchy within a project.

## Scope

### Service (`src/main/services/taxonomy.ts`)

**Operations:**
- `getTaxonomyMetadata(): Promise<TaxonomyMetadata | null>` — return taxonomy name from settings + node count
- `getNodes(): Promise<TaxonomyNode[]>` — query all taxonomy rows
- `setTaxonomy(input: TaxonomySetInput): Promise<void>` — replace entire taxonomy:
  1. Clear existing taxonomy table
  2. For each node path (e.g., "Direct|IT|Software"):
     - Generate UUID id
     - Parse l1, l2, l3 from pipe-delimited path
     - Calculate depth (1, 2, or 3)
     - Set parent_path
  3. Insert all nodes
  4. Update `taxonomy_name` in settings
  5. Validate L1 ∈ {Direct, Indirect, Exempt}
- `importFromColabip(industryName: string): Promise<void>` — read taxonomy from ColabIP service → call setTaxonomy

**Validation Rules:**
- L1 must be exactly one of: `Direct`, `Indirect`, `Exempt`
- Depth must be 1, 2, or 3
- `full_path` must be unique
- Parent paths must exist (referential integrity)
- Every L1|L2 path must have a corresponding L1 parent
- Every L1|L2|L3 path must have corresponding L1 and L1|L2 parents

### IPC Handlers (`src/main/ipc/taxonomy.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `taxonomy:get` | none | `TaxonomyMetadata \| null` |
| `taxonomy:getNodes` | none | `TaxonomyNode[]` |
| `taxonomy:set` | `TaxonomySetInput` | `void` |
| `taxonomy:importFromColabip` | `industryName: string` | `void` |

### Tests
- Set taxonomy → verify all nodes in DB with correct depth, parent_path
- Import from ColabIP → verify nodes match source
- L1 validation: reject paths starting with values other than Direct/Indirect/Exempt
- Get metadata → correct name and count
- Replace taxonomy → old nodes removed

### Acceptance Criteria
- [ ] All 4 IPC handlers registered
- [ ] L1 constraint enforced (Direct/Indirect/Exempt only)
- [ ] Taxonomy hierarchy validated (parents exist)
- [ ] Import from ColabIP works end-to-end
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-11** (ColabIP Service) — reads taxonomy files

## Spec References
- `internal_docs/ipc_contract.md` — Taxonomy section (channels 25-28)
- `internal_docs/schema.md` — taxonomy table
- `CLAUDE.md` — Taxonomy conventions
