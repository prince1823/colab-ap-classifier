## Summary

Implement the ColabIP service that reads taxonomy files and rule packs from the local `colabip/` directory.

## Scope

### Service (`src/main/services/colabip.ts`)

**ColabIP Directory Structure:**
```
colabip/
├── taxonomies/
│   ├── healthcare/
│   │   ├── 1.txt     # Line 1: path (e.g., "clinical|clinical equipment")
│   │   ├── 2.txt     # Line 2: description
│   │   └── rules.csv # Taxonomy-specific rules
│   └── general/
│       ├── *.txt
│       └── rules.csv
└── suppliers/
    └── supplier_universe.csv
```

**Taxonomy File Format (each .txt file):**
- Line 1: Pipe-delimited taxonomy path (e.g., `clinical|clinical equipment|diagnostic imaging`)
- Line 2: Description with supplier examples

**Rules.csv Format:**
Columns: `name`, `conditions` (JSON string), `target_taxonomy_path`, `priority_score`

**Operations:**
- `listTaxonomies(): Promise<TaxonomyInfo[]>` — scan colabip/taxonomies/ directories, count .txt files per industry
- `listRulePacks(): Promise<RulePackInfo[]>` — scan for rules.csv files, count rules per pack
- `readTaxonomy(industryName: string): Promise<{ nodes: Array<{ path: string; description: string }> }>` — parse all .txt files in a taxonomy directory
- `readRulePack(industryName: string): Promise<Array<{ name: string; conditions: RuleCondition[]; targetPath: string; priorityScore: number }>>` — parse rules.csv
- `readSupplierUniverse(): Promise<Array<{ supplierName, parentCompany, supplierType, website, industry }>>` — parse supplier_universe.csv

### IPC Handlers (`src/main/ipc/colabip.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `colabip:listTaxonomies` | none | `TaxonomyInfo[]` |
| `colabip:listRulePacks` | none | `RulePackInfo[]` |

### Edge Cases
- Missing colabip/ directory → return empty arrays (not an error)
- Malformed .txt files → skip with warning
- Empty rules.csv → return empty array
- Handle BOM in CSV files

### Tests
- Create test colabip/ fixture with sample taxonomy and rules
- List taxonomies → correct names and counts
- Read taxonomy → correct paths and descriptions
- Read rules → correct parsed conditions
- Missing directory → empty arrays

### Acceptance Criteria
- [ ] Reads taxonomy .txt files correctly (2-line format)
- [ ] Parses rules.csv with JSON conditions
- [ ] Both IPC handlers work
- [ ] Handles missing/empty colabip gracefully
- [ ] Unit tests pass with test fixtures

## Dependencies
- **S1-03** (IPC Infrastructure) — handler registration

## Spec References
- `internal_docs/backend_spec.md` — ColabIP repository structure
- `internal_docs/ipc_contract.md` — ColabIP section (channels 29-30)
