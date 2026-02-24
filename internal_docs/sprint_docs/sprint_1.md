**status: in-progress**

## v1

### Project Management
- Create, open, and close projects as self-contained .c91 files
- Store company context (industry, sector, description, business focus, procurement nuances) per project
- Configure tail spend threshold per project
- Track recently opened projects for quick access
- Support opening projects from any location on the filesystem
- Connect to LLM providers via OpenRouter with a single API key

### Data Import
- Upload CSV transaction files into a project
- Create new datasets or add rows to existing datasets
- Suggest column mappings using the CanonicalizationAgent
- Let users confirm or edit suggested column mappings
- Select invoice grouping columns for classification
- Store only canonicalized columns in the database
- Extract distinct suppliers from uploaded transactions into the supplier list

### Taxonomy
- Import a 3-level taxonomy (L1/L2/L3) from ColabIP during project setup
- Constrain L1 to Direct, Indirect, and Exempt
- Store taxonomy descriptions that guide LLM classification
- Add, rename, and delete taxonomy nodes within a project
- Require reassignment of affected rows when deleting a taxonomy node
- Browse and edit the taxonomy in the Taxonomy Store

### Supplier Research
- Run supplier research automatically as the first step of classification
- Use a fallback lookup chain: existing data, then name+website, then name+address, then name+client company
- Return supplier type, website, industry, parent company, key offerings, and confidence
- Use web search for supplier lookup with "Unknown" for unverifiable fields
- Mark suppliers as Category A with a predetermined taxonomy classification

### Override Rules
- Create rules with name, source, priority_score, conditions, and target classification
- Track rule source: `project`, `taxonomy`, `supplier`
- Sync `supplier` and `taxonomy` rules into override_rules at classification time; `project` rules created directly
- Auto-assign priority_score bands by source (project: 100-199, taxonomy: 200-299, supplier: 300-399)
- Allow user-adjustable priority_scores
- Support rule operators: equals, contains, regex, greater_than, less_than, in
- Evaluate rules by priority_score ascending with first match wins
- All rules editable regardless of source
- Warn when a new rule conflicts with an existing one
- Show affected row count per rule
- Filter and group rules by source

### Classification Pipeline
- Classify all transactions, new transactions only, or a filtered subset
- Sync supplier and taxonomy rules into override_rules before classification
- Apply override rules first (sorted by priority_score ascending), then LLM classification for the rest
- Group transactions by invoice for LLM classification
- Enforce minimum classification depth of L1/L2/L3
- Include taxonomy, company context, supplier research, and historical classifications in the LLM prompt
- Prioritize supplier research info over line/GL descriptions when they conflict
- Strip numeric-heavy descriptions (70%+ digits) before sending to LLM
- Detect intercompany spend and classify under Exempt
- Return classification path and reasoning per transaction
- Compute a review score (0-100) for each classified row
- Set review score to 0 for override-rule-matched rows
- Factor in historical mismatches, supplier lookup issues, description misalignment, and spend in review scores
- Show classification progress with estimated time remaining
- Support start, cancel, pause, and resume for classification jobs
- Run only one classification job at a time
- Handle partial failures with retry

### Review & Correction
- Show summary metrics: total rows, total spend
- Display and filter (AND/OR logic) classified transactions in sortable, filterable tables with aggregate spend
    - Drag a row value to the filter panel to create a filter
- Filter by review score
- Toggle tail spend filter with inline threshold editing
- Show a taxonomy tree panel for drag-and-drop reclassification
- Warn when reclassifying rows matched by override rules
- Support undo/redo for reclassifications
- Save changes immediately with no save button, showing confirmation message when saved.

### Data Stores
- Taxonomy Store: browse, add, rename, delete, and edit descriptions
- Company Context: view and edit industry, sector, description, business focus, procurement nuances
- Supplier Database: view supplier name, type, parent, historical classifications, research info, and edit type and parent inline
- Override Rules: create, edit, and delete rules with a condition builder
- Version History: timeline of all classification changes with timestamp, type, rows affected, summary, and source

### Version History
- Log all changes to transaction classifications
- Revert any change (creates new history entry, never deletes old ones)
- Export change log as CSV

### System Feedback
- Text box for users to provide free-text feedback when reclassifying rows
- FeedbackAgent analyzes reclassifications and suggests improvements (company context, taxonomy descriptions, supplier rules, uncategorized issues)
- Toggle automatic feedback generation on or off when reclassifying
- Feedback dashboard to view, approve, reject, or edit pending suggestions

### Export & Sync
- Export classified transactions as CSV reflecting all corrections
- Push taxonomy, supplier universe, and override rule changes from the project DuckDB back to the local ColabIP store

### UI / UX
- Project selector always visible in header
- Disable workflow tabs until prerequisites are met with tooltips explaining why
- Lock taxonomy selection once classification starts
- Block uploads while a classification job is running
- Cache form inputs and in-progress work locally so page reload doesn't lose data