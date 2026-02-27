import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import {
  listTaxonomies,
  readTaxonomy,
  readRulePack,
  readSupplierUniverse,
  setColabipBasePath,
  getColabipBasePath,
} from '../../../src/main/services/colabip';

const FIXTURE_PATH = path.join(__dirname, '../../fixtures/colabip');
const NONEXISTENT_PATH = path.join(__dirname, '../../fixtures/nonexistent');

let originalBasePath: string;

beforeAll(() => {
  originalBasePath = getColabipBasePath();
  setColabipBasePath(FIXTURE_PATH);
});

afterAll(() => {
  setColabipBasePath(originalBasePath);
});

describe('listTaxonomies', () => {
  it('should return correct taxonomy names and leaf node counts', async () => {
    const taxonomies = await listTaxonomies();

    expect(taxonomies).toEqual(
      expect.arrayContaining([
        { name: 'healthcare', nodeCount: 58 },
        { name: 'general', nodeCount: 2 },
        { name: 'manufacturing', nodeCount: 14 },
      ])
    );
    expect(taxonomies).toHaveLength(3);
  });

  it('should return empty array when colabip directory does not exist', async () => {
    setColabipBasePath(NONEXISTENT_PATH);
    const taxonomies = await listTaxonomies();
    expect(taxonomies).toEqual([]);
    setColabipBasePath(FIXTURE_PATH);
  });
});

// listRulePacks was removed in v2 — rule import happens via readRulePack() directly.

describe('readTaxonomy', () => {
  it('should parse taxonomy.txt and auto-generate parent nodes', async () => {
    const result = await readTaxonomy('healthcare');

    // Healthcare: 58 leaves + 20 auto-generated parents = 78 total nodes
    expect(result.nodes).toHaveLength(78);

    // Auto-generated parents come first (no descriptions)
    const parents = result.nodes.filter((n) => n.path.split('|').length < 3);
    expect(parents.length).toBe(20);
    parents.forEach((p) => expect(p.description).toBe(''));

    // Leaves have descriptions
    const leaves = result.nodes.filter((n) => n.path.split('|').length === 3);
    expect(leaves.length).toBe(58);
    leaves.forEach((l) => expect(l.description).not.toBe(''));
  });

  it('should include all L1 and L2 parent paths', async () => {
    const result = await readTaxonomy('healthcare');
    const paths = result.nodes.map((n) => n.path);

    // L1 parents
    expect(paths).toContain('Clinical');
    expect(paths).toContain('Non Clinical');
    expect(paths).toContain('Non-Sourceable');

    // L2 parents
    expect(paths).toContain('Clinical|Clinical Equipment');
    expect(paths).toContain('Clinical|Clinical Services');
    expect(paths).toContain('Non Clinical|General & Administrative');
  });

  it('should parse leaf descriptions correctly', async () => {
    const result = await readTaxonomy('healthcare');
    const software = result.nodes.find((n) => n.path === 'Clinical|IT - Clinical|EHR/EMR');
    expect(software).toBeDefined();
    expect(software!.description).toContain('Electronic Health Record');
  });

  it('should not include nodes with empty paths', async () => {
    const result = await readTaxonomy('healthcare');
    const paths = result.nodes.map((n) => n.path);
    expect(paths).not.toContain('');
  });

  it('should return empty nodes for non-existent industry', async () => {
    const result = await readTaxonomy('nonexistent');
    expect(result.nodes).toEqual([]);
  });
});

describe('readRulePack', () => {
  it('should parse rules.csv with correct fields and JSON conditions', async () => {
    const rules = await readRulePack('healthcare');

    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      name: 'GE Healthcare Rule',
      conditions: [
        { field: 'supplier_name', operator: 'contains', value: 'GE Healthcare' },
      ],
      targetPath: 'clinical|clinical equipment|diagnostic imaging',
      priorityScore: 250,
    });
    expect(rules[1]).toEqual({
      name: 'Pharma Rule',
      conditions: [
        { field: 'supplier_name', operator: 'contains', value: 'Pfizer' },
      ],
      targetPath: 'clinical|pharmaceuticals',
      priorityScore: 251,
    });
  });

  it('should return empty array for header-only CSV', async () => {
    const rules = await readRulePack('general');
    expect(rules).toEqual([]);
  });

  it('should return empty array for non-existent industry', async () => {
    const rules = await readRulePack('nonexistent');
    expect(rules).toEqual([]);
  });
});

describe('readSupplierUniverse', () => {
  it('should parse supplier_universe.csv with all fields', async () => {
    const suppliers = await readSupplierUniverse();

    expect(suppliers).toHaveLength(9);

    // First row: basic entry with self-referencing alias
    expect(suppliers[0]).toEqual({
      id: 'sup_9d275eab',
      supplierName: 'com office developers llc',
      aliases: ['com office developers llc'],
      parentId: null,
      parentName: '',
      categoryA: false,
      categoryATaxonomyPath: null,
      supplierInfo: { supplierType: 'company' },
    });

    // Entry with category_a and taxonomy path
    const verizon = suppliers.find((s) => s.supplierName === 'verizon');
    expect(verizon).toBeDefined();
    expect(verizon!.categoryA).toBe(true);
    expect(verizon!.categoryATaxonomyPath).toBe('Non Clinical|Non Clinical|Telecom');
    expect(verizon!.aliases).toEqual(['verizon', 'verizon communication']);
    expect(verizon!.supplierInfo).toEqual(expect.objectContaining({ supplierType: 'company' }));

    // Entry with parent relationship and substantive info
    const geHealthcare = suppliers.find((s) => s.supplierName === 'ge healthcare');
    expect(geHealthcare).toBeDefined();
    expect(geHealthcare!.parentName).toBe('general electric');
    expect(geHealthcare!.aliases).toEqual(['ge medical', 'gehc']);
    expect(geHealthcare!.supplierInfo).toEqual(expect.objectContaining({
      supplierType: 'company',
      websiteUrl: 'https://www.gehealthcare.com',
      industry: 'Healthcare',
    }));

    // Entry with substantive info (Pfizer)
    const pfizer = suppliers.find((s) => s.supplierName === 'pfizer inc');
    expect(pfizer).toBeDefined();
    expect(pfizer!.supplierInfo).toEqual(expect.objectContaining({
      supplierType: 'company',
      industry: 'Pharmaceuticals',
    }));
  });

  it('should return empty array when supplier file does not exist', async () => {
    setColabipBasePath(NONEXISTENT_PATH);
    const suppliers = await readSupplierUniverse();
    expect(suppliers).toEqual([]);
    setColabipBasePath(FIXTURE_PATH);
  });
});
