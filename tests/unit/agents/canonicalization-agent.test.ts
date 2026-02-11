import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  suggestMappings,
  buildSystemPrompt,
  buildUserPrompt,
  parseResponse,
  CANONICAL_COLUMNS,
} from '../../../src/main/agents/canonicalization-agent';
import * as llmClient from '../../../src/main/services/llm-client';

// Mock the llm-client module
vi.mock('../../../src/main/services/llm-client', () => ({
  chat: vi.fn(),
}));

const mockChat = vi.mocked(llmClient.chat);

const SAMPLE_COLUMNS = [
  'Vendor Name',
  'Invoice Amount',
  'Description',
  'GL Account',
  'Invoice Date',
  'Department',
  'PO Number',
  'Notes',
];

const SAMPLE_DATA: Record<string, string>[] = [
  {
    'Vendor Name': 'Acme Corp',
    'Invoice Amount': '1500.00',
    'Description': 'Office supplies',
    'GL Account': '5000-100',
    'Invoice Date': '2024-01-15',
    'Department': 'Marketing',
    'PO Number': 'PO-2024-001',
    'Notes': 'Quarterly order',
  },
  {
    'Vendor Name': 'TechCo Inc',
    'Invoice Amount': '25000.00',
    'Description': 'Software license renewal',
    'GL Account': '6200-300',
    'Invoice Date': '2024-01-20',
    'Department': 'IT',
    'PO Number': 'PO-2024-002',
    'Notes': 'Annual renewal',
  },
  {
    'Vendor Name': 'Global Services LLC',
    'Invoice Amount': '750.50',
    'Description': 'Consulting fees',
    'GL Account': '7100-200',
    'Invoice Date': '2024-02-01',
    'Department': 'Finance',
    'PO Number': '',
    'Notes': '',
  },
];

const MOCK_LLM_RESPONSE = JSON.stringify({
  mappings: {
    supplier_name: 'Vendor Name',
    spend_amount: 'Invoice Amount',
    line_description: 'Description',
    gl_code: 'GL Account',
    invoice_date: 'Invoice Date',
    department: 'Department',
    po_number: 'PO Number',
    memo: 'Notes',
  },
  confidence: 'high',
  unmappedClientColumns: [],
  importantUnmappedColumns: [],
  unmappedCanonicalColumns: [
    'gl_description',
    'creation_date',
    'company',
    'cost_center',
    'supplier_address',
    'currency',
  ],
  reasoning:
    'Vendor Name clearly maps to supplier_name. Invoice Amount is a monetary value mapping to spend_amount. Description maps to line_description. GL Account maps to gl_code. Invoice Date maps to invoice_date. Department maps directly. PO Number maps to po_number. Notes maps to memo.',
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CANONICAL_COLUMNS', () => {
  it('should contain exactly 14 canonical columns', () => {
    expect(CANONICAL_COLUMNS).toHaveLength(14);
  });

  it('should have all expected column names', () => {
    const names = CANONICAL_COLUMNS.map((c) => c.name);
    expect(names).toContain('supplier_name');
    expect(names).toContain('line_description');
    expect(names).toContain('gl_description');
    expect(names).toContain('spend_amount');
    expect(names).toContain('gl_code');
    expect(names).toContain('department');
    expect(names).toContain('invoice_date');
    expect(names).toContain('creation_date');
    expect(names).toContain('company');
    expect(names).toContain('cost_center');
    expect(names).toContain('po_number');
    expect(names).toContain('supplier_address');
    expect(names).toContain('currency');
    expect(names).toContain('memo');
  });

  it('should have valid types for all columns', () => {
    const validTypes = ['text', 'log_text', 'number', 'category', 'date'];
    for (const col of CANONICAL_COLUMNS) {
      expect(validTypes).toContain(col.type);
    }
  });

  it('should have non-empty aliases for all columns', () => {
    for (const col of CANONICAL_COLUMNS) {
      expect(col.aliases.length).toBeGreaterThan(0);
    }
  });
});

describe('buildSystemPrompt', () => {
  it('should include all canonical column names', () => {
    const prompt = buildSystemPrompt();
    for (const col of CANONICAL_COLUMNS) {
      expect(prompt).toContain(col.name);
    }
  });

  it('should include column types', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('text');
    expect(prompt).toContain('log_text');
    expect(prompt).toContain('number');
    expect(prompt).toContain('category');
    expect(prompt).toContain('date');
  });

  it('should include aliases for columns', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Vendor');
    expect(prompt).toContain('Amount');
    expect(prompt).toContain('Invoice Date');
  });

  it('should include JSON response format instructions', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('mappings');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('unmappedClientColumns');
    expect(prompt).toContain('unmappedCanonicalColumns');
    expect(prompt).toContain('reasoning');
  });
});

describe('buildUserPrompt', () => {
  it('should include all column headers', () => {
    const prompt = buildUserPrompt(SAMPLE_COLUMNS, SAMPLE_DATA);
    for (const col of SAMPLE_COLUMNS) {
      expect(prompt).toContain(col);
    }
  });

  it('should include sample data values', () => {
    const prompt = buildUserPrompt(SAMPLE_COLUMNS, SAMPLE_DATA);
    expect(prompt).toContain('Acme Corp');
    expect(prompt).toContain('1500.00');
    expect(prompt).toContain('Office supplies');
  });

  it('should limit to at most 5 sample rows', () => {
    const manyRows = Array.from({ length: 10 }, (_, i) => ({
      col1: `value-${i}`,
    }));
    const prompt = buildUserPrompt(['col1'], manyRows);

    // Should include rows 0-4 but not 5-9
    expect(prompt).toContain('value-0');
    expect(prompt).toContain('value-4');
    expect(prompt).not.toContain('value-5');
    expect(prompt).toContain('5 rows');
  });

  it('should handle missing values with (empty)', () => {
    const data = [{ col1: 'present' }];
    const prompt = buildUserPrompt(['col1', 'col2'], data);
    expect(prompt).toContain('col2: (empty)');
  });

  it('should include row numbers', () => {
    const prompt = buildUserPrompt(SAMPLE_COLUMNS, SAMPLE_DATA);
    expect(prompt).toContain('Row 1:');
    expect(prompt).toContain('Row 2:');
    expect(prompt).toContain('Row 3:');
  });
});

describe('parseResponse', () => {
  it('should parse a valid JSON response', () => {
    const result = parseResponse(MOCK_LLM_RESPONSE);

    expect(result.mappings).toEqual({
      supplier_name: 'Vendor Name',
      spend_amount: 'Invoice Amount',
      line_description: 'Description',
      gl_code: 'GL Account',
      invoice_date: 'Invoice Date',
      department: 'Department',
      po_number: 'PO Number',
      memo: 'Notes',
    });
    expect(result.confidence).toBe('high');
    expect(result.unmappedClientColumns).toEqual([]);
    expect(result.unmappedCanonicalColumns).toHaveLength(6);
    expect(result.reasoning).toContain('Vendor Name');
  });

  it('should handle markdown code fences around JSON', () => {
    const wrapped = '```json\n' + MOCK_LLM_RESPONSE + '\n```';
    const result = parseResponse(wrapped);

    expect(result.mappings.supplier_name).toBe('Vendor Name');
    expect(result.confidence).toBe('high');
  });

  it('should handle code fences without language tag', () => {
    const wrapped = '```\n' + MOCK_LLM_RESPONSE + '\n```';
    const result = parseResponse(wrapped);

    expect(result.mappings.supplier_name).toBe('Vendor Name');
  });

  it('should default confidence to low when invalid', () => {
    const response = JSON.stringify({
      mappings: { supplier_name: 'Vendor' },
      confidence: 'very-high',
      unmappedClientColumns: [],
      importantUnmappedColumns: [],
      unmappedCanonicalColumns: [],
      reasoning: 'test',
    });

    const result = parseResponse(response);
    expect(result.confidence).toBe('low');
  });

  it('should filter out mappings with invalid canonical names', () => {
    const response = JSON.stringify({
      mappings: {
        supplier_name: 'Vendor',
        not_a_real_column: 'SomeColumn',
      },
      confidence: 'medium',
      unmappedClientColumns: [],
      importantUnmappedColumns: [],
      unmappedCanonicalColumns: [],
      reasoning: 'test',
    });

    const result = parseResponse(response);
    expect(result.mappings).toHaveProperty('supplier_name');
    expect(result.mappings).not.toHaveProperty('not_a_real_column');
  });

  it('should filter out mappings with empty string values', () => {
    const response = JSON.stringify({
      mappings: {
        supplier_name: 'Vendor',
        spend_amount: '',
      },
      confidence: 'medium',
      unmappedClientColumns: [],
      importantUnmappedColumns: [],
      unmappedCanonicalColumns: [],
      reasoning: 'test',
    });

    const result = parseResponse(response);
    expect(result.mappings).toHaveProperty('supplier_name');
    expect(result.mappings).not.toHaveProperty('spend_amount');
  });

  it('should handle missing optional arrays gracefully', () => {
    const response = JSON.stringify({
      mappings: { supplier_name: 'Vendor' },
      confidence: 'high',
    });

    const result = parseResponse(response);
    expect(result.unmappedClientColumns).toEqual([]);
    expect(result.importantUnmappedColumns).toEqual([]);
    expect(result.unmappedCanonicalColumns).toEqual([]);
    expect(result.reasoning).toBe('');
  });

  it('should throw when response is not valid JSON', () => {
    expect(() => parseResponse('not json at all')).toThrow(
      'Failed to parse LLM response as JSON'
    );
  });

  it('should throw when mappings object is missing', () => {
    const response = JSON.stringify({ confidence: 'high' });
    expect(() => parseResponse(response)).toThrow(
      'LLM response missing "mappings" object'
    );
  });

  it('should handle non-string values in arrays by filtering them out', () => {
    const response = JSON.stringify({
      mappings: { supplier_name: 'Vendor' },
      confidence: 'high',
      unmappedClientColumns: ['col1', 42, null, 'col2'],
      importantUnmappedColumns: [],
      unmappedCanonicalColumns: [],
      reasoning: 'test',
    });

    const result = parseResponse(response);
    expect(result.unmappedClientColumns).toEqual(['col1', 'col2']);
  });
});

describe('suggestMappings', () => {
  it('should call LLM client and return parsed result', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    const result = await suggestMappings(SAMPLE_COLUMNS, SAMPLE_DATA);

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result.mappings.supplier_name).toBe('Vendor Name');
    expect(result.mappings.spend_amount).toBe('Invoice Amount');
    expect(result.confidence).toBe('high');
  });

  it('should pass system and user prompts to LLM client', async () => {
    mockChat.mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await suggestMappings(SAMPLE_COLUMNS, SAMPLE_DATA);

    const [systemPrompt, userPrompt, options] = mockChat.mock.calls[0];

    // System prompt should mention canonical columns
    expect(systemPrompt).toContain('supplier_name');
    expect(systemPrompt).toContain('spend_amount');

    // User prompt should contain column headers and sample data
    expect(userPrompt).toContain('Vendor Name');
    expect(userPrompt).toContain('Acme Corp');

    // Options should specify model and temperature
    expect(options).toEqual({
      model: 'claude-3-5-haiku-latest',
      temperature: 0,
      maxTokens: 4096,
    });
  });

  it('should return empty result for empty columns array', async () => {
    const result = await suggestMappings([], []);

    expect(mockChat).not.toHaveBeenCalled();
    expect(result.mappings).toEqual({});
    expect(result.confidence).toBe('low');
    expect(result.unmappedCanonicalColumns).toHaveLength(14);
    expect(result.reasoning).toBe('No columns provided.');
  });

  it('should propagate LLM client errors', async () => {
    mockChat.mockRejectedValueOnce(new Error('API key missing'));

    await expect(suggestMappings(SAMPLE_COLUMNS, SAMPLE_DATA)).rejects.toThrow(
      'API key missing'
    );
  });

  it('should handle LLM response with markdown-wrapped JSON', async () => {
    const wrappedResponse = '```json\n' + MOCK_LLM_RESPONSE + '\n```';
    mockChat.mockResolvedValueOnce(wrappedResponse);

    const result = await suggestMappings(SAMPLE_COLUMNS, SAMPLE_DATA);

    expect(result.mappings.supplier_name).toBe('Vendor Name');
    expect(result.confidence).toBe('high');
  });

  it('should handle medium confidence results', async () => {
    const mediumResponse = JSON.stringify({
      mappings: {
        supplier_name: 'Vendor Name',
        spend_amount: 'Invoice Amount',
      },
      confidence: 'medium',
      unmappedClientColumns: ['Description', 'GL Account', 'Invoice Date', 'Department', 'PO Number', 'Notes'],
      importantUnmappedColumns: ['Description', 'GL Account'],
      unmappedCanonicalColumns: [
        'line_description',
        'gl_description',
        'gl_code',
        'invoice_date',
        'creation_date',
        'department',
        'company',
        'cost_center',
        'po_number',
        'supplier_address',
        'currency',
        'memo',
      ],
      reasoning: 'Only supplier and amount columns are clearly identifiable.',
    });
    mockChat.mockResolvedValueOnce(mediumResponse);

    const result = await suggestMappings(SAMPLE_COLUMNS, SAMPLE_DATA);

    expect(result.confidence).toBe('medium');
    expect(Object.keys(result.mappings)).toHaveLength(2);
    expect(result.importantUnmappedColumns).toContain('Description');
    expect(result.importantUnmappedColumns).toContain('GL Account');
  });
});
