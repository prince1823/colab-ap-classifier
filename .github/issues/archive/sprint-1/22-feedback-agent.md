## Summary

Implement the FeedbackAgent — an LLM agent that analyzes reclassifications and suggests system improvements.

## Scope

### Agent (`src/main/agents/feedback-agent.ts`)

**Purpose:** When a user reclassifies transactions, the FeedbackAgent analyzes the context and suggests one of four improvement types.

**Interface:**
```typescript
async function analyzeFeedback(input: {
  transactionIds: string[];
  oldClassificationPath: string;
  newClassificationPath: string;
  userFeedback?: string;
  companyContext: CompanyContext;
  supplierInfo?: SupplierInfo;
}): Promise<FeedbackSuggestion>
```

**Output Types (discriminated union):**

1. **`company_context`** — suggest updating company context
   ```typescript
   { fieldName: string; currentValue: string; proposedValue: string }
   ```

2. **`taxonomy_description`** — suggest clarifying a taxonomy node description
   ```typescript
   { taxonomyPath: string; currentDescription: string; proposedDescription: string }
   ```

3. **`supplier_rule`** — suggest creating a Category A override rule
   ```typescript
   { supplierName: string; ruleCategory: 'A'; classificationPaths: string[] }
   ```

4. **`uncategorized_feedback`** — surface for developer review
   ```typescript
   {
     issueType: 'pattern_recognition' | 'taxonomy_gap' | 'prompt_failure' |
                'data_enrichment_needed' | 'supplier_complexity' | 'edge_case' | 'other';
     description: string;
     affectedPattern: string;
     suggestedFix: string;
     exampleTransactions: string;
   }
   ```

**LLM Integration:**
- Model: `claude-3-5-haiku-latest` (fast analysis)
- System prompt: analyze why the classification was wrong and suggest the most appropriate improvement type
- User prompt: include old/new classification, transaction details, company context, user feedback

### Tests
- Mock LLM → verify each feedback type parsed correctly
- Verify prompt includes all context
- Test with missing user feedback → still works
- Test with unknown suggestion type → uncategorized_feedback

### Acceptance Criteria
- [ ] Agent produces all 4 feedback types
- [ ] Prompt includes full context (old/new classification, user feedback, company context)
- [ ] Output parsed into correct FeedbackSuggestion type
- [ ] Error handling for LLM failures
- [ ] Unit tests pass with mocked LLM

## Dependencies
- **S1-02** (Shared Types) — FeedbackType, FeedbackActionDetails
- **S1-09** (Canonicalization Agent) — shares LLM client

## Spec References
- `internal_docs/backend_spec.md` — FeedbackAgent description
- `internal_docs/features.md` — System Feedback section
- `internal_docs/ipc_contract.md` — FeedbackActionDetails types

## Implementation Notes

**Status:** Implemented as specified

**Files:**
- `src/main/agents/feedback-agent.ts`
- `tests/unit/agents/feedback-agent.test.ts`

**No deviations.** Agent produces all 4 feedback types, prompt includes full context, output parsed into correct FeedbackSuggestion type, error handling for LLM failures included.
