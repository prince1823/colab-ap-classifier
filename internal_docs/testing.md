# Testing

## Full Run Script

Runs the complete classification pipeline end-to-end against real LLM APIs. No test framework — just runs the pipeline and saves all output for inspection.

```bash
npx tsx scripts/full-run.ts <run-dir>

# Examples:
npx tsx scripts/full-run.ts test_data/innova_100
npx tsx scripts/full-run.ts test_data/03-29-classification-accuracy
```

### Required files in `<run-dir>/`

- `config.json` — project name, company context, column mapping, taxonomy name, column priorities
- `input.csv` — transaction data (or specify a different file via `csvFile` in config.json)
- **Taxonomy** (one of):
  - `taxonomy.txt` in the run dir — use for custom or per-run taxonomies
  - `taxonomy` field in config.json — resolved to `colabip/taxonomies/<name>/taxonomy.txt`

### Optional files in `<run-dir>/`

- `universe.db` — pre-seeded supplier universe; copied into output to avoid re-researching known suppliers
- `rules.json` — override rules (skipped if absent)

### config.json format

```json
{
  "projectName": "...",
  "taxonomy": "healthcare_services",
  "companyContext": {
    "companyName": "...",
    "industry": "...",
    "description": "..."
  },
  "columnMapping": {
    "supplier_name": "...",
    "spend_amount": "...",
    "invoice_date": "...",
    "gl_description": "..."
  },
  "columnPriorities": ["gl_description", "memo", "line_description"],
  "csvFile": "optional-override.csv",
  "skipSupplierResearch": false
}
```

### Outputs

Written to `<run-dir>/output/run-<timestamp>/`:

- `classified.csv` — all input rows with `classification_path` and `flagged_for_review` columns added
- `run.log` — timestamped progress log including one line per LLM call (agent, supplier, group count, elapsed ms)
- `trace.jsonl` — full LLM trace (system prompt, user prompt, raw response, timing) for every call
- `project.c91` — DuckDB project file for post-run inspection

## Accuracy Script

Compares classified output against ground truth labels to produce an accuracy report.

```bash
npx tsx scripts/accuracy.ts test_data/<folder-name>
```

Example:
```bash
npx tsx scripts/accuracy.ts test_data/innova_100
```

### Inputs

The script auto-discovers files in the specified folder:
- **Ground truth CSV**: Largest `.csv` in the folder (must have `Level 1`, `Level 2`, `Level 3` columns)
- **Classified CSV**: Latest `output/run-*/classified.csv`
- **config.json**: Reads `columnMapping.supplier_name` and `columnMapping.spend_amount` for ground truth column names
- **supplier_info.csv** (optional): Supplier attribute flags for breakdown analysis

Both the ground truth and classified CSVs must be in the same row order. The script validates alignment by comparing spend amounts row-by-row.

### Output

Writes `accuracy.md` to the same run folder as the classified CSV (e.g., `test_data/innova_100/output/run-<timestamp>/accuracy.md`).

### Report Sections

1. **Transaction-Level Accuracy** — correct transactions / total at each level (L1, L2, L3)
2. **Spend-Level Accuracy** — correct spend / total spend at each level
3. **Supplier-Level Accuracy** — supplier is correct if mode of predicted matches mode of ground truth
4. **Supplier-Level Accuracy by Spend Segment** — head (>= $10k) vs tail (< $10k) breakdown
5. **Most Common Misclassifications** — top 15 ground truth → predicted pairs at each level, with supplier names and per-supplier transaction percentages
6. **Supplier-Level Accuracy by Supplier Attributes** (only if `supplier_info.csv` exists) — breakdowns by spend bracket, ambiguous name, multi-L2, single transaction, and domain count
7. **Multiple L2 Analysis** — per-supplier table showing each predicted L2 with coverage (% of ground truth rows with that L2) and accuracy (% of predicted rows that were correct), missed L2 rate, and distinct L3 count
