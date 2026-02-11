## Summary

Implement the ResearchAgent — an LLM-powered agent that researches suppliers using a fallback lookup chain to determine supplier type, industry, and key offerings.

## Scope

### Agent (`src/main/agents/research-agent.ts`)

**Purpose:** Research a supplier to determine their type, industry, offerings, and other metadata.

**Fallback Lookup Chain:**
1. Check existing data in Supplier Universe (ColabIP) or prior research results
2. Supplier name → website + LinkedIn lookup
3. Supplier name + address (if available)
4. Supplier name + client company name (if available)

**Interface:**
```typescript
async function researchSupplier(
  supplierName: string,
  companyContext?: CompanyContext,
  supplierAddress?: string
): Promise<SupplierResearchResult>
```

**Output (`SupplierResearchResult extends SupplierInfo`):**
```typescript
{
  officialBusinessName?: string;
  description?: string;
  websiteUrl?: string;
  industry?: string;
  productsServices?: string;
  parentCompany?: string;
  supplierAddress?: string;
  serviceType?: string;
  naicsCode?: string;
  naicsDescription?: string;
  sicCode?: string;
  primaryBusinessModel?: string;
  primaryRevenueStreams?: string;
  serviceCategories?: string;
  targetMarket?: string;
  confidence: ConfidenceLevel;
  sources: string[];
}
```

**LLM Integration:**
- Model: `claude-3-5-haiku-latest` (fast web search tasks)
- System prompt: instruct agent to research the supplier
- Use web search tool if available (Anthropic tool_use with web search)
- Return "Unknown" for unverifiable fields
- Determine `supplier_type`: company, individual, government, or null

**Supplier Type Rules:**
- `government` — government entities, municipalities, agencies
- `individual` — sole proprietors, freelancers, individual contractors
- `company` — businesses, corporations, partnerships
- Government utilities (electricity, water, gas) should NOT be typed as government

### Tests
- Mock LLM → verify prompt construction
- Test with known supplier → verify structured output parsing
- Test fallback: no web search → uses name-only lookup
- Test "Unknown" for unverifiable fields

### Acceptance Criteria
- [ ] Agent constructs appropriate research prompts
- [ ] Fallback chain implemented (graceful degradation)
- [ ] Structured output parsed into SupplierResearchResult
- [ ] Supplier type classification logic correct
- [ ] Unit tests pass with mocked LLM

## Dependencies
- **S1-02** (Shared Types) — SupplierInfo, SupplierResearchResult
- **S1-09** (Canonicalization Agent) — shares LLM client infrastructure

## Spec References
- `internal_docs/features.md` — Supplier Research section
- `internal_docs/backend_spec.md` — ResearchAgent description
- `internal_docs/ipc_contract.md` — SupplierResearchResult type

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/agents/research-agent.ts`
- `tests/unit/agents/research-agent.test.ts`

**No deviations.** Agent constructs appropriate research prompts, fallback chain implemented, structured output parsed into SupplierResearchResult, supplier type classification logic correct.
