# Features

## Project Management
- Self-contained `.c91` DuckDB file per project

## CSV Import
- Auto-detect delimiter and encoding
- LLM-suggested column mappings

## Company Context
- Per-project metadata (industry, sector, business focus, procurement nuances)

## Taxonomy
- 3-level hierarchy (L1|L2|L3) with node descriptions

## Column Priorities
- Ordered list controlling which fields are sent to LLM

## Override Rules
- Condition-based rules, priority-ordered, first match wins
- Applied before LLM

## Supplier Management
- Deduplicated canonical names per project
- Normalize on import via supplier universe aliases

## Supplier Research
- Supplier universe lookup (shared DB, cross-project)
- Exa web search when universe lacks data
- ResearchAgent LLM extracts structured info

## Classification
- Rules applied first, matched transactions skip LLM
- LLM called per supplier (all transactions grouped)

## Review
- Hierarchical pivot view with spend
- Manual reclassification, all corrections logged

## Export
- CSV with classification path, status, reasoning

## Version History
- Changelog: source, affected rows, old/new values

---

## Planned

### Feedback Agent
- Auto-generate rules and taxonomy updates from review corrections

### QC Agent
- LLM review of classifications before human review

### Login System

### Category A Supplier Mappings
- Suppliers can have `mapped_taxonomy_paths` — pre-assigned taxonomy paths (stored as JSON array of pipe-delimited paths on `project_suppliers`)
- Replaces the old `categoryA` boolean with actual taxonomy mapping data
- Planned: Use mapped_taxonomy_paths during classification to auto-assign taxonomy nodes for a supplier's transactions (before LLM), similar to override rules but scoped per-supplier
- Integration with classification pipeline and override rules engine TBD
