## Summary

Implement the Override Rules service — CRUD operations, rule evaluation engine, priority management, conflict detection, and ColabIP rule import.

## Scope

### Service (`src/main/services/rules.ts`)

**CRUD Operations:**
- `listRules(): Promise<OverrideRule[]>` — all rules sorted by priority_score
- `createRule(input: OverrideRuleCreate): Promise<{ id: string }>` — create rule with auto-assigned priority
- `updateRule(ruleId: string, updates: OverrideRuleUpdate): Promise<void>`
- `deleteRule(ruleId: string): Promise<void>`
- `importFromColabip(rulePack: string): Promise<{ imported: number }>` — import rules from ColabIP rules.csv

**Priority Score Auto-Assignment:**
- `project` source → 100 + (existing project rules count)
- `taxonomy` source → 200 + (index from import)
- `supplier` source → 300 + (index from sync)
- User can override priority_score manually

**Rule Evaluation Engine (`evaluateRules`):**
```typescript
async function evaluateRules(
  transactionIds?: string[]
): Promise<Map<string, string>>  // transaction_id → rule_id
```
- Load all active rules sorted by priority_score ASC
- For each rule, build SQL query from conditions (AND logic)
- Track which transactions have been matched (first match wins)
- Return mapping of transaction → matching rule

**Condition Matching:**
Operators: equals, not_equals, contains, not_contains, starts_with, ends_with, regex, in_list, greater_than, less_than, greater_than_or_equal, less_than_or_equal

Each condition: `{ field, operator, value }` → translates to SQL WHERE clause

**Conflict Detection:**
- When creating/updating a rule, check if any existing rule with a different target would match the same rows
- Return warning (not error) with conflicting rule details

**Rule Sync (used by Pipeline):**
- `syncRulesFromSources(): Promise<void>` — called at classification start:
  1. DELETE all rules where source = 'taxonomy' or source = 'supplier'
  2. Import taxonomy rules from ColabIP (source='taxonomy', priority 200+)
  3. Create rules from Category A suppliers (source='supplier', priority 300+)
  4. Project rules (source='project') are untouched

### IPC Handlers (`src/main/ipc/rules.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `rules:list` | none | `OverrideRule[]` |
| `rules:create` | `OverrideRuleCreate` | `{ id: string }` |
| `rules:update` | `ruleId: string, updates: OverrideRuleUpdate` | `void` |
| `rules:delete` | `ruleId: string` | `void` |
| `rules:importFromColabip` | `rulePack: string` | `{ imported: number }` |

### Tests
- CRUD: create, read, update, delete rules
- Priority auto-assignment by source
- Rule evaluation: single condition match
- Rule evaluation: multiple conditions (AND logic)
- Rule evaluation: first match wins (priority ordering)
- Conflict detection between rules
- Sync: clear + rebuild taxonomy/supplier rules
- Import from ColabIP

### Acceptance Criteria
- [ ] All 5 IPC handlers work
- [ ] Rule evaluation engine matches correctly with all operators
- [ ] Priority bands enforced by source
- [ ] First-match-wins logic correct
- [ ] Conflict detection works
- [ ] Rule sync clears and rebuilds non-project rules
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-11** (ColabIP Service) — read rule packs
- **S1-12** (Taxonomy Service) — taxonomy nodes for target_taxonomy_node_id
- **S1-13** (Supplier Service) — Category A suppliers for rule sync

## Spec References
- `internal_docs/ipc_contract.md` — Rules section (channels 34-38)
- `internal_docs/schema.md` — override_rules table
- `internal_docs/features.md` — Override Rules section
- `CLAUDE.md` — Override Rules conventions

## Implementation Notes

**Status:** Implemented with deviation

**Files:**
- `src/main/services/rules.ts`
- `src/main/ipc/rules.ts`
- `tests/unit/services/rules.test.ts`

**Deviations:**
- **Conflict detection is NOT implemented.** The spec calls for checking if a new/updated rule would overlap with existing rules targeting different classifications and returning a warning. `createRule` and `updateRule` do not check for or return warnings about conflicts. This should be added in a follow-up.

**All other acceptance criteria met.** All 5 IPC handlers work, rule evaluation engine matches correctly with all operators, priority bands enforced by source, first-match-wins logic correct, rule sync clears and rebuilds non-project rules, ColabIP import works.
