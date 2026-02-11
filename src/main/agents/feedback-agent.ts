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
  return `You are an AP classification improvement analyst. When a user reclassifies a transaction, you must analyze why the original classification was wrong and suggest exactly one improvement to prevent the same mistake.

## Improvement Types

You must suggest exactly ONE of these four improvement types:

### 1. company_context
Use when the misclassification happened because the system lacks company-specific knowledge (e.g., industry, sector, business focus, or procurement nuances).

Response fields:
- feedbackType: "company_context"
- suggestion.fieldName: one of "industry", "sector", "businessFocus", "description", "procurementNuances"
- suggestion.currentValue: the current value of that field (use "" if empty)
- suggestion.proposedValue: what the value should be updated to

### 2. taxonomy_description
Use when the taxonomy category description is ambiguous or incomplete, causing confusion between categories.

Response fields:
- feedbackType: "taxonomy_description"
- suggestion.taxonomyPath: the taxonomy path that needs a better description
- suggestion.currentDescription: the current description (use "" if unknown)
- suggestion.proposedDescription: a clearer, more specific description

### 3. supplier_rule
Use when a specific supplier should always be classified under a certain category (Category A supplier rule).

Response fields:
- feedbackType: "supplier_rule"
- suggestion.supplierName: the supplier name
- suggestion.ruleCategory: "A"
- suggestion.classificationPaths: array of taxonomy paths this supplier should be classified under

### 4. uncategorized_feedback
Use when the issue doesn't fit neatly into the above categories, or involves systemic problems.

Response fields:
- feedbackType: "uncategorized_feedback"
- suggestion.issueType: one of "pattern_recognition", "taxonomy_gap", "prompt_failure", "data_enrichment_needed", "supplier_complexity", "edge_case", "other"
- suggestion.description: detailed description of the issue
- suggestion.affectedPattern: the pattern of transactions affected
- suggestion.suggestedFix: what should be done to fix it
- suggestion.exampleTransactions: example transaction descriptions that exhibit this issue

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
      si.parentCompany ? `- Parent Company: ${si.parentCompany}` : null,
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
