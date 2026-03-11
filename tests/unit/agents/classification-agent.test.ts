import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseResponse,
  validateL1,
  validateDepth,
  findClosestTaxonomyMatch,
  validateClassification,
  formatTaxonomyTree,
  formatSupplierResearch,
  formatTransactions,
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
    expect(prompt).toContain('Weight earlier fields');
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
    expect(prompt).toContain('Industrial Goods');
    expect(prompt).toContain('Steel production');
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

  it('should match by L1 prefix when L2 differs', () => {
    const result = findClosestTaxonomyMatch('Exempt|Unknown|Something', SAMPLE_TAXONOMY);
    // Should find any depth-3 node under Exempt
    expect(result).toMatch(/^Exempt\|/);
  });

  it('should return original path when no match found', () => {
    const result = findClosestTaxonomyMatch('Unknown|Category|Path', SAMPLE_TAXONOMY);
    expect(result).toBe('Unknown|Category|Path');
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

  beforeEach(() => {
    mockLLM = { chat: vi.fn() };
    agent = new LLMClassificationAgent(mockLLM);
  });

  it('should call LLM client and return validated result', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    const result = await agent.classifyInvoiceGroup(makeInput());

    expect(mockLLM.chat).toHaveBeenCalledOnce();
    expect(result.classifications).toHaveLength(1);
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    expect(result.assignments).toEqual({ '1': [1, 2] });
  });

  it('should pass maxTokens=2048 to LLM client', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await agent.classifyInvoiceGroup(makeInput());

    const [, , options] = vi.mocked(mockLLM.chat).mock.calls[0];
    expect(options).toEqual({
      temperature: 0,
      maxTokens: 2048,
    });
  });

  it('should include all required sections in prompts', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await agent.classifyInvoiceGroup(makeInput());

    const [systemPrompt, userPrompt] = vi.mocked(mockLLM.chat).mock.calls[0];

    // System prompt requirements
    expect(systemPrompt).toContain('exactly 3 levels');
    expect(systemPrompt).toContain('priority order');

    // User prompt requirements
    expect(userPrompt).toContain('## Taxonomy');
    expect(userPrompt).toContain('## Company Context');
    expect(userPrompt).toContain('## Supplier Research');
    expect(userPrompt).toContain('## Transactions');
    // No historical classifications in new format
    expect(userPrompt).not.toContain('## Historical Classifications');
  });

  it('should return default classification for empty transactions', async () => {
    const result = await agent.classifyInvoiceGroup(makeInput({ transactions: [] }));

    expect(mockLLM.chat).not.toHaveBeenCalled();
    expect(result.classifications).toHaveLength(1);
    expect(result.classifications[0].classificationPath).toBe('Indirect|Uncategorized|Uncategorized');
    expect(result.assignments).toEqual({});
  });

  it('should validate and fix L1 in LLM response', async () => {
    const badL1Response = JSON.stringify({
      classifications: [{ id: 1, classificationPath: 'indirect|IT Services|Software Licenses' }],
      assignments: { '1': [1] },
    });
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(badL1Response);

    const result = await agent.classifyInvoiceGroup(makeInput());
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should validate and fix depth in LLM response', async () => {
    const deepResponse = JSON.stringify({
      classifications: [{ id: 1, classificationPath: 'Indirect|IT Services|Software Licenses|Enterprise' }],
      assignments: { '1': [1] },
    });
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(deepResponse);

    const result = await agent.classifyInvoiceGroup(makeInput());
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    expect(result.classifications[0].classificationPath.split('|')).toHaveLength(3);
  });

  it('should find closest taxonomy match for unknown paths', async () => {
    const unknownPathResponse = JSON.stringify({
      classifications: [{ id: 1, classificationPath: 'Indirect|IT Services|Unknown Stuff' }],
      assignments: { '1': [1] },
    });
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(unknownPathResponse);

    const result = await agent.classifyInvoiceGroup(makeInput());
    // Should find a match under Indirect|IT Services
    expect(result.classifications[0].classificationPath).toMatch(/^Indirect\|IT Services\|/);
    expect(SAMPLE_TAXONOMY.some((n) => n.fullPath === result.classifications[0].classificationPath)).toBe(true);
  });

  it('should propagate LLM client errors', async () => {
    vi.mocked(mockLLM.chat).mockRejectedValueOnce(new Error('API timeout'));

    await expect(agent.classifyInvoiceGroup(makeInput())).rejects.toThrow('API timeout');
  });

  it('should handle LLM response with markdown-wrapped JSON', async () => {
    const wrapped = '```json\n' + MOCK_LLM_RESPONSE + '\n```';
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(wrapped);

    const result = await agent.classifyInvoiceGroup(makeInput());
    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
  });

  it('should handle classification with null supplier research', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    const result = await agent.classifyInvoiceGroup(makeInput({ supplierResearch: null }));

    expect(result.classifications[0].classificationPath).toBe('Indirect|IT Services|Software Licenses');
    const [, userPrompt] = vi.mocked(mockLLM.chat).mock.calls[0];
    expect(userPrompt).toContain('No supplier research available');
  });

  it('should include supplier research fields in user prompt', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await agent.classifyInvoiceGroup(makeInput());

    const [, userPrompt] = vi.mocked(mockLLM.chat).mock.calls[0];
    expect(userPrompt).toContain('Business Name: TechSoft Inc');
    expect(userPrompt).toContain('Industry: Technology');
    expect(userPrompt).toContain('Products/Services: ERP software, cloud services');
  });

  it('should include company context fields in user prompt', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValueOnce(MOCK_LLM_RESPONSE);

    await agent.classifyInvoiceGroup(makeInput());

    const [, userPrompt] = vi.mocked(mockLLM.chat).mock.calls[0];
    expect(userPrompt).toContain('Industry: Manufacturing');
    expect(userPrompt).toContain('Sector: Industrial Goods');
    expect(userPrompt).toContain('Business Focus: Steel production');
    expect(userPrompt).toContain('Procurement Nuances:');
  });
});
