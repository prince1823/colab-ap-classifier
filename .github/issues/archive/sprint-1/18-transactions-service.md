## Summary

Implement the Transactions service for querying transactions with flexible filters, computing aggregate stats, and discovering available columns.

## Scope

### Service (`src/main/services/transactions.ts`)

**Operations:**

**`queryTransactions(filters?: TransactionFilter): Promise<Transaction[]>`**
Build dynamic SQL query from filter criteria:
```typescript
interface TransactionFilter {
  supplierName?: string;
  taxonomyNodeId?: string;
  reviewScoreMin?: number;
  reviewScoreMax?: number;
  spendMin?: number;
  spendMax?: number;
  excludeTailSpend?: boolean;  // uses tail_spend_threshold from settings
  page?: number;               // default 1
  pageSize?: number;           // default 50
  sortBy?: string;             // column name
  sortOrder?: 'asc' | 'desc'; // default 'asc'
}
```

The response includes the classification path resolved from taxonomy:
```typescript
interface Transaction {
  id: string;
  rowIndex: number;
  invoiceGroupKey: string | null;
  taxonomyNodeId: string | null;
  classificationPath: string | null;  // JOINed from taxonomy.full_path
  reviewScore: number | null;
  classificationReasoning: string | null;
  canonicalFields: Record<string, unknown>;  // all dynamic canonical columns
  createdAt: string;
  updatedAt: string;
}
```

**`getStats(): Promise<TransactionStats>`**
```typescript
interface TransactionStats {
  totalRows: number;
  totalSpend: number;           // SUM(spend_amount)
  uniqueSuppliers: number;      // COUNT(DISTINCT supplier_name)
  classifiedRows: number;       // WHERE taxonomy_node_id IS NOT NULL
  flaggedForReviewRows: number; // WHERE review_score > 0 (or threshold TBD)
}
```

**`getColumns(): Promise<string[]>`**
Query DuckDB information_schema to discover which canonical columns exist on the transactions table.

### IPC Handlers (`src/main/ipc/transactions.ts`)

| Channel | Args | Response |
|---------|------|----------|
| `transactions:query` | `filters?: TransactionFilter` | `Transaction[]` |
| `transactions:stats` | none | `TransactionStats` |
| `transactions:getColumns` | none | `string[]` |

Note: `transactions:reclassify` is in S1-21.

### Dynamic SQL Safety
- Use parameterized queries for all filter values (prevent SQL injection)
- Validate sortBy column exists before using in ORDER BY
- Handle missing canonical columns gracefully (e.g., spend_amount might not exist)

### Tests
- Query with no filters → all transactions
- Query with supplier filter → only matching rows
- Query with review score range → correct filtering
- Query with pagination → correct page/pageSize
- Query with sorting → correct order
- Stats → correct aggregates
- Get columns → matches actual table columns
- Tail spend filter → uses threshold from settings

### Acceptance Criteria
- [ ] All 3 IPC handlers work
- [ ] Dynamic SQL query building with parameterized queries
- [ ] Pagination works correctly
- [ ] Stats aggregation is accurate
- [ ] Column discovery works for dynamic schema
- [ ] Unit tests pass

## Dependencies
- **S1-04** (DuckDB Service) — database queries
- **S1-10** (Canonicalization Service) — transactions must exist with dynamic columns

## Spec References
- `internal_docs/ipc_contract.md` — Transactions section (channels 21-23)
- `internal_docs/schema.md` — transactions table

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/services/transactions.ts`
- `src/main/ipc/transactions.ts`
- `tests/unit/services/transactions.test.ts`

**No deviations.** All 3 IPC handlers work, dynamic SQL query building with parameterized queries, pagination works, stats aggregation accurate, column discovery works for dynamic schema.
