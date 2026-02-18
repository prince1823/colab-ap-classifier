import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  researchSupplier,
  buildSystemPrompt,
  buildUserPrompt,
  parseResponse,
} from '../../../src/main/agents/research-agent';
import type { CompanyContext } from '../../../src/shared/types/project';
import type { ExaSearchResult } from '../../../src/main/services/exa-search';
import * as llmClient from '../../../src/main/services/llm-client';

// Mock the llm-client module
vi.mock('../../../src/main/services/llm-client', () => ({
  chat: vi.fn(),
}));

const mockChat = vi.mocked(llmClient.chat);

const SAMPLE_COMPANY_CONTEXT: CompanyContext = {
  industry: 'Manufacturing',
  sector: 'Industrial Goods',
  description: 'Large-scale steel manufacturer',
  businessFocus: 'Steel production and distribution',
  procurementNuances: 'Heavy raw material purchasing',
};

const MOCK_LLM_RESPONSE = JSON.stringify({
  supplierType: 'company',
  officialBusinessName: 'Acme Corporation',
  description: 'Global provider of industrial supplies and equipment',
  websiteUrl: 'https://acme.example.com',
  industry: 'Industrial Supply',
  productsServices: 'Industrial equipment, safety supplies, tools',
  parentCompany: null,
  supplierAddress: '123 Main St, Springfield, IL 62701',
  serviceType: 'Distribution',
  naicsCode: '423840',
  naicsDescription: 'Industrial Supplies Merchant Wholesalers',
  sicCode: '5085',
  primaryBusinessModel: 'B2B',
  primaryRevenueStreams: 'Wholesale distribution of industrial products',
  serviceCategories: 'Industrial Supply, Equipment Distribution',
  targetMarket: 'Manufacturing, Construction, Mining',
  confidence: 'high',
  sources: ['Company website', 'Industry databases', 'Business registries'],
});

const MOCK_MINIMAL_RESPONSE = JSON.stringify({
  supplierType: 'company',
  officialBusinessName: 'Unknown Corp',
  description: null,
  websiteUrl: null,
  industry: 'Unknown',
  productsServices: null,
  parentCompany: null,
  supplierAddress: null,
  serviceType: null,
  naicsCode: null,
  naicsDescription: null,
  sicCode: null,
  primaryBusinessModel: null,
  primaryRevenueStreams: null,
  serviceCategories: null,
  targetMarket: null,
  confidence: 'low',
  sources: ['Limited information available'],
});

const MOCK_GOVERNMENT_RESPONSE = JSON.stringify({
  supplierType: 'government',
  officialBusinessName: 'City of Springfield',
  description: 'Municipal government of Springfield, Illinois',
  websiteUrl: 'https://springfield.gov',
  industry: 'Government',
  productsServices: 'Municipal services, permits, regulatory oversight',
  parentCompany: null,
  supplierAddress: '200 City Hall Plaza, Springfield, IL 62701',
  serviceType: 'Government Services',
  naicsCode: '921110',
  naicsDescription: 'Executive Offices',
  sicCode: '9111',
  primaryBusinessModel: 'B2G',
  primaryRevenueStreams: 'Tax revenue, fees, permits',
  serviceCategories: 'Government Administration',
  targetMarket: 'Citizens, Businesses',
  confidence: 'high',
  sources: ['Government records', 'Public databases'],
});

const MOCK_INDIVIDUAL_RESPONSE = JSON.stringify({
  supplierType: 'individual',
  officialBusinessName: 'John Smith Consulting',
  description: 'Independent IT consultant',
  websiteUrl: null,
  industry: 'Information Technology',
  productsServices: 'IT consulting, software development',
  parentCompany: null,
  supplierAddress: null,
  serviceType: 'Consulting',
  naicsCode: '541511',
  naicsDescription: 'Custom Computer Programming Services',
  sicCode: null,
  primaryBusinessModel: 'B2B',
  primaryRevenueStreams: 'Consulting fees',
  serviceCategories: 'IT Consulting',
  targetMarket: 'Small and medium businesses',
  confidence: 'medium',
  sources: ['Name analysis', 'Industry inference'],
});

beforeEach(() => {
  vi.clearAllMocks();
});

// --- buildSystemPrompt ---

describe('buildSystemPrompt', () => {
  it('should include supplier type rules', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('company');
    expect(prompt).toContain('government');
    expect(prompt).toContain('individual');
  });

  it('should specify that government utilities should not be typed as government', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Government-owned utilities');
    expect(prompt).toContain('NOT');
  });

  it('should include all research fields', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('officialBusinessName');
    expect(prompt).toContain('description');
    expect(prompt).toContain('websiteUrl');
    expect(prompt).toContain('industry');
    expect(prompt).toContain('productsServices');
    expect(prompt).toContain('parentCompany');
    expect(prompt).toContain('supplierAddress');
    expect(prompt).toContain('serviceType');
    expect(prompt).toContain('naicsCode');
    expect(prompt).toContain('naicsDescription');
    expect(prompt).toContain('sicCode');
    expect(prompt).toContain('primaryBusinessModel');
    expect(prompt).toContain('primaryRevenueStreams');
    expect(prompt).toContain('serviceCategories');
    expect(prompt).toContain('targetMarket');
  });

  it('should include confidence level definitions', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('high');
    expect(prompt).toContain('medium');
    expect(prompt).toContain('low');
  });

  it('should include JSON response format instructions', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('sources');
    expect(prompt).toContain('supplierType');
    expect(prompt).toContain('valid JSON only');
  });
});

// --- buildUserPrompt ---

describe('buildUserPrompt', () => {
  it('should include the supplier name', () => {
    const prompt = buildUserPrompt('Acme Corporation');
    expect(prompt).toContain('## Supplier Name');
    expect(prompt).toContain('Acme Corporation');
  });

  it('should include supplier address when provided', () => {
    const prompt = buildUserPrompt('Acme Corporation', undefined, '123 Main St, Springfield, IL');
    expect(prompt).toContain('## Supplier Address');
    expect(prompt).toContain('123 Main St, Springfield, IL');
  });

  it('should not include supplier address section when not provided', () => {
    const prompt = buildUserPrompt('Acme Corporation');
    expect(prompt).not.toContain('## Supplier Address');
  });

  it('should include company context when provided', () => {
    const prompt = buildUserPrompt('Acme Corporation', SAMPLE_COMPANY_CONTEXT);
    expect(prompt).toContain('## Purchasing Company Context');
    expect(prompt).toContain('Industry: Manufacturing');
    expect(prompt).toContain('Sector: Industrial Goods');
    expect(prompt).toContain('Description: Large-scale steel manufacturer');
    expect(prompt).toContain('Business Focus: Steel production and distribution');
    expect(prompt).toContain('Procurement Nuances: Heavy raw material purchasing');
  });

  it('should not include company context section when not provided', () => {
    const prompt = buildUserPrompt('Acme Corporation');
    expect(prompt).not.toContain('## Purchasing Company Context');
  });

  it('should handle company context with only required fields', () => {
    const minimalContext: CompanyContext = { industry: 'Technology' };
    const prompt = buildUserPrompt('Acme Corporation', minimalContext);
    expect(prompt).toContain('## Purchasing Company Context');
    expect(prompt).toContain('Industry: Technology');
    expect(prompt).not.toContain('Sector:');
    expect(prompt).not.toContain('Business Focus:');
  });

  it('should include all three sections when all inputs are provided', () => {
    const prompt = buildUserPrompt(
      'Acme Corporation',
      SAMPLE_COMPANY_CONTEXT,
      '123 Main St'
    );
    expect(prompt).toContain('## Supplier Name');
    expect(prompt).toContain('## Supplier Address');
    expect(prompt).toContain('## Purchasing Company Context');
    expect(prompt).toContain('Research this supplier');
  });

  it('should end with JSON instruction', () => {
    const prompt = buildUserPrompt('Acme Corporation');
    expect(prompt).toContain('respond with JSON only');
  });

  it('should include web search results when provided', () => {
    const searchResults: ExaSearchResult[] = [
      {
        title: 'Acme Corp Website',
        url: 'https://acme.example.com',
        text: 'Acme Corporation is a global industrial supplier.',
        publishedDate: '2024-06-15',
      },
      {
        title: 'Acme Corp LinkedIn',
        url: 'https://linkedin.com/company/acme',
        text: 'B2B distributor headquartered in Springfield.',
      },
    ];
    const prompt = buildUserPrompt('Acme Corporation', undefined, undefined, searchResults);

    expect(prompt).toContain('## Web Search Results');
    expect(prompt).toContain('### Result 1: Acme Corp Website');
    expect(prompt).toContain('URL: https://acme.example.com');
    expect(prompt).toContain('Published: 2024-06-15');
    expect(prompt).toContain('Acme Corporation is a global industrial supplier.');
    expect(prompt).toContain('### Result 2: Acme Corp LinkedIn');
    expect(prompt).toContain('B2B distributor headquartered in Springfield.');
    expect(prompt).toContain('Prioritize data from these results');
  });

  it('should not include web search results section when array is empty', () => {
    const prompt = buildUserPrompt('Acme Corporation', undefined, undefined, []);
    expect(prompt).not.toContain('## Web Search Results');
  });

  it('should not include web search results section when undefined', () => {
    const prompt = buildUserPrompt('Acme Corporation', undefined, undefined, undefined);
    expect(prompt).not.toContain('## Web Search Results');
  });

  it('should not include Published line when publishedDate is missing', () => {
    const searchResults: ExaSearchResult[] = [
      {
        title: 'Test',
        url: 'https://example.com',
        text: 'Some text.',
      },
    ];
    const prompt = buildUserPrompt('Test', undefined, undefined, searchResults);
    expect(prompt).not.toContain('Published:');
  });
});

// --- parseResponse ---

describe('parseResponse', () => {
  it('should parse a full valid JSON response', () => {
    const { result } = parseResponse(MOCK_LLM_RESPONSE);

    expect(result.officialBusinessName).toBe('Acme Corporation');
    expect(result.description).toBe('Global provider of industrial supplies and equipment');
    expect(result.websiteUrl).toBe('https://acme.example.com');
    expect(result.industry).toBe('Industrial Supply');
    expect(result.productsServices).toBe('Industrial equipment, safety supplies, tools');
    expect(result.supplierAddress).toBe('123 Main St, Springfield, IL 62701');
    expect(result.serviceType).toBe('Distribution');
    expect(result.naicsCode).toBe('423840');
    expect(result.naicsDescription).toBe('Industrial Supplies Merchant Wholesalers');
    expect(result.sicCode).toBe('5085');
    expect(result.primaryBusinessModel).toBe('B2B');
    expect(result.primaryRevenueStreams).toBe('Wholesale distribution of industrial products');
    expect(result.serviceCategories).toBe('Industrial Supply, Equipment Distribution');
    expect(result.targetMarket).toBe('Manufacturing, Construction, Mining');
    expect(result.confidence).toBe('high');
    expect(result.sources).toEqual(['Company website', 'Industry databases', 'Business registries']);
    expect(result.supplierType).toBe('company');
  });

  it('should handle markdown code fences around JSON', () => {
    const wrapped = '```json\n' + MOCK_LLM_RESPONSE + '\n```';
    const { result } = parseResponse(wrapped);

    expect(result.officialBusinessName).toBe('Acme Corporation');
    expect(result.confidence).toBe('high');
  });

  it('should handle code fences without language tag', () => {
    const wrapped = '```\n' + MOCK_LLM_RESPONSE + '\n```';
    const { result } = parseResponse(wrapped);

    expect(result.officialBusinessName).toBe('Acme Corporation');
  });

  it('should handle null fields by omitting them from result', () => {
    const { result } = parseResponse(MOCK_MINIMAL_RESPONSE);

    expect(result.officialBusinessName).toBe('Unknown Corp');
    expect(result.industry).toBe('Unknown');
    expect(result.description).toBeUndefined();
    expect(result.websiteUrl).toBeUndefined();
    expect(result.productsServices).toBeUndefined();
    expect(result.parentCompany).toBeUndefined();
    expect(result.supplierAddress).toBeUndefined();
    expect(result.serviceType).toBeUndefined();
    expect(result.naicsCode).toBeUndefined();
    expect(result.naicsDescription).toBeUndefined();
    expect(result.sicCode).toBeUndefined();
    expect(result.primaryBusinessModel).toBeUndefined();
    expect(result.primaryRevenueStreams).toBeUndefined();
    expect(result.serviceCategories).toBeUndefined();
    expect(result.targetMarket).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.sources).toEqual(['Limited information available']);
    expect(result.supplierType).toBe('company');
  });

  it('should handle empty string fields by omitting them from result', () => {
    const response = JSON.stringify({
      officialBusinessName: '',
      description: '',
      industry: '',
      confidence: 'low',
      sources: [],
    });
    const { result } = parseResponse(response);

    expect(result.officialBusinessName).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.industry).toBeUndefined();
  });

  it('should default confidence to low when invalid', () => {
    const response = JSON.stringify({
      confidence: 'very-high',
      sources: [],
    });
    const { result } = parseResponse(response);
    expect(result.confidence).toBe('low');
  });

  it('should handle missing confidence field', () => {
    const response = JSON.stringify({
      officialBusinessName: 'Test Corp',
      sources: [],
    });
    const { result } = parseResponse(response);
    expect(result.confidence).toBe('low');
  });

  it('should handle missing sources field', () => {
    const response = JSON.stringify({
      officialBusinessName: 'Test Corp',
      confidence: 'high',
    });
    const { result } = parseResponse(response);
    expect(result.sources).toEqual([]);
  });

  it('should filter out non-string values in sources array', () => {
    const response = JSON.stringify({
      confidence: 'high',
      sources: ['valid source', 42, null, 'another source', true],
    });
    const { result } = parseResponse(response);
    expect(result.sources).toEqual(['valid source', 'another source']);
  });

  it('should throw when response is not valid JSON', () => {
    expect(() => parseResponse('not json at all')).toThrow(
      'Failed to parse LLM response as JSON'
    );
  });

  it('should throw when response is an empty string after cleanup', () => {
    expect(() => parseResponse('```json\n\n```')).toThrow(
      'Failed to parse LLM response as JSON'
    );
  });

  it('should parse government supplier response', () => {
    const { result } = parseResponse(MOCK_GOVERNMENT_RESPONSE);
    expect(result.officialBusinessName).toBe('City of Springfield');
    expect(result.industry).toBe('Government');
    expect(result.confidence).toBe('high');
    expect(result.supplierType).toBe('government');
  });

  it('should parse individual supplier response', () => {
    const { result } = parseResponse(MOCK_INDIVIDUAL_RESPONSE);
    expect(result.officialBusinessName).toBe('John Smith Consulting');
    expect(result.serviceType).toBe('Consulting');
    expect(result.confidence).toBe('medium');
    expect(result.supplierType).toBe('individual');
  });

  it('should return undefined supplierType when not in LLM response', () => {
    const response = JSON.stringify({
      officialBusinessName: 'Test Corp',
      confidence: 'medium',
      sources: [],
    });
    const { result } = parseResponse(response);
    expect(result.supplierType).toBeUndefined();
  });
});

// --- researchSupplier ---

describe('researchSupplier', () => {
  it('should call LLM client and return parsed result', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    const { result } = await researchSupplier('Acme Corporation');

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result.officialBusinessName).toBe('Acme Corporation');
    expect(result.industry).toBe('Industrial Supply');
    expect(result.confidence).toBe('high');
    expect(result.sources).toHaveLength(3);
    expect(result.supplierType).toBe('company');
  });

  it('should pass correct model options to LLM client', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation');

    const [, , options] = mockChat.mock.calls[0];
    expect(options).toEqual({
      model: 'claude-3-5-haiku-latest',
      temperature: 0,
      maxTokens: 4096,
    });
  });

  it('should include supplier name in user prompt', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation');

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).toContain('Acme Corporation');
    expect(userPrompt).toContain('## Supplier Name');
  });

  it('should include supplier type rules in system prompt', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation');

    const [systemPrompt] = mockChat.mock.calls[0];
    expect(systemPrompt).toContain('company');
    expect(systemPrompt).toContain('government');
    expect(systemPrompt).toContain('individual');
    expect(systemPrompt).toContain('Government-owned utilities');
  });

  it('should include company context when provided', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation', SAMPLE_COMPANY_CONTEXT);

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).toContain('## Purchasing Company Context');
    expect(userPrompt).toContain('Industry: Manufacturing');
    expect(userPrompt).toContain('Sector: Industrial Goods');
  });

  it('should include supplier address when provided', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation', undefined, '123 Main St, Springfield, IL');

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).toContain('## Supplier Address');
    expect(userPrompt).toContain('123 Main St, Springfield, IL');
  });

  it('should include all optional parameters when all are provided', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier(
      'Acme Corporation',
      SAMPLE_COMPANY_CONTEXT,
      '123 Main St, Springfield, IL'
    );

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).toContain('## Supplier Name');
    expect(userPrompt).toContain('## Supplier Address');
    expect(userPrompt).toContain('## Purchasing Company Context');
  });

  it('should not include optional sections when not provided', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation');

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).toContain('## Supplier Name');
    expect(userPrompt).not.toContain('## Supplier Address');
    expect(userPrompt).not.toContain('## Purchasing Company Context');
  });

  it('should return low confidence result for empty supplier name', async () => {
    const { result } = await researchSupplier('');

    expect(mockChat).not.toHaveBeenCalled();
    expect(result.confidence).toBe('low');
    expect(result.sources).toEqual([]);
  });

  it('should return low confidence result for whitespace-only supplier name', async () => {
    const { result } = await researchSupplier('   ');

    expect(mockChat).not.toHaveBeenCalled();
    expect(result.confidence).toBe('low');
    expect(result.sources).toEqual([]);
  });

  it('should propagate LLM client errors', async () => {
    mockChat.mockRejectedValueOnce(new Error('API key missing'));

    await expect(researchSupplier('Acme Corporation')).rejects.toThrow(
      'API key missing'
    );
  });

  it('should propagate LLM timeout errors', async () => {
    mockChat.mockRejectedValueOnce(new Error('Request timed out'));

    await expect(researchSupplier('Acme Corporation')).rejects.toThrow(
      'Request timed out'
    );
  });

  it('should handle LLM response with markdown-wrapped JSON', async () => {
    const wrappedResponse = '```json\n' + MOCK_LLM_RESPONSE + '\n```';
    mockChat.mockResolvedValueOnce(wrappedResponse);

    const { result } = await researchSupplier('Acme Corporation');

    expect(result.officialBusinessName).toBe('Acme Corporation');
    expect(result.confidence).toBe('high');
  });

  it('should handle minimal LLM response with mostly null fields', async () => {
    mockChat.mockResolvedValueOnce(MOCK_MINIMAL_RESPONSE);

    const { result } = await researchSupplier('Unknown Company XYZ');

    expect(result.confidence).toBe('low');
    expect(result.officialBusinessName).toBe('Unknown Corp');
    expect(result.description).toBeUndefined();
    expect(result.websiteUrl).toBeUndefined();
  });

  it('should handle government supplier research', async () => {
    mockChat.mockResolvedValueOnce(MOCK_GOVERNMENT_RESPONSE);

    const { result } = await researchSupplier('City of Springfield');

    expect(result.officialBusinessName).toBe('City of Springfield');
    expect(result.industry).toBe('Government');
    expect(result.confidence).toBe('high');
    expect(result.supplierType).toBe('government');
  });

  it('should handle individual supplier research', async () => {
    mockChat.mockResolvedValueOnce(MOCK_INDIVIDUAL_RESPONSE);

    const { result } = await researchSupplier('John Smith');

    expect(result.officialBusinessName).toBe('John Smith Consulting');
    expect(result.serviceType).toBe('Consulting');
    expect(result.confidence).toBe('medium');
    expect(result.supplierType).toBe('individual');
  });

  it('should include search results in user prompt when provided', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    const searchResults: ExaSearchResult[] = [
      {
        title: 'Acme Website',
        url: 'https://acme.example.com',
        text: 'Acme is an industrial supplier.',
      },
    ];

    await researchSupplier('Acme Corporation', undefined, undefined, searchResults);

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).toContain('## Web Search Results');
    expect(userPrompt).toContain('Acme is an industrial supplier.');
  });

  it('should not include search results section when no results provided', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await researchSupplier('Acme Corporation', undefined, undefined, []);

    const [, userPrompt] = mockChat.mock.calls[0];
    expect(userPrompt).not.toContain('## Web Search Results');
  });
});
