## Summary

Implement the CanonicalizationAgent — an LLM-powered agent that suggests mappings from CSV column headers to canonical column names.

## Scope

### Agent (`src/main/agents/canonicalization-agent.ts`)

**Purpose:** Given CSV column names and sample data, suggest mappings to the 14 canonical columns.

**Canonical Columns:**
| Name | Type | Aliases |
|------|------|---------|
| `supplier_name` | text | Vendor, Supplier, Company |
| `line_description` | log_text | Item, Description, Line Item |
| `gl_description` | log_text | GL, Account Description, Journal |
| `spend_amount` | number | Amount, Cost, Price, Total |
| `gl_code` | category | Account Code, GL Account |
| `department` | category | Dept, Business Unit |
| `invoice_date` | date | Date, Invoice Date, Transaction Date |
| `creation_date` | date | Created, Record Date |
| `company` | category | Entity, Legal Entity |
| `cost_center` | category | Cost Center, Center |
| `po_number` | text | PO, Purchase Order |
| `supplier_address` | text | Address, Supplier Address |
| `currency` | category | Currency Code |
| `memo` | log_text | Notes, Comments, Memo |

**Interface:**
```typescript
async function suggestMappings(
  columns: string[],
  sampleData: Record<string, string>[]
): Promise<CanonicalizationResult>
```

**Output:**
```typescript
interface CanonicalizationResult {
  mappings: CanonicalColumnMapping;    // canonical → csv column
  confidence: ConfidenceLevel;
  unmappedClientColumns: string[];
  importantUnmappedColumns: string[];  // canonical cols with no match
  unmappedCanonicalColumns: string[];
  reasoning: string;
}
```

**LLM Integration:**
- Use configured LLM provider (from Settings service)
- Default model: `claude-3-5-haiku-latest` (fast, cheap)
- Structured output prompt: system prompt with canonical column definitions, user prompt with CSV headers + 3-5 sample rows
- Parse JSON response from LLM

### LLM Client Utility (`src/main/services/llm-client.ts`)
- Create a shared LLM client that all agents use
- Support Anthropic and OpenAI API formats
- Support OpenRouter routing
- Read API key from Settings service
- Expose `chat(systemPrompt, userPrompt, options?)` method

### Tests
- Mock LLM responses → verify correct parsing
- Test prompt construction with various column sets
- Test with ambiguous column names
- Test with columns that don't match any canonical name

### Acceptance Criteria
- [ ] Agent constructs appropriate LLM prompt
- [ ] Parses LLM JSON response into CanonicalizationResult
- [ ] LLM client supports Anthropic/OpenAI/OpenRouter
- [ ] Error handling for LLM failures (timeout, invalid response)
- [ ] Unit tests pass with mocked LLM

## Dependencies
- **S1-01** (Project Scaffolding) — project structure
- **S1-02** (Shared Types) — CanonicalizationResult, CanonicalColumnMapping
- **S1-07** (Settings Service) — LLM provider config

## Spec References
- `internal_docs/ipc_contract.md` — CanonicalizationResult type, canonical columns table
- `internal_docs/backend_spec.md` — CanonicalizationAgent description

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/agents/canonicalization-agent.ts`
- `src/main/services/llm-client.ts`
- `tests/unit/agents/canonicalization-agent.test.ts`

**No deviations.** Agent constructs appropriate prompt, parses JSON response into CanonicalizationResult, LLM client supports Anthropic/OpenAI/OpenRouter. Error handling for LLM failures included.
