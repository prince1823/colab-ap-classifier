import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import {
  listTaxonomies,
  listRulePacks,
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
  it('should return correct taxonomy names and .txt file counts', async () => {
    const taxonomies = await listTaxonomies();

    expect(taxonomies).toEqual(
      expect.arrayContaining([
        { name: 'healthcare', nodeCount: 78 },
        { name: 'general', nodeCount: 2 },
        { name: 'manufacturing', nodeCount: 25 },
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

describe('listRulePacks', () => {
  it('should return correct rule pack names and counts', async () => {
    const packs = await listRulePacks();

    const healthcare = packs.find((p) => p.name === 'healthcare');
    const general = packs.find((p) => p.name === 'general');
    const manufacturing = packs.find((p) => p.name === 'manufacturing');

    expect(healthcare).toEqual({ name: 'healthcare', ruleCount: 2 });
    expect(general).toEqual({ name: 'general', ruleCount: 0 });
    expect(manufacturing).toEqual({ name: 'manufacturing', ruleCount: 0 });
  });

  it('should return all directories with rules.csv', async () => {
    const packs = await listRulePacks();
    expect(packs.length).toBe(3);
  });

  it('should return empty array when colabip directory does not exist', async () => {
    setColabipBasePath(NONEXISTENT_PATH);
    const packs = await listRulePacks();
    expect(packs).toEqual([]);
    setColabipBasePath(FIXTURE_PATH);
  });
});

describe('readTaxonomy', () => {
  it('should parse valid .txt files with correct paths and descriptions', async () => {
    const result = await readTaxonomy('healthcare');

    // Healthcare taxonomy has 78 nodes (L1, L2, and L3)
    expect(result.nodes).toHaveLength(78);

    // Check first few nodes (sorted by numeric filename: 1.txt, 2.txt, 3.txt)
    expect(result.nodes[0]).toEqual({
      path: 'Clinical',
      description: expect.stringContaining('Clinical costs'),
    });
    expect(result.nodes[1]).toEqual({
      path: 'Non Clinical',
      description: expect.stringContaining('Non-clinical'),
    });
    expect(result.nodes[2]).toEqual({
      path: 'Non-Sourceable',
      description: expect.stringContaining('Non-procurement'),
    });
  });

  it('should not include nodes with empty paths', async () => {
    const result = await readTaxonomy('healthcare');
    const paths = result.nodes.map((n) => n.path);
    expect(paths).not.toContain('');
  });

  it('should return sorted nodes (numeric filename order)', async () => {
    const result = await readTaxonomy('healthcare');
    // 1.txt = Clinical, 2.txt = Non Clinical, 3.txt = Non-Sourceable
    expect(result.nodes[0].path).toBe('Clinical');
    expect(result.nodes[1].path).toBe('Non Clinical');
    expect(result.nodes[2].path).toBe('Non-Sourceable');
  });

  it('should return empty nodes for non-existent industry', async () => {
    const result = await readTaxonomy('nonexistent');
    expect(result.nodes).toEqual([]);
  });

  it('should return empty nodes for empty taxonomy directory', async () => {
    const result = await readTaxonomy('empty');
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

    expect(suppliers).toHaveLength(3);
    expect(suppliers[0]).toEqual({
      supplierName: 'GE Healthcare',
      parentCompany: 'General Electric',
      supplierType: 'company',
      website: 'https://www.gehealthcare.com',
      industry: 'Healthcare',
    });
    expect(suppliers[1]).toEqual({
      supplierName: 'Pfizer Inc',
      parentCompany: '',
      supplierType: 'company',
      website: 'https://www.pfizer.com',
      industry: 'Pharmaceuticals',
    });
    expect(suppliers[2]).toEqual({
      supplierName: 'John Doe Consulting',
      parentCompany: '',
      supplierType: 'individual',
      website: '',
      industry: 'Consulting',
    });
  });

  it('should return empty array when supplier file does not exist', async () => {
    setColabipBasePath(NONEXISTENT_PATH);
    const suppliers = await readSupplierUniverse();
    expect(suppliers).toEqual([]);
    setColabipBasePath(FIXTURE_PATH);
  });
});
