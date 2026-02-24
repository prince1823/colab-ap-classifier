## Summary

Implement the ClassificationAgent — the core LLM agent that classifies transactions (or invoice groups) to the 3-level taxonomy.

## Scope

### Agent (`src/main/agents/classification-agent.ts`)

**Purpose:** Given transaction details, taxonomy, and context, classify to L1|L2|L3.

**Interface:**
```typescript
async function classifyInvoiceGroup(input: {
  transactions: Transaction[];
  taxonomy: TaxonomyNode[];
  companyContext: CompanyContext;
  supplierResearch: SupplierInfo | null;
  historicalClassifications: { l1: string; l2: string; l3: string; count: number }[];
  isTailSpend: boolean;
}): Promise<ClassificationResult>
```

**Output:**
```typescript
interface ClassificationResult {
  classificationPath: string;         // "L1|L2|L3"
  reasoning: string;
  descriptionSupplierAligned: boolean; // do descriptions match supplier research?
}
```

**Prompt Construction:**
1. **System prompt:** You are an AP transaction classifier. Rules:
   - Always classify to full depth: L1|L2|L3
   - Use the provided taxonomy to determine the correct classification
   - Prioritize supplier research info over line/GL descriptions
   - Consider company industry and procurement nuances
2. **User prompt includes:**
   - Full taxonomy tree (paths + descriptions)
   - Company context (industry, sector, business_focus, procurement_nuances)
   - Supplier research info (type, industry, offerings)
   - Historical classifications for this supplier (what L1/L2/L3 was used before, how many times)
   - Transaction details (all canonical fields for the invoice group)
3. **Tail spend optimization:** If `isTailSpend`, use a simplified prompt (less context, faster)

**Model:** `claude-sonnet-4-20250514` or higher (complex reasoning needed, per spec)

**Constraints:**
- L1 must exist in taxonomy — validate in post-processing
- Depth must be exactly 3 — if LLM returns L1 or L1|L2, log warning and retry or best-effort
- Classification path must exist in taxonomy — validate and find closest match if not

### Tests
- Mock LLM → verify prompt includes all required sections
- Verify L1 validation (L1 must exist in taxonomy)
- Verify depth enforcement (must be 3 levels)
- Verify tail spend simplified prompt
- Verify classification path exists in taxonomy

### Acceptance Criteria
- [ ] Agent constructs comprehensive classification prompt
- [ ] L1 validated against taxonomy in post-processing
- [ ] Minimum depth of 3 enforced
- [ ] Taxonomy path validated against actual nodes
- [ ] Tail spend optimization implemented
- [ ] Unit tests pass with mocked LLM

## Dependencies
- **S1-02** (Shared Types) — Transaction, TaxonomyNode, CompanyContext types
- **S1-09** (Canonicalization Agent) — shares LLM client

## Spec References
- `internal_docs/backend_spec.md` — ClassificationAgent description
- `internal_docs/features.md` — Classification Pipeline section
- `CLAUDE.md` — Taxonomy conventions, L1 constraint

## Implementation Notes

**Status:** Implemented with minor deviation

**Files:**
- `src/main/agents/classification-agent.ts`
- `tests/unit/agents/classification-agent.test.ts`

**No deviations.** Agent constructs comprehensive classification prompt, L1 validated against taxonomy in post-processing, minimum depth of 3 enforced, taxonomy path validated, tail spend optimization implemented.
