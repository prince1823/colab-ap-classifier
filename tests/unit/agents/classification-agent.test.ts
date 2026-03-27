import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseResponse,
  normalizePath,
  validateL1,
  validateDepth,
  findClosestTaxonomyMatch,
  validateClassification,
  formatTaxonomyTree,
  formatSupplierResearch,
  formatTransactions,
  buildCategorySelectionSystemPrompt,
  buildCategorySelectionUserPrompt,
  parseCategorySelectionResponse,
  buildL3ClassificationSystemPrompt,
  buildL3ClassificationUserPrompt,
  formatL1L2Taxonomy,
  validateCategoryPath,
  buildTailSpendCategorySelectionSystemPrompt,
  buildTailSpendCategorySelectionUserPrompt,
  buildTailSpendL3SystemPrompt,
  buildTailSpendL3UserPrompt,
  parseTailSpendL3Response,
  LLMClassificationAgent,
} from '../../../src/main/agents/classification-agent';
import type {
  ClassificationInput,
  ClassificationResult,
} from '../../../src/shared/types/classification';
import type { TaxonomyNode } from '../../../src/shared/types/taxonomy';
import type { CompanyContext } from '../../../src/shared/types/project';
import type { SupplierInfo } from '../../../src/shared/types/suppliers';
import type { LLMClient } from '../../../src/shared/types/services';

// --- Test fixtures ---

function makeTaxonomyNode(overrides: Partial<TaxonomyNode> & { fullPath: string }): TaxonomyNode {
  const parts = overrides.fullPath.split('|');
  return {
    id: overrides.id ?? `node-${overrides.fullPath.replace(/\|/g, '-').toLowerCase()}`,
    fullPath: overrides.fullPath,
    l1: overrides.l1 ?? parts[0],
    l2: overrides.l2 ?? (parts[1] ?? null),
    l3: overrides.l3 ?? (parts[2] ?? null),
    depth: overrides.depth ?? parts.length,
    description: overrides.description ?? null,
    parentPath: overrides.parentPath ?? (parts.length > 1 ? parts.slice(0, -1).join('|') : null),
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
  };
}

const SAMPLE_TAXONOMY: TaxonomyNode[] = [
  makeTaxonomyNode({ fullPath: 'Direct', depth: 1, l2: null, l3: null, parentPath: null }),
  makeTaxonomyNode({ fullPath: 'Direct|Raw Materials', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Direct|Raw Materials|Steel', depth: 3, description: 'Steel and metal products' }),
  makeTaxonomyNode({ fullPath: 'Direct|Raw Materials|Chemicals', depth: 3, description: 'Chemical supplies' }),
  makeTaxonomyNode({ fullPath: 'Indirect', depth: 1, l2: null, l3: null, parentPath: null }),
  makeTaxonomyNode({ fullPath: 'Indirect|IT Services', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Indirect|IT Services|Software Licenses', depth: 3, description: 'Software license costs' }),
  makeTaxonomyNode({ fullPath: 'Indirect|IT Services|Cloud Hosting', depth: 3, description: 'Cloud infrastructure' }),
  makeTaxonomyNode({ fullPath: 'Indirect|Office Supplies', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Indirect|Office Supplies|Paper', depth: 3, description: 'Paper products' }),
  makeTaxonomyNode({ fullPath: 'Indirect|Facilities', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Indirect|Facilities|Cleaning', depth: 3, description: 'Cleaning services' }),
  makeTaxonomyNode({ fullPath: 'Exempt', depth: 1, l2: null, l3: null, parentPath: null }),
  makeTaxonomyNode({ fullPath: 'Exempt|Intercompany', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Exempt|Intercompany|Transfers', depth: 3, description: 'Intercompany transfers' }),
  makeTaxonomyNode({ fullPath: 'Exempt|Taxes', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Exempt|Taxes|Sales Tax', depth: 3, description: 'Sales tax payments' }),
];

const SAMPLE_COMPANY_CONTEXT: CompanyContext = {
  industry: 'Manufacturing',
  sector: 'Industrial Goods',
  description: 'Large-scale steel manufacturer',
  businessFocus: 'Steel production and distribution',
  procurementNuances: 'Heavy raw material purchasing, large logistics spend',
};

const SAMPLE_SUPPLIER_RESEARCH: SupplierInfo = {
  officialBusinessName: 'TechSoft Inc',
  description: 'Enterprise software company',
  industry: 'Technology',
  productsServices: 'ERP software, cloud services',
  serviceType: 'Software',
  naicsCode: '511210',
  naicsDescription: 'Software Publishers',
  websiteUrl: 'https://techsoft.example.com',
};

const SAMPLE_TRANSACTIONS: Array<Record<string, unknown>> = [
  {
    supplier_name: 'TechSoft Inc',
    line_description: 'Annual ERP license renewal',
    spend_amount: 50000,
    gl_code: '6200-100',
    invoice_date: '2024-03-15',
  },
  {
    supplier_name: 'TechSoft Inc',
    line_description: 'Cloud hosting fees - March',
    spend_amount: 12000,
    gl_code: '6200-200',
    invoice_date: '2024-03-15',
  },
];

const SAMPLE_COLUMN_PRIORITIES = ['supplier_name', 'line_description', 'spend_amount', 'gl_code', 'invoice_date'];

function makeInput(overrides?: Partial<ClassificationInput>): ClassificationInput {
  return {
    transactions: overrides?.transactions ?? SAMPLE_TRANSACTIONS,
    taxonomy: overrides?.taxonomy ?? SAMPLE_TAXONOMY,
    companyContext: overrides?.companyContext ?? SAMPLE_COMPANY_CONTEXT,
    supplierResearch:
      overrides && 'supplierResearch' in overrides
        ? overrides.supplierResearch ?? null
        : SAMPLE_SUPPLIER_RESEARCH,
    parentName: overrides?.parentName ?? undefined,
    columnPriorities: overrides?.columnPriorities ?? SAMPLE_COLUMN_PRIORITIES,
  };
}

const MOCK_LLM_RESPONSE = JSON.stringify({
  classifications: [{ id: 1, classificationPath: 'Indirect|IT Services|Software Licenses' }],
  assignments: { '1': [1, 2] },
});

beforeEach(() => {
  vi.clearAllMocks();
});

// --- buildSystemPrompt ---

describe('buildSystemPrompt', () => {
  it('should require depth 3 classification', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('exactly 3 levels');
    expect(prompt).toContain('L1|L2|L3');
  });

  it('should mention priority-order field weighting', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('priority order');
  });

  it('should not hardcode specific column priorities', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain('GL Code: VERY LOW priority');
    expect(prompt).not.toContain('USE TRANSACTION AMOUNT');
    expect(prompt).not.toContain('USE PO NUMBER');
    expect(prompt).not.toContain('USE COST CENTER');
    expect(prompt).not.toContain('GL code only as last resort');
  });

  it('should not contain outdated invoice-level classification section', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain('Invoice-Level Classification');
    expect(prompt).not.toContain('Return JSON list');
  });

  it('should include new response format keywords', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('classifications');
    expect(prompt).toContain('assignments');
    // Should not ask for descriptionSupplierAligned in response format
    expect(prompt).not.toContain('"descriptionSupplierAligned"');
  });
});

// --- buildUserPrompt ---

describe('buildUserPrompt', () => {
  it('should include taxonomy tree', () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).toContain('## Taxonomy');
    expect(prompt).toContain('Indirect|IT Services|Software Licenses');
    expect(prompt).toContain('Direct|Raw Materials|Steel');
  });

  it('should include company context', () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).toContain('## Company Context');
    expect(prompt).toContain('Manufacturing');
    expect(prompt).toContain('Large-scale steel manufacturer');
  });

  it('should include supplier research', () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).toContain('## Supplier Research');
    expect(prompt).toContain('TechSoft Inc');
    expect(prompt).toContain('Enterprise software');
    expect(prompt).toContain('511210');
  });

  it('should not include historical classifications section', () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).not.toContain('## Historical Classifications');
  });

  it('should include transaction details', () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).toContain('## Transactions');
    expect(prompt).toContain('Annual ERP license renewal');
    expect(prompt).toContain('50000');
    expect(prompt).toContain('Cloud hosting fees');
  });

  it('should include required sections for full prompt', () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).toContain('## Taxonomy');
    expect(prompt).toContain('## Company Context');
    expect(prompt).toContain('## Supplier Research');
    expect(prompt).toContain('## Transactions');
  });

  it('should handle null supplier research', () => {
    const prompt = buildUserPrompt(makeInput({ supplierResearch: null }));
    expect(prompt).toContain('No supplier research available');
  });

  it('should handle empty transactions', () => {
    const prompt = buildUserPrompt(makeInput({ transactions: [] }));
    expect(prompt).toContain('No transactions provided');
  });

  it('should include parent company name in prompt when parentName is provided', () => {
    const prompt = buildUserPrompt(makeInput({ parentName: 'General Electric' }));
    expect(prompt).toContain('Parent Company: General Electric');
  });

  it('should not include parent company in prompt when parentName is null', () => {
    const prompt = buildUserPrompt(makeInput({ parentName: null }));
    expect(prompt).not.toContain('Parent Company');
  });

  it('should include column priority and dedup note when columnPriorities is set', () => {
    const prompt = buildUserPrompt(makeInput({ columnPriorities: ['supplier_name', 'spend_amount'] }));
    expect(prompt).toContain('classification priority');
    expect(prompt).toContain('Identical rows are grouped');
  });

  it('should not include column priority note when columnPriorities is empty', () => {
    const prompt = buildUserPrompt(makeInput({ columnPriorities: [] }));
    expect(prompt).not.toContain('classification priority');
  });
});

// --- formatTaxonomyTree ---

describe('formatTaxonomyTree', () => {
  it('should only show depth-3 nodes', () => {
    const result = formatTaxonomyTree(SAMPLE_TAXONOMY);
    // Depth-3 nodes should be present
    expect(result).toContain('Direct|Raw Materials|Steel');
    expect(result).toContain('Indirect|IT Services|Software Licenses');
    // Depth-1 and depth-2 only nodes should not be on their own lines
    expect(result).not.toMatch(/^\s*Direct$/m);
    expect(result).not.toMatch(/^\s*Indirect\|IT Services$/m);
  });

  it('should include descriptions when available', () => {
    const result = formatTaxonomyTree(SAMPLE_TAXONOMY);
    expect(result).toContain('Steel and metal products');
    expect(result).toContain('Software license costs');
  });

  it('should handle empty taxonomy', () => {
    const result = formatTaxonomyTree([]);
    expect(result).toContain('No taxonomy provided');
  });

  it('should fallback to all nodes if no depth-3 nodes exist', () => {
    const shallowTaxonomy: TaxonomyNode[] = [
      makeTaxonomyNode({ fullPath: 'Direct', depth: 1, l2: null, l3: null, parentPath: null }),
      makeTaxonomyNode({ fullPath: 'Indirect', depth: 1, l2: null, l3: null, parentPath: null }),
    ];
    const result = formatTaxonomyTree(shallowTaxonomy);
    expect(result).toContain('Direct');
    expect(result).toContain('Indirect');
  });
});

// --- formatSupplierResearch ---

describe('formatSupplierResearch', () => {
  it('should format all supplier fields', () => {
    const result = formatSupplierResearch(SAMPLE_SUPPLIER_RESEARCH);
    expect(result).toContain('Business Name: TechSoft Inc');
    expect(result).toContain('Description: Enterprise software company');
    expect(result).toContain('Industry: Technology');
    expect(result).toContain('Products/Services: ERP software, cloud services');
    expect(result).toContain('NAICS Code: 511210');
    expect(result).toContain('Website: https://techsoft.example.com');
  });

  it('should handle null supplier', () => {
    const result = formatSupplierResearch(null);
    expect(result).toContain('No supplier research available');
  });

  it('should handle empty supplier object', () => {
    const result = formatSupplierResearch({});
    expect(result).toContain('No supplier research available');
  });

  it('should include parent company name when parentName is provided', () => {
    const result = formatSupplierResearch(SAMPLE_SUPPLIER_RESEARCH, 'General Electric');
    expect(result).toContain('Parent Company: General Electric');
  });

  it('should not include parent company line when parentName is null', () => {
    const result = formatSupplierResearch(SAMPLE_SUPPLIER_RESEARCH, null);
    expect(result).not.toContain('Parent Company');
  });
});

// --- formatTransactions ---

describe('formatTransactions', () => {
  it('should format transaction fields', () => {
    const result = formatTransactions(SAMPLE_TRANSACTIONS);
    expect(result).toContain('Transaction 1:');
    expect(result).toContain('supplier_name: TechSoft Inc');
    expect(result).toContain('spend_amount: 50000');
    expect(result).toContain('Transaction 2:');
    expect(result).toContain('Cloud hosting fees');
  });

  it('should skip null, undefined, and empty string values', () => {
    const txns = [{ name: 'test', empty: '', nothing: null, undef: undefined, zero: 0 }];
    const result = formatTransactions(txns);
    expect(result).toContain('name: test');
    expect(result).toContain('zero: 0');
    expect(result).not.toContain('empty:');
    expect(result).not.toContain('nothing:');
    expect(result).not.toContain('undef:');
  });

  it('should handle empty array', () => {
    const result = formatTransactions([]);
    expect(result).toContain('No transactions provided');
  });

  it('should filter and order by column priorities when provided', () => {
    const txns = [
      { supplier_name: 'Acme', gl_code: '1234', spend_amount: 500, department: 'IT', memo: 'test note' },
    ];
    const result = formatTransactions(txns, ['spend_amount', 'supplier_name']);
    // Only priority columns should appear, in priority order
    expect(result).toContain('spend_amount: 500');
    expect(result).toContain('supplier_name: Acme');
    expect(result).not.toContain('gl_code');
    expect(result).not.toContain('department');
    expect(result).not.toContain('memo');
    // spend_amount should appear before supplier_name (priority order)
    const spendIdx = result.indexOf('spend_amount');
    const supplierIdx = result.indexOf('supplier_name');
    expect(spendIdx).toBeLessThan(supplierIdx);
  });

  it('should skip null/empty values even with column priorities', () => {
    const txns = [
      { supplier_name: 'Acme', line_description: '', spend_amount: null },
    ];
    const result = formatTransactions(txns, ['supplier_name', 'line_description', 'spend_amount']);
    expect(result).toContain('supplier_name: Acme');
    expect(result).not.toContain('line_description');
    expect(result).not.toContain('spend_amount');
  });

  it('should fall back to all columns when columnPriorities is undefined', () => {
    const txns = [{ supplier_name: 'Acme', gl_code: '1234', spend_amount: 500 }];
    const result = formatTransactions(txns);
    expect(result).toContain('Transaction 1:');
    expect(result).toContain('supplier_name: Acme');
    expect(result).toContain('gl_code: 1234');
    expect(result).toContain('spend_amount: 500');
  });

  it('should fall back to all columns when columnPriorities is empty', () => {
    const txns = [{ supplier_name: 'Acme', gl_code: '1234' }];
    const result = formatTransactions(txns, []);
    expect(result).toContain('Transaction 1:');
    expect(result).toContain('supplier_name: Acme');
    expect(result).toContain('gl_code: 1234');
  });

  it('should deduplicate identical rows when columnPriorities is provided', () => {
    const txns = [
      { supplier_name: 'Acme', line_description: 'License', spend_amount: 500 },
      { supplier_name: 'Acme', line_description: 'License', spend_amount: 500 },
      { supplier_name: 'Acme', line_description: 'License', spend_amount: 500 },
    ];
    const result = formatTransactions(txns, ['supplier_name', 'line_description', 'spend_amount']);
    expect(result).toContain('Group 1 (3 rows):');
    expect(result).toContain('supplier_name: Acme');
    expect(result).toContain('line_description: License');
    // Should not have multiple groups for identical rows
    expect(result).not.toContain('Group 2');
  });

  it('should keep different rows as separate groups', () => {
    const txns = [
      { supplier_name: 'Acme', spend_amount: 500 },
      { supplier_name: 'Acme', spend_amount: 500 },
      { supplier_name: 'Acme', spend_amount: 1200 },
    ];
    const result = formatTransactions(txns, ['supplier_name', 'spend_amount']);
    expect(result).toContain('Group 1 (2 rows):');
    expect(result).toContain('Group 2 (1 row):');
    expect(result).toContain('spend_amount: 500');
    expect(result).toContain('spend_amount: 1200');
  });

  it('should show singular row label for single-row groups', () => {
    const txns = [
      { supplier_name: 'Acme', spend_amount: 100 },
    ];
    const result = formatTransactions(txns, ['supplier_name', 'spend_amount']);
    expect(result).toContain('Group 1 (1 row):');
  });

  it('should not deduplicate when columnPriorities is not provided', () => {
    const txns = [
      { supplier_name: 'Acme', spend_amount: 500 },
      { supplier_name: 'Acme', spend_amount: 500 },
    ];
    const result = formatTransactions(txns);
    expect(result).toContain('Transaction 1:');
    expect(result).toContain('Transaction 2:');
    expect(result).not.toContain('Group');
  });

  it('should use Group format with column priorities', () => {
    const txns = [
      { supplier_name: 'Acme', spend_amount: 500 },
    ];
    const result = formatTransactions(txns, ['supplier_name', 'spend_amount']);
    expect(result).toContain('Group 1');
    expect(result).not.toContain('Transaction 1');
  });
});

// --- parseResponse ---

describe('parseResponse', () => {
  it('should parse a valid multi-classification response', () => {
    const result = parseResponse(MOCK_LLM_RESPONSE);
    expect(result.classifications).toHaveLength(1);
    expect(result.classifications[0].id).toBe(1);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    expect(result.assignments).toEqual({ '1': [1, 2] });
  });

  it('should parse a response with multiple classifications', () => {
    const response = JSON.stringify({
      classifications: [
        { id: 1, classificationPath: 'Indirect|IT Services|Software Licenses' },
        { id: 2, classificationPath: 'Indirect|IT Services|Cloud Hosting' },
      ],
      assignments: { '1': [1, 2], '2': [3] },
    });
    const result = parseResponse(response);
    expect(result.classifications).toHaveLength(2);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    expect(result.classifications[1].classificationPath).toBe('Indirect|IT Services|Cloud Hosting');
    expect(result.assignments['1']).toEqual([1, 2]);
    expect(result.assignments['2']).toEqual([3]);
  });

  it('should handle markdown code fences', () => {
    const wrapped = '```json\n' + MOCK_LLM_RESPONSE + '\n```';
    const result = parseResponse(wrapped);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should handle code fences without language tag', () => {
    const wrapped = '```\n' + MOCK_LLM_RESPONSE + '\n```';
    const result = parseResponse(wrapped);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should throw when response is not valid JSON', () => {
    expect(() => parseResponse('not json at all')).toThrow(
      'Failed to parse classification response as JSON'
    );
  });

  it('should throw when classifications array is missing', () => {
    const response = JSON.stringify({ assignments: { '1': [1] } });
    expect(() => parseResponse(response)).toThrow(
      'Expected "classifications" array'
    );
  });

  it('should throw when assignments is missing', () => {
    const response = JSON.stringify({
      classifications: [{ id: 1, classificationPath: 'A|B|C' }],
    });
    expect(() => parseResponse(response)).toThrow(
      'Expected "assignments" object'
    );
  });

  it('should unwrap single-element array classificationPath', () => {
    const response = JSON.stringify({
      classifications: [{ id: 1, classificationPath: ['Indirect|IT Services|Software Licenses'] }],
      assignments: { '1': [1] },
    });
    const result = parseResponse(response);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should handle alternative field names (classification_path)', () => {
    const response = JSON.stringify({
      classifications: [{ id: 1, classification_path: 'Indirect|IT Services|Software Licenses' }],
      assignments: { '1': [1] },
    });
    const result = parseResponse(response);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should throw when classificationPath is missing from entry', () => {
    const response = JSON.stringify({
      classifications: [{ id: 1 }],
      assignments: { '1': [1] },
    });
    expect(() => parseResponse(response)).toThrow(
      'Classification entry 0 missing classificationPath'
    );
  });
});

// --- validateL1 ---

describe('validateL1', () => {
  it('should accept valid L1 values from taxonomy', () => {
    expect(validateL1('Direct|Raw Materials|Steel', SAMPLE_TAXONOMY)).toBe('Direct|Raw Materials|Steel');
    expect(validateL1('Indirect|IT Services|Software', SAMPLE_TAXONOMY)).toBe('Indirect|IT Services|Software');
    expect(validateL1('Exempt|Taxes|Sales Tax', SAMPLE_TAXONOMY)).toBe('Exempt|Taxes|Sales Tax');
  });

  it('should fix case-insensitive L1 values', () => {
    expect(validateL1('direct|Raw Materials|Steel', SAMPLE_TAXONOMY)).toBe('Direct|Raw Materials|Steel');
    expect(validateL1('INDIRECT|IT Services|Software', SAMPLE_TAXONOMY)).toBe('Indirect|IT Services|Software');
    expect(validateL1('exempt|Taxes|Sales Tax', SAMPLE_TAXONOMY)).toBe('Exempt|Taxes|Sales Tax');
  });

  it('should return null for L1 values not in taxonomy', () => {
    expect(validateL1('Unknown|Something|Else', SAMPLE_TAXONOMY)).toBeNull();
    expect(validateL1('Services|IT|Software', SAMPLE_TAXONOMY)).toBeNull();
  });

  it('should return null for empty path', () => {
    expect(validateL1('', SAMPLE_TAXONOMY)).toBeNull();
  });
});

// --- validateDepth ---

describe('validateDepth', () => {
  it('should accept depth 3 paths', () => {
    expect(validateDepth('Indirect|IT Services|Software')).toBe('Indirect|IT Services|Software');
  });

  it('should truncate paths deeper than 3', () => {
    expect(validateDepth('Indirect|IT Services|Software|Extra')).toBe('Indirect|IT Services|Software');
    expect(validateDepth('A|B|C|D|E')).toBe('A|B|C');
  });

  it('should return null for paths shallower than 3', () => {
    expect(validateDepth('Indirect|IT Services')).toBeNull();
    expect(validateDepth('Indirect')).toBeNull();
  });

  it('should filter out empty segments', () => {
    expect(validateDepth('Indirect||IT Services|Software')).toBe('Indirect|IT Services|Software');
  });
});

// --- findClosestTaxonomyMatch ---

describe('findClosestTaxonomyMatch', () => {
  it('should return exact match', () => {
    const result = findClosestTaxonomyMatch('Indirect|IT Services|Software Licenses', SAMPLE_TAXONOMY);
    expect(result).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should return case-insensitive match', () => {
    const result = findClosestTaxonomyMatch('indirect|it services|software licenses', SAMPLE_TAXONOMY);
    expect(result).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should match by L1|L2 prefix when L3 differs', () => {
    const result = findClosestTaxonomyMatch('Indirect|IT Services|Unknown Category', SAMPLE_TAXONOMY);
    // Should find any depth-3 node under Indirect|IT Services
    expect(result).toMatch(/^Indirect\|IT Services\|/);
  });

  it('should return original path when L1 does not match', () => {
    const result = findClosestTaxonomyMatch('Exempt|Unknown|Something', SAMPLE_TAXONOMY);
    expect(result).toBe('Exempt|Unknown|Something');
  });

  it('should return original path when no match found', () => {
    const result = findClosestTaxonomyMatch('Unknown|Category|Path', SAMPLE_TAXONOMY);
    expect(result).toBe('Unknown|Category|Path');
  });
});

// --- normalizePath ---

describe('normalizePath', () => {
  it('lowercases', () => {
    expect(normalizePath('Non-Clinical')).toBe('non clinical');
  });

  it('replaces hyphens with spaces', () => {
    expect(normalizePath('non-clinical')).toBe('non clinical');
  });

  it('replaces en-dash and em-dash with spaces', () => {
    expect(normalizePath('non–clinical')).toBe('non clinical');
    expect(normalizePath('non—clinical')).toBe('non clinical');
  });

  it('normalizes & to and', () => {
    expect(normalizePath('IT Product & Services')).toBe('it product and services');
  });

  it('collapses multiple spaces', () => {
    expect(normalizePath('foo  bar')).toBe('foo bar');
  });

  it('handles full pipe-delimited paths', () => {
    expect(normalizePath('Non-Clinical|IT Product & Services|General Software')).toBe(
      'non clinical|it product and services|general software'
    );
  });
});

// --- normalizePath matching in validateL1 and findClosestTaxonomyMatch ---

const PUNCTUATION_TAXONOMY: TaxonomyNode[] = [
  makeTaxonomyNode({ fullPath: 'Non-Clinical', depth: 1, l2: null, l3: null, parentPath: null }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|Professional Services', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|Professional Services|Financial Services', depth: 3 }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|IT Product & Services', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|IT Product & Services|General Software', depth: 3 }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|MRO Supplies', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|MRO Supplies|Janitorial & Cleaning Supplies', depth: 3 }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|General & Administrative', depth: 2, l3: null }),
  makeTaxonomyNode({ fullPath: 'Non-Clinical|General & Administrative|Office Supplies & Equipment', depth: 3 }),
];

describe('validateL1 normalized matching', () => {
  it('fixes "non-clinical" (no dash) to "Non-Clinical" via normalization', () => {
    // LLM returns lowercase no-hyphen; taxonomy has "Non-Clinical"
    // Both normalize to "non clinical" so it should match
    const result = validateL1('non clinical|Professional Services|Financial Services', PUNCTUATION_TAXONOMY);
    expect(result).toBe('Non-Clinical|Professional Services|Financial Services');
  });
});

describe('findClosestTaxonomyMatch normalized matching', () => {
  it('matches path with missing hyphens via normalization', () => {
    const result = findClosestTaxonomyMatch(
      'non-clinical|professional services|financial services',
      PUNCTUATION_TAXONOMY
    );
    expect(result).toBe('Non-Clinical|Professional Services|Financial Services');
  });

  it('matches path with & vs "and" difference via normalization', () => {
    const result = findClosestTaxonomyMatch(
      'non-clinical|it product and services|general software',
      PUNCTUATION_TAXONOMY
    );
    expect(result).toBe('Non-Clinical|IT Product & Services|General Software');
  });

  it('matches via normalized L1|L2 prefix when L3 differs by punctuation', () => {
    const result = findClosestTaxonomyMatch(
      'non-clinical|it product and services|unknown l3',
      PUNCTUATION_TAXONOMY
    );
    expect(result).toBe('Non-Clinical|IT Product & Services|General Software');
  });

  it('returns original path when nothing matches even after normalization', () => {
    const result = findClosestTaxonomyMatch(
      'non-clinical|completely unknown|category',
      PUNCTUATION_TAXONOMY
    );
    expect(result).toBe('non-clinical|completely unknown|category');
  });

  // Real issue #214 scenario: taxonomy uses spaces (no hyphens), LLM returns hyphens.
  // Case-insensitive match does NOT catch this — only normalization does.
  it('matches hyphenated LLM path against space-separated taxonomy node (issue #214)', () => {
    const taxonomyWithSpaces: TaxonomyNode[] = [
      makeTaxonomyNode({ fullPath: 'Non Clinical', depth: 1, l2: null, l3: null, parentPath: null }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|Professional Services', depth: 2, l3: null }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|Professional Services|Financial Services', depth: 3 }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|IT Product & Services', depth: 2, l3: null }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|IT Product & Services|General Software', depth: 3 }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|MRO Supplies', depth: 2, l3: null }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|MRO Supplies|Janitorial & Cleaning Supplies', depth: 3 }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|General & Administrative', depth: 2, l3: null }),
      makeTaxonomyNode({ fullPath: 'Non Clinical|General & Administrative|Office Supplies & Equipment', depth: 3 }),
    ];

    // Exact log lines from issue #214
    expect(findClosestTaxonomyMatch('non-clinical|professional services|financial services', taxonomyWithSpaces))
      .toBe('Non Clinical|Professional Services|Financial Services');
    expect(findClosestTaxonomyMatch('non-clinical|it product & services|general software', taxonomyWithSpaces))
      .toBe('Non Clinical|IT Product & Services|General Software');
    expect(findClosestTaxonomyMatch('non-clinical|mro supplies|janitorial & cleaning supplies', taxonomyWithSpaces))
      .toBe('Non Clinical|MRO Supplies|Janitorial & Cleaning Supplies');
    expect(findClosestTaxonomyMatch('non-clinical|general & administrative|office supplies & equipment', taxonomyWithSpaces))
      .toBe('Non Clinical|General & Administrative|Office Supplies & Equipment');
  });
});

// --- validateClassification end-to-end (issue #214 paths) ---

describe('validateClassification issue #214 paths', () => {
  const taxonomyWithSpaces: TaxonomyNode[] = [
    makeTaxonomyNode({ fullPath: 'Non Clinical', depth: 1, l2: null, l3: null, parentPath: null }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|Professional Services', depth: 2, l3: null }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|Professional Services|Financial Services', depth: 3 }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|IT Product & Services', depth: 2, l3: null }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|IT Product & Services|General Software', depth: 3 }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|MRO Supplies', depth: 2, l3: null }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|MRO Supplies|Janitorial & Cleaning Supplies', depth: 3 }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|General & Administrative', depth: 2, l3: null }),
    makeTaxonomyNode({ fullPath: 'Non Clinical|General & Administrative|Office Supplies & Equipment', depth: 3 }),
  ];

  it('resolves all four warn-log paths from issue #214 to canonical taxonomy nodes', () => {
    const input: ClassificationResult = {
      classifications: [
        { id: 1, classificationPath: 'non-clinical|professional services|financial services' },
        { id: 2, classificationPath: 'non-clinical|it product & services|general software' },
        { id: 3, classificationPath: 'non-clinical|mro supplies|janitorial & cleaning supplies' },
        { id: 4, classificationPath: 'non-clinical|general & administrative|office supplies & equipment' },
      ],
      assignments: { '1': [1], '2': [2], '3': [3], '4': [4] },
    };

    const result = validateClassification(input, taxonomyWithSpaces);
    expect(result.classifications[0].classificationPath).toBe('Non Clinical|Professional Services|Financial Services');
    expect(result.classifications[1].classificationPath).toBe('Non Clinical|IT Product & Services|General Software');
    expect(result.classifications[2].classificationPath).toBe('Non Clinical|MRO Supplies|Janitorial & Cleaning Supplies');
    expect(result.classifications[3].classificationPath).toBe('Non Clinical|General & Administrative|Office Supplies & Equipment');
  });
});

// --- validateClassification ---

describe('validateClassification', () => {
  it('should pass through a valid classification', () => {
    const input: ClassificationResult = {
      classifications: [{ id: 1, classificationPath: 'Indirect|IT Services|Software Licenses' }],
      assignments: { '1': [1] },
    };
    const result = validateClassification(input, SAMPLE_TAXONOMY);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    expect(result.assignments).toEqual({ '1': [1] });
  });

  it('should validate each classification entry in the array', () => {
    const input: ClassificationResult = {
      classifications: [
        { id: 1, classificationPath: 'indirect|IT Services|Software Licenses' },
        { id: 2, classificationPath: 'Direct|Raw Materials|Steel|Extra' },
      ],
      assignments: { '1': [1], '2': [2] },
    };
    const result = validateClassification(input, SAMPLE_TAXONOMY);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    expect(result.classifications[1].classificationPath).toBe('Direct|Raw Materials|Steel');
  });

  it('should keep path unchanged when L1 is not in taxonomy and no close match exists', () => {
    const input: ClassificationResult = {
      classifications: [{ id: 1, classificationPath: 'Unknown|Services|Software' }],
      assignments: { '1': [1] },
    };
    const result = validateClassification(input, SAMPLE_TAXONOMY);
    // When L1 is invalid and no close taxonomy match, path is returned as-is
    expect(result.classifications[0].classificationPath).toBe('Unknown|Services|Software');
  });

  it('should fix case-insensitive L1', () => {
    const input: ClassificationResult = {
      classifications: [{ id: 1, classificationPath: 'indirect|IT Services|Software Licenses' }],
      assignments: { '1': [1] },
    };
    const result = validateClassification(input, SAMPLE_TAXONOMY);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should truncate path deeper than 3', () => {
    const input: ClassificationResult = {
      classifications: [{ id: 1, classificationPath: 'Indirect|IT Services|Software Licenses|Extra' }],
      assignments: { '1': [1] },
    };
    const result = validateClassification(input, SAMPLE_TAXONOMY);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should attempt to fill in path shallower than 3', () => {
    const input: ClassificationResult = {
      classifications: [{ id: 1, classificationPath: 'Indirect|IT Services' }],
      assignments: { '1': [1] },
    };
    const result = validateClassification(input, SAMPLE_TAXONOMY);
    // Should find a depth-3 node under Indirect|IT Services
    expect(result.classifications[0].classificationPath.split('|')).toHaveLength(3);
    expect(result.classifications[0].classificationPath).toMatch(/^Indirect\|IT Services\|/);
  });

  it('should pad with Uncategorized when depth cannot be resolved from taxonomy', () => {
    const input: ClassificationResult = {
      classifications: [{ id: 1, classificationPath: 'Indirect' }],
      assignments: { '1': [1] },
    };
    // Use empty taxonomy so no match can be found
    const result = validateClassification(input, []);
    expect(result.classifications[0].classificationPath.split('|')).toHaveLength(3);
    expect(result.classifications[0].classificationPath).toContain('Uncategorized');
  });
});

// --- LLMClassificationAgent ---

describe('LLMClassificationAgent', () => {
  let mockLLM: LLMClient;
  let agent: LLMClassificationAgent;

  const CALL1_RESPONSE = JSON.stringify({
    categories: [{ supplierIndex: 1, categoryPath: 'Indirect|IT Services' }],
  });

  beforeEach(() => {
    mockLLM = { chat: vi.fn() };
    agent = new LLMClassificationAgent(mockLLM);
  });

  describe('selectCategories', () => {
    it('should call LLM and return validated category map', async () => {
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(CALL1_RESPONSE);

      const result = await agent.selectCategories({
        suppliers: [{ name: 'TechSoft', research: SAMPLE_SUPPLIER_RESEARCH, parentName: null }],
        taxonomy: SAMPLE_TAXONOMY,
        companyContext: SAMPLE_COMPANY_CONTEXT,
      });

      expect(mockLLM.chat).toHaveBeenCalledOnce();
      expect(result.get(1)).toBe('Indirect|IT Services');
    });

    it('should validate returned paths against taxonomy', async () => {
      const badResponse = JSON.stringify({
        categories: [{ supplierIndex: 1, categoryPath: 'Fake|Category' }],
      });
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(badResponse);

      const result = await agent.selectCategories({
        suppliers: [{ name: 'Test', research: null, parentName: null }],
        taxonomy: SAMPLE_TAXONOMY,
        companyContext: SAMPLE_COMPANY_CONTEXT,
      });

      // Invalid path should not appear in result
      expect(result.has(1)).toBe(false);
    });
  });

  describe('classifyL3', () => {
    it('should classify transactions into L3 under given category', async () => {
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

      const l3Nodes = SAMPLE_TAXONOMY.filter((n) => n.depth === 3 && n.l1 === 'Indirect' && n.l2 === 'IT Services');
      const result = await agent.classifyL3({
        categoryPath: 'Indirect|IT Services',
        l3Taxonomy: l3Nodes,
        transactions: SAMPLE_TRANSACTIONS,
        columnPriorities: SAMPLE_COLUMN_PRIORITIES,
        companyContext: SAMPLE_COMPANY_CONTEXT,
        supplierName: 'TechSoft',
        supplierType: 'company',
      });

      expect(result.classifications).toHaveLength(1);
      expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    });

    it('should throw if no L3 nodes under category', async () => {
      await expect(agent.classifyL3({
        categoryPath: 'Fake|Category',
        l3Taxonomy: [],
        transactions: SAMPLE_TRANSACTIONS,
        columnPriorities: SAMPLE_COLUMN_PRIORITIES,
        companyContext: SAMPLE_COMPANY_CONTEXT,
        supplierName: 'Test',
        supplierType: null,
      })).rejects.toThrow('No L3 nodes found');
    });

    it('should return empty result for empty transactions', async () => {
      const l3Nodes = SAMPLE_TAXONOMY.filter((n) => n.depth === 3 && n.l1 === 'Indirect' && n.l2 === 'IT Services');
      const result = await agent.classifyL3({
        categoryPath: 'Indirect|IT Services',
        l3Taxonomy: l3Nodes,
        transactions: [],
        columnPriorities: [],
        companyContext: SAMPLE_COMPANY_CONTEXT,
        supplierName: 'Test',
        supplierType: null,
      });

      expect(mockLLM.chat).not.toHaveBeenCalled();
      expect(result.assignments).toEqual({});
    });
  });

  describe('classifyTransactionGroup (backward compat)', () => {
    it('should call selectCategories then classifyL3', async () => {
      // Call 1 returns category
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(CALL1_RESPONSE);
      // Call 2 returns classification
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

      const result = await agent.classifyTransactionGroup(makeInput());

      expect(mockLLM.chat).toHaveBeenCalledTimes(2);
      expect(result.classifications).toHaveLength(1);
      expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    });

    it('should return default classification for empty transactions', async () => {
      const result = await agent.classifyTransactionGroup(makeInput({ transactions: [] }));

      expect(mockLLM.chat).not.toHaveBeenCalled();
      expect(result.classifications[0].classificationPath).toBe('Indirect|Uncategorized|Uncategorized');
    });

    it('should fall back to legacy single call if Call 1 returns no category', async () => {
      // Call 1 returns empty map (no valid category)
      const emptyResponse = JSON.stringify({ categories: [{ supplierIndex: 1, categoryPath: 'Fake|Invalid' }] });
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(emptyResponse);
      // Legacy fallback call
      vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

      const result = await agent.classifyTransactionGroup(makeInput());
      expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    });

    it('should propagate LLM client errors', async () => {
      vi.mocked(mockLLM.chat).mockRejectedValueOnce(new Error('API timeout'));

      await expect(agent.classifyTransactionGroup(makeInput())).rejects.toThrow('API timeout');
    });
  });
});

// ─── New 2-call tests ─────────────────────────────────────────────────────────

describe('formatL1L2Taxonomy', () => {
  it('should extract unique L1|L2 paths', () => {
    const result = formatL1L2Taxonomy(SAMPLE_TAXONOMY);
    expect(result).toContain('Direct|Raw Materials');
    expect(result).toContain('Indirect|IT Services');
    expect(result).toContain('Indirect|Office Supplies');
    expect(result).toContain('Exempt|Intercompany');
    // Should not contain L3 paths
    expect(result).not.toContain('Software Licenses');
    expect(result).not.toContain('Steel');
  });

  it('should return "(No taxonomy provided)" for empty', () => {
    expect(formatL1L2Taxonomy([])).toBe('(No taxonomy provided)');
  });
});

describe('buildCategorySelectionSystemPrompt', () => {
  it('should mention L1|L2', () => {
    const prompt = buildCategorySelectionSystemPrompt();
    expect(prompt).toContain('L1|L2');
    expect(prompt).toContain('categories');
  });
});

describe('buildCategorySelectionUserPrompt', () => {
  it('should include L1|L2 taxonomy and supplier info', () => {
    const prompt = buildCategorySelectionUserPrompt({
      suppliers: [
        { name: 'TechSoft', research: SAMPLE_SUPPLIER_RESEARCH, parentName: 'TechParent' },
        { name: 'CleanCo', research: null, parentName: null },
      ],
      taxonomy: SAMPLE_TAXONOMY,
      companyContext: SAMPLE_COMPANY_CONTEXT,
    });
    expect(prompt).toContain('L1|L2 Taxonomy');
    expect(prompt).toContain('Supplier 1: TechSoft');
    expect(prompt).toContain('Supplier 2: CleanCo');
    expect(prompt).toContain('Parent Company: TechParent');
    expect(prompt).toContain('Industry: Manufacturing');
  });
});

describe('parseCategorySelectionResponse', () => {
  it('should parse batched response', () => {
    const text = JSON.stringify({
      categories: [
        { supplierIndex: 1, categoryPath: 'Indirect|IT Services' },
        { supplierIndex: 2, categoryPath: 'Direct|Raw Materials' },
      ],
    });
    const result = parseCategorySelectionResponse(text);
    expect(result.get(1)).toBe('Indirect|IT Services');
    expect(result.get(2)).toBe('Direct|Raw Materials');
  });

  it('should parse single-supplier response', () => {
    const text = JSON.stringify({ categoryPath: 'Indirect|IT Services' });
    const result = parseCategorySelectionResponse(text);
    expect(result.get(1)).toBe('Indirect|IT Services');
  });

  it('should handle markdown fences', () => {
    const text = '```json\n' + JSON.stringify({
      categories: [{ supplierIndex: 1, categoryPath: 'Direct|Raw Materials' }],
    }) + '\n```';
    const result = parseCategorySelectionResponse(text);
    expect(result.get(1)).toBe('Direct|Raw Materials');
  });

  it('should skip entries with missing fields', () => {
    const text = JSON.stringify({
      categories: [
        { supplierIndex: 1, categoryPath: 'Indirect|IT Services' },
        { supplierIndex: 2 },  // missing categoryPath
      ],
    });
    const result = parseCategorySelectionResponse(text);
    expect(result.size).toBe(1);
  });
});

describe('validateCategoryPath', () => {
  it('should validate exact match', () => {
    expect(validateCategoryPath('Indirect|IT Services', SAMPLE_TAXONOMY)).toBe('Indirect|IT Services');
  });

  it('should validate case-insensitive', () => {
    expect(validateCategoryPath('indirect|it services', SAMPLE_TAXONOMY)).toBe('Indirect|IT Services');
  });

  it('should return null for non-existent path', () => {
    expect(validateCategoryPath('Fake|Category', SAMPLE_TAXONOMY)).toBeNull();
  });

  it('should return null for single segment', () => {
    expect(validateCategoryPath('Indirect', SAMPLE_TAXONOMY)).toBeNull();
  });
});

describe('buildL3ClassificationSystemPrompt', () => {
  it('should mention L3 and response format', () => {
    const prompt = buildL3ClassificationSystemPrompt();
    expect(prompt).toContain('L1|L2|L3');
    expect(prompt).toContain('classifications');
    expect(prompt).toContain('assignments');
  });
});

describe('buildL3ClassificationUserPrompt', () => {
  it('should include category branch and filtered taxonomy', () => {
    const l3Nodes = SAMPLE_TAXONOMY.filter((n) => n.depth === 3 && n.l1 === 'Indirect' && n.l2 === 'IT Services');
    const prompt = buildL3ClassificationUserPrompt({
      categoryPath: 'Indirect|IT Services',
      l3Taxonomy: l3Nodes,
      transactions: SAMPLE_TRANSACTIONS,
      columnPriorities: SAMPLE_COLUMN_PRIORITIES,
      companyContext: SAMPLE_COMPANY_CONTEXT,
      supplierName: 'TechSoft Inc',
      supplierType: 'company',
    });
    expect(prompt).toContain('Category Branch: Indirect|IT Services');
    expect(prompt).toContain('Software Licenses');
    expect(prompt).toContain('Cloud Hosting');
    expect(prompt).toContain('TechSoft Inc (company)');
    expect(prompt).not.toContain('Raw Materials');
  });
});

// --- Tail Spend: Category Selection ---

describe('buildTailSpendCategorySelectionSystemPrompt', () => {
  it('should mention tail spend and transaction groups', () => {
    const prompt = buildTailSpendCategorySelectionSystemPrompt();
    expect(prompt).toContain('tail spend');
    expect(prompt).toContain('transaction groups');
    expect(prompt).toContain('L1|L2');
  });

  it('should specify expected response format', () => {
    const prompt = buildTailSpendCategorySelectionSystemPrompt();
    expect(prompt).toContain('"categories"');
    expect(prompt).toContain('"supplierIndex"');
    expect(prompt).toContain('"categoryPath"');
  });
});

describe('buildTailSpendCategorySelectionUserPrompt', () => {
  it('should include supplier groups in prompt', () => {
    const prompt = buildTailSpendCategorySelectionUserPrompt({
      suppliers: [
        {
          name: 'Acme Cleaning',
          groups: [
            { fields: [['gl_description', 'Janitorial services']], count: 4 },
            { fields: [['gl_description', 'Cleaning supplies']], count: 1 },
          ],
        },
      ],
      taxonomy: SAMPLE_TAXONOMY,
      companyContext: SAMPLE_COMPANY_CONTEXT,
    });
    expect(prompt).toContain('Supplier 1: Acme Cleaning');
    expect(prompt).toContain('Group 1 (4 rows)');
    expect(prompt).toContain('gl_description: Janitorial services');
    expect(prompt).toContain('Group 2 (1 row)');
    expect(prompt).toContain('gl_description: Cleaning supplies');
  });

  it('should include taxonomy and company context', () => {
    const prompt = buildTailSpendCategorySelectionUserPrompt({
      suppliers: [{ name: 'Test', groups: [] }],
      taxonomy: SAMPLE_TAXONOMY,
      companyContext: SAMPLE_COMPANY_CONTEXT,
    });
    expect(prompt).toContain('## L1|L2 Taxonomy');
    expect(prompt).toContain('## Company Context');
    expect(prompt).toContain('Manufacturing');
  });
});

// --- Tail Spend: L3 Classification ---

describe('buildTailSpendL3SystemPrompt', () => {
  it('should return one L3 per supplier', () => {
    const prompt = buildTailSpendL3SystemPrompt();
    expect(prompt).toContain('ONE best-fit L3');
    expect(prompt).toContain('L1|L2|L3');
  });

  it('should specify assignments response format', () => {
    const prompt = buildTailSpendL3SystemPrompt();
    expect(prompt).toContain('"assignments"');
    expect(prompt).toContain('"supplierIndex"');
    expect(prompt).toContain('"classificationPath"');
  });
});

describe('buildTailSpendL3UserPrompt', () => {
  it('should include category branch and L3 taxonomy', () => {
    const l3Nodes = SAMPLE_TAXONOMY.filter((n) => n.depth === 3 && n.l1 === 'Indirect' && n.l2 === 'Facilities');
    const prompt = buildTailSpendL3UserPrompt({
      categoryPath: 'Indirect|Facilities',
      l3Taxonomy: l3Nodes,
      suppliers: [
        {
          name: 'City Water Dept',
          groups: [{ fields: [['gl_description', 'Water utility']], count: 2 }],
        },
      ],
      companyContext: SAMPLE_COMPANY_CONTEXT,
    });
    expect(prompt).toContain('Category Branch: Indirect|Facilities');
    expect(prompt).toContain('Cleaning');
    expect(prompt).toContain('Supplier 1: City Water Dept');
    expect(prompt).toContain('gl_description: Water utility');
  });
});

describe('parseTailSpendL3Response', () => {
  it('should parse valid response', () => {
    const response = JSON.stringify({
      assignments: [
        { supplierIndex: 1, classificationPath: 'Indirect|Facilities|Cleaning' },
        { supplierIndex: 2, classificationPath: 'Indirect|Facilities|Cleaning' },
      ],
    });
    const result = parseTailSpendL3Response(response);
    expect(result.size).toBe(2);
    expect(result.get(1)).toBe('Indirect|Facilities|Cleaning');
    expect(result.get(2)).toBe('Indirect|Facilities|Cleaning');
  });

  it('should handle markdown fencing', () => {
    const response = '```json\n{"assignments": [{"supplierIndex": 1, "classificationPath": "L1|L2|L3"}]}\n```';
    const result = parseTailSpendL3Response(response);
    expect(result.size).toBe(1);
    expect(result.get(1)).toBe('L1|L2|L3');
  });

  it('should skip entries with missing path', () => {
    const response = JSON.stringify({
      assignments: [
        { supplierIndex: 1, classificationPath: 'L1|L2|L3' },
        { supplierIndex: 2 },
      ],
    });
    const result = parseTailSpendL3Response(response);
    expect(result.size).toBe(1);
    expect(result.has(2)).toBe(false);
  });

  it('should unwrap single-element array paths', () => {
    const response = JSON.stringify({
      assignments: [{ supplierIndex: 1, classificationPath: ['L1|L2|L3'] }],
    });
    const result = parseTailSpendL3Response(response);
    expect(result.get(1)).toBe('L1|L2|L3');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseTailSpendL3Response('not json')).toThrow();
  });

  it('should throw on missing assignments array', () => {
    expect(() => parseTailSpendL3Response('{"categories": []}')).toThrow('Expected "assignments" array');
  });
});
