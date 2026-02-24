import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  analyzeFeedback,
  buildSystemPrompt,
  buildUserPrompt,
  parseResponse,
} from '../../../src/main/agents/feedback-agent';
import type { FeedbackInput } from '../../../src/main/agents/feedback-agent';
import type { CompanyContextAction } from '../../../src/shared/types/feedback';
import type { TaxonomyDescriptionAction } from '../../../src/shared/types/feedback';
import type { SupplierRuleAction } from '../../../src/shared/types/feedback';
import type { UncategorizedFeedbackAction } from '../../../src/shared/types/feedback';
import * as llmClient from '../../../src/main/services/llm-client';

// Mock the llm-client module
vi.mock('../../../src/main/services/llm-client', () => ({
  chat: vi.fn(),
}));

const mockChat = vi.mocked(llmClient.chat);

const BASE_INPUT: FeedbackInput = {
  transactionIds: ['txn-001', 'txn-002'],
  oldClassificationPath: 'Services > IT Services > Software Licensing',
  newClassificationPath: 'Services > Professional Services > Consulting',
  userFeedback: 'This supplier provides consulting, not software licenses.',
  companyContext: {
    industry: 'Financial Services',
    sector: 'Banking',
    description: 'Regional commercial bank',
    businessFocus: 'Commercial lending and wealth management',
    procurementNuances: 'Heavy spend on regulatory compliance services',
  },
  supplierInfo: {
    officialBusinessName: 'Acme Consulting LLC',
    description: 'Management consulting firm',
    industry: 'Professional Services',
    productsServices: 'Strategy consulting, IT advisory',
    serviceType: 'Professional Services',
  },
};

const MOCK_COMPANY_CONTEXT_RESPONSE = JSON.stringify({
  feedbackType: 'company_context',
  suggestion: {
    fieldName: 'procurementNuances',
    currentValue: 'Heavy spend on regulatory compliance services',
    proposedValue:
      'Heavy spend on regulatory compliance services. Consulting engagements are common and should not be confused with software licensing.',
  },
});

const MOCK_TAXONOMY_DESCRIPTION_RESPONSE = JSON.stringify({
  feedbackType: 'taxonomy_description',
  suggestion: {
    taxonomyPath: 'Services > IT Services > Software Licensing',
    currentDescription: 'Software license purchases and renewals',
    proposedDescription:
      'Software license purchases and renewals only. Does not include IT consulting or advisory services.',
  },
});

const MOCK_SUPPLIER_RULE_RESPONSE = JSON.stringify({
  feedbackType: 'supplier_rule',
  suggestion: {
    supplierName: 'Acme Consulting LLC',
    ruleCategory: 'A',
    classificationPaths: ['Services > Professional Services > Consulting'],
  },
});

const MOCK_UNCATEGORIZED_RESPONSE = JSON.stringify({
  feedbackType: 'uncategorized_feedback',
  suggestion: {
    issueType: 'pattern_recognition',
    description: 'Consulting firms are consistently misclassified as software vendors.',
    affectedPattern: 'Suppliers with "consulting" in their name being classified under IT Services',
    suggestedFix: 'Add a pre-classification check for supplier name keywords.',
    exampleTransactions: 'Acme Consulting LLC - Strategy advisory Q1, Acme Consulting LLC - IT governance review',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildSystemPrompt', () => {
  it('should include all four feedback types', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('company_context');
    expect(prompt).toContain('taxonomy_description');
    expect(prompt).toContain('supplier_rule');
    expect(prompt).toContain('uncategorized_feedback');
  });

  it('should include valid company context field names', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('industry');
    expect(prompt).toContain('sector');
    expect(prompt).toContain('businessFocus');
    expect(prompt).toContain('description');
    expect(prompt).toContain('procurementNuances');
  });

  it('should include valid uncategorized issue types', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('pattern_recognition');
    expect(prompt).toContain('taxonomy_gap');
    expect(prompt).toContain('prompt_failure');
    expect(prompt).toContain('data_enrichment_needed');
    expect(prompt).toContain('supplier_complexity');
    expect(prompt).toContain('edge_case');
    expect(prompt).toContain('other');
  });

  it('should request JSON-only response format', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('valid JSON only');
    expect(prompt).toContain('no markdown fencing');
  });
});

describe('buildUserPrompt', () => {
  it('should include transaction IDs', () => {
    const prompt = buildUserPrompt(BASE_INPUT);
    expect(prompt).toContain('txn-001');
    expect(prompt).toContain('txn-002');
  });

  it('should include old and new classification paths', () => {
    const prompt = buildUserPrompt(BASE_INPUT);
    expect(prompt).toContain('Services > IT Services > Software Licensing');
    expect(prompt).toContain('Services > Professional Services > Consulting');
  });

  it('should include user feedback when provided', () => {
    const prompt = buildUserPrompt(BASE_INPUT);
    expect(prompt).toContain(
      'This supplier provides consulting, not software licenses.'
    );
  });

  it('should work without user feedback', () => {
    const input: FeedbackInput = {
      ...BASE_INPUT,
      userFeedback: undefined,
    };
    const prompt = buildUserPrompt(input);

    // Should not contain a "User Feedback" section
    expect(prompt).not.toContain('## User Feedback');
    // But should still contain classification details
    expect(prompt).toContain('Old Classification');
    expect(prompt).toContain('New Classification');
  });

  it('should include company context fields', () => {
    const prompt = buildUserPrompt(BASE_INPUT);
    expect(prompt).toContain('Financial Services');
    expect(prompt).toContain('Banking');
    expect(prompt).toContain('Regional commercial bank');
    expect(prompt).toContain('Commercial lending and wealth management');
    expect(prompt).toContain('Heavy spend on regulatory compliance services');
  });

  it('should handle missing optional company context fields', () => {
    const input: FeedbackInput = {
      ...BASE_INPUT,
      companyContext: {
        industry: 'Technology',
      },
    };
    const prompt = buildUserPrompt(input);
    expect(prompt).toContain('Technology');
    expect(prompt).toContain('(not set)');
  });

  it('should include supplier information when provided', () => {
    const prompt = buildUserPrompt(BASE_INPUT);
    expect(prompt).toContain('Acme Consulting LLC');
    expect(prompt).toContain('Management consulting firm');
    expect(prompt).toContain('Professional Services');
    expect(prompt).toContain('Strategy consulting, IT advisory');
  });

  it('should work without supplier info', () => {
    const input: FeedbackInput = {
      ...BASE_INPUT,
      supplierInfo: undefined,
    };
    const prompt = buildUserPrompt(input);

    // Should not contain a "Supplier Information" section
    expect(prompt).not.toContain('## Supplier Information');
    // But should still contain classification details
    expect(prompt).toContain('Old Classification');
  });
});

describe('parseResponse', () => {
  it('should parse a company_context response correctly', () => {
    const result = parseResponse(MOCK_COMPANY_CONTEXT_RESPONSE);

    expect(result.feedbackType).toBe('company_context');
    const suggestion = result.suggestion as CompanyContextAction;
    expect(suggestion.fieldName).toBe('procurementNuances');
    expect(suggestion.currentValue).toBe(
      'Heavy spend on regulatory compliance services'
    );
    expect(suggestion.proposedValue).toContain('Consulting engagements');
  });

  it('should parse a taxonomy_description response correctly', () => {
    const result = parseResponse(MOCK_TAXONOMY_DESCRIPTION_RESPONSE);

    expect(result.feedbackType).toBe('taxonomy_description');
    const suggestion = result.suggestion as TaxonomyDescriptionAction;
    expect(suggestion.taxonomyPath).toBe(
      'Services > IT Services > Software Licensing'
    );
    expect(suggestion.currentDescription).toBe(
      'Software license purchases and renewals'
    );
    expect(suggestion.proposedDescription).toContain('Does not include IT consulting');
  });

  it('should parse a supplier_rule response correctly', () => {
    const result = parseResponse(MOCK_SUPPLIER_RULE_RESPONSE);

    expect(result.feedbackType).toBe('supplier_rule');
    const suggestion = result.suggestion as SupplierRuleAction;
    expect(suggestion.supplierName).toBe('Acme Consulting LLC');
    expect(suggestion.ruleCategory).toBe('A');
    expect(suggestion.classificationPaths).toEqual([
      'Services > Professional Services > Consulting',
    ]);
  });

  it('should parse an uncategorized_feedback response correctly', () => {
    const result = parseResponse(MOCK_UNCATEGORIZED_RESPONSE);

    expect(result.feedbackType).toBe('uncategorized_feedback');
    const suggestion = result.suggestion as UncategorizedFeedbackAction;
    expect(suggestion.issueType).toBe('pattern_recognition');
    expect(suggestion.description).toContain('consistently misclassified');
    expect(suggestion.affectedPattern).toContain('consulting');
    expect(suggestion.suggestedFix).toContain('pre-classification check');
    expect(suggestion.exampleTransactions).toContain('Acme Consulting LLC');
  });

  it('should handle markdown code fences around JSON', () => {
    const wrapped = '```json\n' + MOCK_SUPPLIER_RULE_RESPONSE + '\n```';
    const result = parseResponse(wrapped);

    expect(result.feedbackType).toBe('supplier_rule');
    const suggestion = result.suggestion as SupplierRuleAction;
    expect(suggestion.supplierName).toBe('Acme Consulting LLC');
  });

  it('should handle code fences without language tag', () => {
    const wrapped = '```\n' + MOCK_TAXONOMY_DESCRIPTION_RESPONSE + '\n```';
    const result = parseResponse(wrapped);

    expect(result.feedbackType).toBe('taxonomy_description');
  });

  it('should fall back to uncategorized_feedback for unknown feedback type', () => {
    const response = JSON.stringify({
      feedbackType: 'unknown_type',
      suggestion: {
        description: 'Something unexpected',
        affectedPattern: 'some pattern',
        suggestedFix: 'some fix',
        exampleTransactions: 'example',
      },
    });

    const result = parseResponse(response);

    expect(result.feedbackType).toBe('uncategorized_feedback');
    const suggestion = result.suggestion as UncategorizedFeedbackAction;
    expect(suggestion.issueType).toBe('other');
    expect(suggestion.description).toContain('Unknown feedback type');
    expect(suggestion.affectedPattern).toBe('some pattern');
  });

  it('should fall back to uncategorized_feedback for invalid company_context fieldName', () => {
    const response = JSON.stringify({
      feedbackType: 'company_context',
      suggestion: {
        fieldName: 'invalid_field',
        currentValue: 'old',
        proposedValue: 'new',
      },
    });

    const result = parseResponse(response);

    expect(result.feedbackType).toBe('uncategorized_feedback');
    const suggestion = result.suggestion as UncategorizedFeedbackAction;
    expect(suggestion.issueType).toBe('other');
    expect(suggestion.description).toContain('Invalid company_context fieldName');
  });

  it('should default issueType to "other" for invalid uncategorized issue types', () => {
    const response = JSON.stringify({
      feedbackType: 'uncategorized_feedback',
      suggestion: {
        issueType: 'not_a_valid_type',
        description: 'Some issue',
        affectedPattern: 'pattern',
        suggestedFix: 'fix',
        exampleTransactions: 'examples',
      },
    });

    const result = parseResponse(response);

    expect(result.feedbackType).toBe('uncategorized_feedback');
    const suggestion = result.suggestion as UncategorizedFeedbackAction;
    expect(suggestion.issueType).toBe('other');
  });

  it('should always set ruleCategory to "A" for supplier_rule', () => {
    const response = JSON.stringify({
      feedbackType: 'supplier_rule',
      suggestion: {
        supplierName: 'Test Corp',
        ruleCategory: 'B',
        classificationPaths: ['Path > A'],
      },
    });

    const result = parseResponse(response);

    expect(result.feedbackType).toBe('supplier_rule');
    const suggestion = result.suggestion as SupplierRuleAction;
    expect(suggestion.ruleCategory).toBe('A');
  });

  it('should handle missing optional string fields with empty strings', () => {
    const response = JSON.stringify({
      feedbackType: 'taxonomy_description',
      suggestion: {
        taxonomyPath: 'Path > A',
      },
    });

    const result = parseResponse(response);

    expect(result.feedbackType).toBe('taxonomy_description');
    const suggestion = result.suggestion as TaxonomyDescriptionAction;
    expect(suggestion.currentDescription).toBe('');
    expect(suggestion.proposedDescription).toBe('');
  });

  it('should filter out non-string items in classificationPaths array', () => {
    const response = JSON.stringify({
      feedbackType: 'supplier_rule',
      suggestion: {
        supplierName: 'Test Corp',
        ruleCategory: 'A',
        classificationPaths: ['Path > A', 42, null, 'Path > B'],
      },
    });

    const result = parseResponse(response);
    const suggestion = result.suggestion as SupplierRuleAction;
    expect(suggestion.classificationPaths).toEqual(['Path > A', 'Path > B']);
  });

  it('should handle non-array classificationPaths gracefully', () => {
    const response = JSON.stringify({
      feedbackType: 'supplier_rule',
      suggestion: {
        supplierName: 'Test Corp',
        ruleCategory: 'A',
        classificationPaths: 'not an array',
      },
    });

    const result = parseResponse(response);
    const suggestion = result.suggestion as SupplierRuleAction;
    expect(suggestion.classificationPaths).toEqual([]);
  });

  it('should throw when response is not valid JSON', () => {
    expect(() => parseResponse('not json at all')).toThrow(
      'Failed to parse LLM response as JSON'
    );
  });

  it('should throw when suggestion object is missing', () => {
    const response = JSON.stringify({
      feedbackType: 'company_context',
    });
    expect(() => parseResponse(response)).toThrow(
      'LLM response missing "suggestion" object'
    );
  });
});

describe('analyzeFeedback', () => {
  it('should call LLM client and return parsed company_context result', async () => {
    mockChat.mockResolvedValueOnce(MOCK_COMPANY_CONTEXT_RESPONSE);

    const result = await analyzeFeedback(BASE_INPUT);

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result.feedbackType).toBe('company_context');
    const suggestion = result.suggestion as CompanyContextAction;
    expect(suggestion.fieldName).toBe('procurementNuances');
  });

  it('should call LLM client and return parsed taxonomy_description result', async () => {
    mockChat.mockResolvedValueOnce(MOCK_TAXONOMY_DESCRIPTION_RESPONSE);

    const result = await analyzeFeedback(BASE_INPUT);

    expect(result.feedbackType).toBe('taxonomy_description');
    const suggestion = result.suggestion as TaxonomyDescriptionAction;
    expect(suggestion.taxonomyPath).toBe(
      'Services > IT Services > Software Licensing'
    );
  });

  it('should call LLM client and return parsed supplier_rule result', async () => {
    mockChat.mockResolvedValueOnce(MOCK_SUPPLIER_RULE_RESPONSE);

    const result = await analyzeFeedback(BASE_INPUT);

    expect(result.feedbackType).toBe('supplier_rule');
    const suggestion = result.suggestion as SupplierRuleAction;
    expect(suggestion.supplierName).toBe('Acme Consulting LLC');
  });

  it('should call LLM client and return parsed uncategorized_feedback result', async () => {
    mockChat.mockResolvedValueOnce(MOCK_UNCATEGORIZED_RESPONSE);

    const result = await analyzeFeedback(BASE_INPUT);

    expect(result.feedbackType).toBe('uncategorized_feedback');
    const suggestion = result.suggestion as UncategorizedFeedbackAction;
    expect(suggestion.issueType).toBe('pattern_recognition');
  });

  it('should pass correct model options to LLM client', async () => {
    mockChat.mockResolvedValueOnce(MOCK_COMPANY_CONTEXT_RESPONSE);

    await analyzeFeedback(BASE_INPUT);

    const [, , options] = mockChat.mock.calls[0];
    expect(options).toEqual({
      model: 'claude-3-5-haiku-latest',
      temperature: 0,
      maxTokens: 4096,
    });
  });

  it('should include all context in the prompts sent to LLM', async () => {
    mockChat.mockResolvedValueOnce(MOCK_COMPANY_CONTEXT_RESPONSE);

    await analyzeFeedback(BASE_INPUT);

    const [systemPrompt, userPrompt] = mockChat.mock.calls[0];

    // System prompt should describe all feedback types
    expect(systemPrompt).toContain('company_context');
    expect(systemPrompt).toContain('taxonomy_description');
    expect(systemPrompt).toContain('supplier_rule');
    expect(systemPrompt).toContain('uncategorized_feedback');

    // User prompt should contain classification details
    expect(userPrompt).toContain('txn-001');
    expect(userPrompt).toContain('Services > IT Services > Software Licensing');
    expect(userPrompt).toContain('Services > Professional Services > Consulting');

    // User prompt should contain user feedback
    expect(userPrompt).toContain(
      'This supplier provides consulting, not software licenses.'
    );

    // User prompt should contain company context
    expect(userPrompt).toContain('Financial Services');
    expect(userPrompt).toContain('Banking');

    // User prompt should contain supplier info
    expect(userPrompt).toContain('Acme Consulting LLC');
    expect(userPrompt).toContain('Management consulting firm');
  });

  it('should work without user feedback', async () => {
    mockChat.mockResolvedValueOnce(MOCK_SUPPLIER_RULE_RESPONSE);

    const input: FeedbackInput = {
      ...BASE_INPUT,
      userFeedback: undefined,
    };

    const result = await analyzeFeedback(input);

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result.feedbackType).toBe('supplier_rule');

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).not.toContain('## User Feedback');
    expect(userPrompt).toContain('Old Classification');
  });

  it('should work without supplier info', async () => {
    mockChat.mockResolvedValueOnce(MOCK_TAXONOMY_DESCRIPTION_RESPONSE);

    const input: FeedbackInput = {
      ...BASE_INPUT,
      supplierInfo: undefined,
    };

    const result = await analyzeFeedback(input);

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result.feedbackType).toBe('taxonomy_description');

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).not.toContain('## Supplier Information');
  });

  it('should fall back to uncategorized_feedback for unknown suggestion type from LLM', async () => {
    const unknownTypeResponse = JSON.stringify({
      feedbackType: 'brand_new_type',
      suggestion: {
        description: 'Some novel issue',
        affectedPattern: 'all transactions',
        suggestedFix: 'upgrade the model',
        exampleTransactions: 'txn-001',
      },
    });
    mockChat.mockResolvedValueOnce(unknownTypeResponse);

    const result = await analyzeFeedback(BASE_INPUT);

    expect(result.feedbackType).toBe('uncategorized_feedback');
    const suggestion = result.suggestion as UncategorizedFeedbackAction;
    expect(suggestion.issueType).toBe('other');
    expect(suggestion.description).toContain('Unknown feedback type');
  });

  it('should propagate LLM client errors', async () => {
    mockChat.mockRejectedValueOnce(new Error('API key missing'));

    await expect(analyzeFeedback(BASE_INPUT)).rejects.toThrow(
      'API key missing'
    );
  });

  it('should handle LLM response with markdown-wrapped JSON', async () => {
    const wrapped = '```json\n' + MOCK_COMPANY_CONTEXT_RESPONSE + '\n```';
    mockChat.mockResolvedValueOnce(wrapped);

    const result = await analyzeFeedback(BASE_INPUT);

    expect(result.feedbackType).toBe('company_context');
  });
});
