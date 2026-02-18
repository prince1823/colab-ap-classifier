import type { CompanyContext } from '../../shared/types/project';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type {
  FeedbackType,
  FeedbackActionDetails,
  CompanyContextAction,
  TaxonomyDescriptionAction,
  SupplierRuleAction,
  UncategorizedFeedbackAction,
} from '../../shared/types/feedback';
import * as llmClient from '../services/llm-client';
import * as settingsService from '../services/settings';

/**
 * Input for the feedback analysis agent.
 */
export interface FeedbackInput {
  transactionIds: string[];
  oldClassificationPath: string;
  newClassificationPath: string;
  userFeedback?: string;
  companyContext: CompanyContext;
  supplierInfo?: SupplierInfo;
  parentName?: string | null;
}

/**
 * The structured suggestion returned by the feedback agent.
 */
export interface FeedbackSuggestion {
  feedbackType: FeedbackType;
  suggestion: FeedbackActionDetails;
}

/**
 * Valid feedback types used for validation.
 */
const VALID_FEEDBACK_TYPES: FeedbackType[] = [
  'company_context',
  'taxonomy_description',
  'supplier_rule',
  'uncategorized_feedback',
];

/**
 * Valid company context field names.
 */
const VALID_COMPANY_CONTEXT_FIELDS: CompanyContextAction['fieldName'][] = [
  'industry',
  'sector',
  'businessFocus',
  'description',
  'procurementNuances',
];

/**
 * Valid uncategorized feedback issue types.
 */
const VALID_ISSUE_TYPES: UncategorizedFeedbackAction['issueType'][] = [
  'pattern_recognition',
  'taxonomy_gap',
  'prompt_failure',
  'data_enrichment_needed',
  'supplier_complexity',
  'edge_case',
  'other',
];

/**
 * Build the system prompt for feedback analysis.
 */
export function buildSystemPrompt(): string {
  return `You are an AP classification improvement analyst. Analyze user feedback on misclassified transactions and determine the appropriate action.

CONTEXT: When users reclassify transactions and provide feedback, this agent determines
what systemic change (if any) should be made to prevent similar misclassifications.
Suggestions are stored in system_feedback and shown in the feedback dashboard for
user approval before taking effect.

## Decision Criteria for Choosing Action Type

### 1. company_context
Choose when feedback indicates the COMPANY'S business has changed.
- Trigger phrases: "we pivoted", "our business now", "company focus changed", "we are now", "our company"
- Scope: Affects ALL future classifications for this company
- Key indicator: First-person plural ("we", "our") referring to the company itself

Response fields:
- feedbackType: "company_context"
- suggestion.fieldName: one of "industry", "sector", "businessFocus", "description", "procurementNuances"
- suggestion.currentValue: the current value of that field (use "" if empty)
- suggestion.proposedValue: what the value should be updated to

CRITICAL for proposedValue: PRESERVE all existing information from currentValue that is still accurate.
INTEGRATE the new information seamlessly. Make it CONCISE. Ensure NO LOSS of existing meaning.

Choose the most appropriate field:
- "industry": Broad industry classification (e.g., "Healthcare" → "Digital Health")
- "sector": Specific sector within industry
- "businessFocus": Business focus areas/activities
- "description": Company description narrative
- "procurementNuances": Company-specific classification guidance and edge cases

### 2. taxonomy_description
Choose when feedback indicates a CATEGORY DEFINITION is unclear/wrong OR when feedback
reveals a PATTERN the LLM should recognize.
- Trigger phrases: "this category includes", "should be defined as", "definition is wrong",
  "monthly [service] should be classified as", "transactions with [keyword] are always [category]"
- Scope: Affects how this category is understood across all transactions
- Key indicator: Third-person reference to a taxonomy category definition OR pattern that should trigger category
- IMPORTANT: If feedback describes a KEYWORD or PATTERN that should map to a category, enhance the
  description with pattern examples and keywords. This teaches the LLM what to recognize.

Response fields:
- feedbackType: "taxonomy_description"
- suggestion.taxonomyPath: the taxonomy path that needs a better description
- suggestion.currentDescription: the current description (use "" if unknown)
- suggestion.proposedDescription: a clearer, more specific description

CRITICAL for proposedDescription: PRESERVE all existing information. INTEGRATE the new feedback.
Make it CONCISE. Ensure NO LOSS of existing meaning.

### 3. supplier_rule
Choose when feedback indicates a SPECIFIC SUPPLIER always provides ONE type of service.
- Trigger phrases: "this supplier always", "[supplier name] only provides", "all [supplier] transactions are [single category]"
- Scope: Affects only transactions from this specific supplier (one-to-one deterministic mapping)
- Key indicator: References a specific supplier name with "always" or "only" AND implies single classification
- IMPORTANT: Only use for suppliers that provide ONE consistent type of service. If supplier provides
  multiple diverse services, use uncategorized_feedback with issue_type "supplier_complexity" instead.

Response fields:
- feedbackType: "supplier_rule"
- suggestion.supplierName: the supplier name
- suggestion.ruleCategory: "A"
- suggestion.classificationPaths: array of taxonomy paths this supplier should be classified under

### 4. uncategorized_feedback
Choose when feedback doesn't fit the above categories OR indicates systematic issues.
- Trigger phrases: "keeps being misclassified", "system doesn't understand", "GL code X should be",
  "department Y should map to", "this is an edge case", "data quality issue"
- Scope: Surfaces issue to developers for system-level improvements
- Key indicator: Deterministic field mappings (GL codes, departments), complex patterns LLM can't learn,
  edge cases, data quality issues, or supplier complexity

Response fields:
- feedbackType: "uncategorized_feedback"
- suggestion.issueType: one of "pattern_recognition", "taxonomy_gap", "prompt_failure", "data_enrichment_needed", "supplier_complexity", "edge_case", "other"
- suggestion.description: clear explanation of what's going wrong and why the other 3 action types don't solve this
- suggestion.affectedPattern: which transactions are affected
- suggestion.suggestedFix: specific recommendation for developers
- suggestion.exampleTransactions: 1-2 example transaction descriptions

Issue types:
- pattern_recognition: LLM not recognizing semantic patterns despite clear signals
- taxonomy_gap: Missing category or unclear taxonomy structure not fixable by updating descriptions
- prompt_failure: Existing prompt instructions being ignored or misunderstood
- data_enrichment_needed: Deterministic field mappings (GL codes, departments) needing pre-processing
- supplier_complexity: Supplier provides too many diverse services for Category A rule
- edge_case: True one-off data quality issue or vendor mislabeling
- other: Issues that don't fit the above categories

## Disambiguation Rules for Ambiguous Feedback
- "We focus on cloud services" → company_context (company's business focus)
- "Cloud services category should include X" → taxonomy_description (category definition)
- "Monthly water bills are utilities" → taxonomy_description (add pattern to category description)
- "This supplier provides cloud services" → supplier_rule (if always one type)
- "GL code 1234 is always utilities" → uncategorized_feedback (data enrichment needed)
- "Supplier X provides 20 different types of services" → uncategorized_feedback (supplier_complexity)

## Response Format

You MUST respond with valid JSON only (no markdown fencing, no explanation text outside JSON). Use this exact structure:

{
  "feedbackType": "<one of the four types>",
  "suggestion": { <fields matching the chosen type> }
}`;
}

/**
 * Build the user prompt with all context about the reclassification.
 */
export function buildUserPrompt(input: FeedbackInput): string {
  const sections: string[] = [];

  sections.push(`## Reclassification Details

- Transaction IDs: ${input.transactionIds.join(', ')}
- Old Classification: ${input.oldClassificationPath}
- New Classification: ${input.newClassificationPath}`);

  if (input.userFeedback) {
    sections.push(`## User Feedback

${input.userFeedback}`);
  }

  sections.push(`## Company Context

- Industry: ${input.companyContext.industry}
- Sector: ${input.companyContext.sector ?? '(not set)'}
- Description: ${input.companyContext.description ?? '(not set)'}
- Business Focus: ${input.companyContext.businessFocus ?? '(not set)'}
- Procurement Nuances: ${input.companyContext.procurementNuances ?? '(not set)'}`);

  if (input.supplierInfo) {
    const si = input.supplierInfo;
    const supplierFields = [
      si.officialBusinessName ? `- Official Name: ${si.officialBusinessName}` : null,
      si.description ? `- Description: ${si.description}` : null,
      si.industry ? `- Industry: ${si.industry}` : null,
      si.productsServices ? `- Products/Services: ${si.productsServices}` : null,
      input.parentName ? `- Parent Company: ${input.parentName}` : null,
      si.serviceType ? `- Service Type: ${si.serviceType}` : null,
      si.naicsCode ? `- NAICS Code: ${si.naicsCode}` : null,
      si.naicsDescription ? `- NAICS Description: ${si.naicsDescription}` : null,
      si.primaryBusinessModel ? `- Primary Business Model: ${si.primaryBusinessModel}` : null,
      si.serviceCategories ? `- Service Categories: ${si.serviceCategories}` : null,
    ].filter(Boolean);

    if (supplierFields.length > 0) {
      sections.push(`## Supplier Information

${supplierFields.join('\n')}`);
    }
  }

  sections.push(
    'Analyze why the original classification was wrong and suggest one improvement. Respond with JSON only.'
  );

  return sections.join('\n\n');
}

/**
 * Parse the LLM JSON response into a validated FeedbackSuggestion.
 * Falls back to uncategorized_feedback if the response type is unknown or invalid.
 */
export function parseResponse(responseText: string): FeedbackSuggestion {
  // Strip markdown code fences if present
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
    cleaned = cleaned.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Failed to parse LLM response as JSON: ${cleaned.substring(0, 200)}`
    );
  }

  const data = parsed as Record<string, unknown>;

  const feedbackType = data.feedbackType as string;
  const suggestion = data.suggestion as Record<string, unknown> | undefined;

  if (!suggestion || typeof suggestion !== 'object') {
    throw new Error('LLM response missing "suggestion" object');
  }

  // Validate and return the appropriate type
  if (feedbackType === 'company_context') {
    return parseCompanyContext(suggestion);
  }

  if (feedbackType === 'taxonomy_description') {
    return parseTaxonomyDescription(suggestion);
  }

  if (feedbackType === 'supplier_rule') {
    return parseSupplierRule(suggestion);
  }

  if (feedbackType === 'uncategorized_feedback') {
    return parseUncategorizedFeedback(suggestion);
  }

  // Unknown feedback type: fall back to uncategorized_feedback
  return buildFallbackUncategorized(
    `Unknown feedback type: ${String(feedbackType)}`,
    suggestion
  );
}

/**
 * Parse a company_context suggestion.
 */
function parseCompanyContext(
  suggestion: Record<string, unknown>
): FeedbackSuggestion {
  const fieldName = suggestion.fieldName as string;

  if (!VALID_COMPANY_CONTEXT_FIELDS.includes(fieldName as CompanyContextAction['fieldName'])) {
    return buildFallbackUncategorized(
      `Invalid company_context fieldName: ${fieldName}`,
      suggestion
    );
  }

  const action: CompanyContextAction = {
    fieldName: fieldName as CompanyContextAction['fieldName'],
    currentValue: String(suggestion.currentValue ?? ''),
    proposedValue: String(suggestion.proposedValue ?? ''),
  };

  return { feedbackType: 'company_context', suggestion: action };
}

/**
 * Parse a taxonomy_description suggestion.
 */
function parseTaxonomyDescription(
  suggestion: Record<string, unknown>
): FeedbackSuggestion {
  const action: TaxonomyDescriptionAction = {
    taxonomyPath: String(suggestion.taxonomyPath ?? ''),
    currentDescription: String(suggestion.currentDescription ?? ''),
    proposedDescription: String(suggestion.proposedDescription ?? ''),
  };

  return { feedbackType: 'taxonomy_description', suggestion: action };
}

/**
 * Parse a supplier_rule suggestion.
 */
function parseSupplierRule(
  suggestion: Record<string, unknown>
): FeedbackSuggestion {
  const classificationPaths = Array.isArray(suggestion.classificationPaths)
    ? suggestion.classificationPaths.filter(
        (item): item is string => typeof item === 'string'
      )
    : [];

  const action: SupplierRuleAction = {
    supplierName: String(suggestion.supplierName ?? ''),
    ruleCategory: 'A',
    classificationPaths,
  };

  return { feedbackType: 'supplier_rule', suggestion: action };
}

/**
 * Parse an uncategorized_feedback suggestion.
 */
function parseUncategorizedFeedback(
  suggestion: Record<string, unknown>
): FeedbackSuggestion {
  const issueType = suggestion.issueType as string;

  const action: UncategorizedFeedbackAction = {
    issueType: VALID_ISSUE_TYPES.includes(
      issueType as UncategorizedFeedbackAction['issueType']
    )
      ? (issueType as UncategorizedFeedbackAction['issueType'])
      : 'other',
    description: String(suggestion.description ?? ''),
    affectedPattern: String(suggestion.affectedPattern ?? ''),
    suggestedFix: String(suggestion.suggestedFix ?? ''),
    exampleTransactions: String(suggestion.exampleTransactions ?? ''),
  };

  return { feedbackType: 'uncategorized_feedback', suggestion: action };
}

/**
 * Build a fallback uncategorized feedback suggestion when parsing fails
 * for a specific type.
 */
function buildFallbackUncategorized(
  reason: string,
  rawSuggestion: Record<string, unknown>
): FeedbackSuggestion {
  const action: UncategorizedFeedbackAction = {
    issueType: 'other',
    description: reason,
    affectedPattern: String(rawSuggestion.affectedPattern ?? ''),
    suggestedFix: String(rawSuggestion.suggestedFix ?? rawSuggestion.proposedValue ?? ''),
    exampleTransactions: String(rawSuggestion.exampleTransactions ?? ''),
  };

  return { feedbackType: 'uncategorized_feedback', suggestion: action };
}

/**
 * Analyze a reclassification event and suggest an improvement to prevent
 * the same misclassification in the future.
 *
 * @param input - Details about the reclassification and surrounding context
 * @returns A structured feedback suggestion
 */
export async function analyzeFeedback(
  input: FeedbackInput
): Promise<FeedbackSuggestion> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  // Use model from settings (configured via .env or runtime)
  const settings = settingsService.getSettings();
  const responseText = await llmClient.chat(systemPrompt, userPrompt, {
    model: settings.model,
    temperature: 0,
    maxTokens: 4096,
  });

  return parseResponse(responseText);
}
