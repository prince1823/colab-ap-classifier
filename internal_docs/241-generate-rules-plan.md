# Issue 241: Generate Rules in Bulk After Human Review

## Context

After an analyst reviews AI classifications in the Review (Pivot) page, they should be able to click "Generate Rules" to automatically create override rules from the reviewed data. This captures the analyst's review as reusable rules for future classification runs. A separate IPC marks all transactions as `human_reviewed = true` before rule generation. No user approval/preview step — rules are created automatically.

## Order of Operations (UI Flow)

1. Analyst clicks "Generate Rules" button on Review page
2. Backend: `transactions:markAllReviewed` → marks all transactions `human_reviewed = true`
3. Backend: `rules:generate` → analyzes eligible transactions, auto-detects distinguishing fields from `column_priorities`, creates rules
4. UI shows toast: "Created X rules for Y suppliers"

## Implementation

### 1. Schema: Add `source` column to `override_rules`

**File:** `src/main/services/database.ts`

- Add migration in `runMigrations()` (after existing migrations ~line 222): check if `source` column exists on `override_rules`, if not `ALTER TABLE override_rules ADD COLUMN source VARCHAR DEFAULT 'manual'`
- Update `CREATE TABLE override_rules` definition (~line 328) to include `source VARCHAR DEFAULT 'manual'`

### 2. Types

**File:** `src/shared/types/rules.ts`
- Add `source: 'manual' | 'auto_generated'` to `OverrideRule`
- Add `source?: 'manual' | 'auto_generated'` to `OverrideRuleCreate`
- Add new type:
```typescript
interface GenerateRulesResult {
  rulesCreated: number;
  suppliersProcessed: number;
}
```

**File:** `src/shared/types/services.ts`
- Add `markAllReviewed(): Promise<number>` to `TransactionStore` interface
- Add `generate_rules_preview(): Promise<GenerateRulesResult>` to `RuleStore` interface

### 3. Backend: `TransactionStore.markAllReviewed()`

**File:** `src/main/services/transactions.ts`

Simple bulk update — no changelog entry needed:
```sql
UPDATE transactions SET human_reviewed = TRUE, updated_at = CURRENT_TIMESTAMP
WHERE human_reviewed = FALSE
```
Returns count of rows updated.

### 4. Backend: `RuleStore.generate_rules_preview()`

**File:** `src/main/services/rules.ts`

- Add `source` to `RuleRow` interface and `rowToRule` mapper
- Update `createRule` INSERT to include `source` column (defaults to `'manual'`)

**Dependencies:** `generate_rules_preview` needs `ProjectStore` to read `column_priorities` from project settings. Add `project: IProjectStore` as a constructor dependency to `RuleStore`.

**Container change** (`src/main/container.ts`): `new RuleStore(db, transactions, project)` — add `project` as third arg.

**`generate_rules_preview` algorithm:**

1. Load `column_priorities` from `this.project.getSetting('column_priorities')` → `string[]`

2. Query eligible transactions with all column_priorities columns:
```sql
SELECT t.id, ps.supplier_name, t.taxonomy_node_id, tax.full_path,
       t.<col1>, t.<col2>, ... (all column_priorities columns)
FROM transactions t
JOIN project_suppliers ps ON t.project_supplier_id = ps.id
JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
WHERE t.human_reviewed = TRUE
  AND t.classification_status != 'classified_by_rule'
  AND t.taxonomy_node_id IS NOT NULL
```

3. Group in-memory by `supplier_name` → then by `taxonomy_node_id`, summing spend (use `spend_amount` if available, else transaction count)

4. Per supplier, dispatch to helper function based on category count:

**`generateSingleCategoryRules(supplierName, taxonomyNodeId, taxonomyPath): OverrideRuleCreate`**
- Returns 1 rule: `supplier_name equals X` → that taxonomy node
- Rule name: `"{supplierName}"`

**`generateMultiCategoryRules(supplierName, categoriesWithTxns, columnPriorities): OverrideRuleCreate[]`**
- Sort categories by total spend desc; highest = fallback
- For each non-fallback category: **auto-detect distinguishing field** by iterating through `columnPriorities` and finding the first column where the most-common value for this category's transactions differs from the fallback category's most-common value
- Returns array of rules:
  - Compound rules first (lower priority): `supplier_name equals X AND <detected_field> equals <value>` → that category
  - Fallback rule last (higher priority number): `supplier_name equals X` → highest-spend category
- Rule names: `"{supplierName} | {field}={value}"` for compound, `"{supplierName}"` for fallback
- Edge cases: if no distinguishing field found for a category (all values match fallback), skip that compound rule — those transactions fall through to the fallback rule

**`generate_rules_preview()` orchestrates:**
- Loads data, groups by supplier
- Calls `generateSingleCategoryRules` or `generateMultiCategoryRules` per supplier
- Collects all `OverrideRuleCreate[]`, handles name collisions (append ` (2)`, ` (3)`)
- Creates each rule via `this.createRule()` with `source: 'auto_generated'`
- Returns `GenerateRulesResult`

5. Handle edge cases:
   - If `spend_amount` doesn't exist as a column, fall back to transaction count for spend ranking
   - If distinguishing field value is NULL/empty, skip compound rule

### 5. IPC Handlers

**File:** `src/main/ipc/transactions.ts` — add:
```typescript
registerHandler('transactions:markAllReviewed', async () => {
  return transactions.markAllReviewed();
});
```

**File:** `src/main/ipc/rules.ts` — add:
```typescript
registerHandler('rules:generate', async () => {
  return rules.generate_rules_preview();
});
```

### 6. IPC Contract

**File:** `src/shared/types/ipc-contract.ts` — add to `IPCInvokeMap`:
```typescript
'transactions:markAllReviewed': { args: []; result: number };
'rules:generate': { args: []; result: GenerateRulesResult };
```

### 7. Renderer IPC Client

**File:** `src/renderer/lib/ipc.ts` — add:
- `transactions.markAllReviewed: () => invoke('transactions:markAllReviewed')`
- `rules.generate: () => invoke('rules:generate')`

### 8. UI: PivotPage — "Generate Rules" button

**File:** `src/renderer/pages/PivotPage.tsx`
- Add "Generate Rules" button in header
- On click: call `ipc.transactions.markAllReviewed()` then `ipc.rules.generate()`
- Show result toast: "Created X rules for Y suppliers"
- Refresh pivot data
- No modal needed — distinguishing field is auto-detected from column_priorities

## Files Summary

| File | Change |
|------|--------|
| `src/main/services/database.ts` | Migration + schema for `source` column |
| `src/shared/types/rules.ts` | `source` field, `GenerateRulesResult` type |
| `src/shared/types/services.ts` | Interface updates for both stores |
| `src/shared/types/ipc-contract.ts` | 2 new IPC channels |
| `src/main/services/rules.ts` | `source` in RuleRow/createRule, `generate_rules_preview()` method |
| `src/main/services/transactions.ts` | `markAllReviewed()` method |
| `src/main/ipc/rules.ts` | `rules:generate` handler |
| `src/main/ipc/transactions.ts` | `transactions:markAllReviewed` handler |
| `src/renderer/lib/ipc.ts` | 2 new client methods |
| `src/main/container.ts` | Add `project` as third arg to `RuleStore` constructor |
| `src/renderer/pages/PivotPage.tsx` | Add "Generate Rules" button |

## Verification

1. `npx tsc --noEmit` — type check passes
2. Open a project with classified transactions in the app
3. Navigate to Review page → click Generate Rules
4. Verify rules appear in Override Rules page with `source = 'auto_generated'`
5. Verify rule names are descriptive (supplier name, with field=value for compound rules)
6. Verify all transactions now have `human_reviewed = true`
7. Verify suppliers whose transactions are all `classified_by_rule` get no new rules generated
8. Run existing tests: `npm run test:mock`
