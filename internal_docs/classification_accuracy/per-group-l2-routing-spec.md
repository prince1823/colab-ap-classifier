# Per-Group L2 Routing — Spec

## Problem

The current 2-call architecture assigns ONE L1|L2 per supplier, then constrains all L3 classification to that single branch. Multi-domain suppliers (distributors, device manufacturers, conglomerates) have transactions spanning multiple L2 categories but get forced into one.

Example: McKesson distributes both pharmaceuticals (CLINICAL|PHARMACY) and medical-surgical supplies (CLINICAL|CLINICAL SUPPLIES). If categorized as PHARMACY, all their med-surg transactions get wrong L2 AND wrong L3.

This is the single largest driver of L2 and L3 misclassification.

## Current Flow (per non-tail-spend supplier)

```
1. selectCategories(supplier research) → ONE l1_l2_path per supplier
2. classifyL3(all txn groups, that l1_l2_path) → L3 within that branch
```

## Proposed Flow

```
1. selectCategories(supplier research) → default l1_l2_path (kept for metadata/fallback)
2. classifyGroupsIntoL2(dedup groups, research, taxonomy) → Map<groupNumber, l1l2Path>
3. Bucket groups by l1_l2_path
4. For each L2 bucket: classifyL3(bucket groups, bucket l1_l2, l3Taxonomy) → L3
```

If all groups map to the same L2 (common case), step 4 is identical to today — single classifyL3 call, no extra cost.

## New Agent Method

### `classifyGroupsIntoL2(input: GroupL2SelectionInput): Promise<Map<number, string>>`

**System prompt:**
```
You are a transaction group classifier. Given transaction groups for a supplier, assign each group to the most appropriate L1|L2 category.

Rules:
- Each group gets exactly one L1|L2 path
- Use the transaction fields (GL description, memo, line description) as the primary signal
- Use supplier research as supplemental context — the supplier may operate across multiple categories
- Different groups from the same supplier CAN be assigned to different L1|L2 paths

Response format (JSON only, no markdown fencing):
{"assignments": [
  {"groupIndex": 1, "categoryPath": "L1|L2"},
  {"groupIndex": 2, "categoryPath": "L1|L2"}
]}
```

**User prompt:**
```
## L1|L2 Taxonomy
<formatL1L2Taxonomy output>

## Company Context
<company context>

## Supplier: <name>
<supplier research: industry, products, description>

## Transaction Groups
Group 1 (47,000 rows):
  gl_description: drugs & pharmaceuticals
  memo: (2 of 5): rx orders, pharma dist
Group 2 (12,000 rows):
  gl_description: non-charge med suppl
  memo: medical supplies
...

Assign each group to an L1|L2 category. Respond with JSON only.
```

**Parser:** `parseGroupL2Response(responseText: string): Map<number, string>` — same pattern as `parseCategorySelectionResponse`, returns Map of 1-based group index to L1|L2 path. Validate against taxonomy with `validateCategoryPath()`.

## New Types

```typescript
// src/shared/types/classification.ts
interface GroupL2SelectionInput {
  supplierName: string;
  supplierResearch: SupplierInfo | null;
  parentName: string | null;
  groups: Array<{ fields: Array<[string, string]>; count: number }>;
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
}
```

```typescript
// src/shared/types/services.ts — add to ClassificationAgent interface
classifyGroupsIntoL2(input: GroupL2SelectionInput): Promise<Map<number, string>>;
```

## ClassificationRunner Changes

File: `src/main/services/classification.ts` — `classifySupplierTransactions()`

Current signature takes `categoryPath: string`. New behavior:

```typescript
async classifySupplierTransactions(
  supplierId: number,
  taxonomy: TaxonomyNode[],
  companyContext: CompanyContext,
  columnPriorities: string[],
  sampleCount: number,
  scopedTxnIds?: string[]
): Promise<void> {
  // 1. Build dedup groups (already done today)
  const dedupResult = buildDedupGroups(transactions, columnPriorities, sampleCount);

  // 2. NEW: Route groups to L2s
  const groupL2Map = await this.classificationAgent.classifyGroupsIntoL2({
    supplierName,
    supplierResearch,
    parentName,
    groups: dedupResult.groups,
    taxonomy,
    companyContext,
  });

  // 3. Bucket groups by L2
  const l2Buckets = new Map<string, number[]>(); // l1l2Path → groupNumbers[]
  for (const [groupNum, l2Path] of groupL2Map) {
    const bucket = l2Buckets.get(l2Path) || [];
    bucket.push(groupNum);
    l2Buckets.set(l2Path, bucket);
  }

  // 4. For each bucket, classify L3
  for (const [l2Path, groupNums] of l2Buckets) {
    const [l1, l2] = l2Path.split('|');
    const l3Taxonomy = taxonomy.filter(n => n.depth === 3 && n.l1 === l1 && n.l2 === l2);
    const bucketTxns = extractSubBatch(dedupResult, groupNums); // need this utility
    await this.classifyL3ForBucket(bucketTxns, l2Path, l3Taxonomy, ...);
  }
}
```

## Batching

- Group L2 selection: batch at 300 groups per call (same as L3 batching)
- For suppliers with >300 groups, split into multiple group L2 selection calls
- Retry logic: up to 3 attempts, re-send only missed groups (same pattern as tail-spend L3)

## Tail-Spend

Tail-spend suppliers keep existing flow — they already use transaction groups for L2 selection. The per-group L2 routing adds most value for non-tail-spend suppliers with diverse transaction portfolios.

## Cost Impact

- Adds 1 LLM call per non-tail-spend supplier (49 suppliers in test data)
- Group L2 prompts are compact (just field summaries, not full transactions)
- Common case (single L2 per supplier) adds ~2-3s per supplier with no extra L3 calls
- Multi-L2 case adds proportional L3 calls but these would have been wrong anyway

## Tracing

Log the group L2 selection call in trace.jsonl with agent type `classification-group-l2`:
```json
{
  "agent": "classification-group-l2",
  "supplier": "mckesson",
  "groupCount": 161,
  ...
}
```

## Fallback

If `classifyGroupsIntoL2()` fails or returns empty, fall back to the existing `l1_l2_path` from `project_suppliers` (the per-supplier L2 from Call 1). This preserves backward compatibility.
