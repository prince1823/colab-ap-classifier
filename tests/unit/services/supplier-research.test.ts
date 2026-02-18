import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/agents/research-agent', () => ({
  researchSupplier: vi.fn(),
}));

vi.mock('../../../src/main/services/colabip', () => ({
  readSupplierUniverse: vi.fn(),
}));

vi.mock('../../../src/main/services/exa-search', () => ({
  searchSupplier: vi.fn(),
}));

vi.mock('../../../src/main/services/suppliers', () => ({
  getSupplierByName: vi.fn(),
  updateSupplier: vi.fn(),
  listSuppliers: vi.fn(),
}));

vi.mock('../../../src/main/services/project', () => ({
  getMetadata: vi.fn(),
}));

import { researchSingle, researchBatch } from '../../../src/main/services/supplier-research';
import { researchSupplier } from '../../../src/main/agents/research-agent';
import { readSupplierUniverse } from '../../../src/main/services/colabip';
import * as exaSearch from '../../../src/main/services/exa-search';
import * as supplierService from '../../../src/main/services/suppliers';
import * as projectService from '../../../src/main/services/project';

describe('SupplierResearchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readSupplierUniverse).mockResolvedValue([]);
    vi.mocked(exaSearch.searchSupplier).mockResolvedValue([]);
    vi.mocked(projectService.getMetadata).mockResolvedValue({
      name: 'Test', filePath: '/test.c91', companyContext: null,
      columnMappings: null, invoiceGroupingColumns: null,
      tailSpendThreshold: 10000, taxonomyName: null, createdAt: null,
    });
  });

  describe('researchSingle', () => {
    it('should check supplier universe first', async () => {
      vi.mocked(readSupplierUniverse).mockResolvedValue([
        {
          id: 'sup-acme-001', supplierName: 'Acme Corp', aliases: [], parentId: null,
          parentName: 'Acme Inc', categoryA: false, categoryATaxonomyPath: null,
          supplierInfo: { supplierType: 'company', websiteUrl: 'acme.com', industry: 'Manufacturing' },
        },
      ]);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Acme Corp');

      expect(result.officialBusinessName).toBe('Acme Corp');
      expect(result.confidence).toBe('high');
      expect(result.sources).toContain('ColabIP Supplier Universe');
      expect(researchSupplier).not.toHaveBeenCalled();
    });

    it('should fall back to LLM research when not in universe', async () => {
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Test Co',
          description: 'A test company',
          supplierType: 'company',
          confidence: 'medium' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Test Co');

      expect(researchSupplier).toHaveBeenCalledWith('Test Co', undefined, undefined, []);
      expect(result.officialBusinessName).toBe('Test Co');
    });

    it('should pass Exa search results to LLM research agent', async () => {
      const mockSearchResults = [
        { title: 'Test Co', url: 'https://testco.com', text: 'Test Co is a tech company.' },
      ];
      vi.mocked(exaSearch.searchSupplier).mockResolvedValue(mockSearchResults);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Test Co',
          supplierType: 'company',
          confidence: 'high' as const,
          sources: ['Company website'],
        },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Test Co');

      expect(exaSearch.searchSupplier).toHaveBeenCalledWith('Test Co', undefined);
      expect(researchSupplier).toHaveBeenCalledWith('Test Co', undefined, undefined, mockSearchResults);
      expect(result.sources).toContain('Exa Web Search');
    });

    it('should gracefully handle Exa search failure and fall back to LLM-only', async () => {
      vi.mocked(exaSearch.searchSupplier).mockRejectedValue(new Error('Exa API error'));
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Test Co',
          confidence: 'medium' as const,
          sources: ['LLM training data'],
        },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Test Co');

      // Should still succeed despite Exa failure
      expect(result.officialBusinessName).toBe('Test Co');
      expect(researchSupplier).toHaveBeenCalledWith('Test Co', undefined, undefined, []);
      expect(result.sources).not.toContain('Exa Web Search');
    });

    it('should not add Exa source when search returns empty results', async () => {
      vi.mocked(exaSearch.searchSupplier).mockResolvedValue([]);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Test Co',
          confidence: 'medium' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Test Co');
      expect(result.sources).not.toContain('Exa Web Search');
    });

    it('should not skip Exa search for ColabIP-matched suppliers', async () => {
      vi.mocked(readSupplierUniverse).mockResolvedValue([
        {
          id: 'sup-known-001', supplierName: 'Known Corp', aliases: [], parentId: null,
          parentName: '', categoryA: false, categoryATaxonomyPath: null,
          supplierInfo: { supplierType: 'company', websiteUrl: 'known.com', industry: 'Tech' },
        },
      ]);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await researchSingle('Known Corp');

      // When found in ColabIP, should not call Exa at all
      expect(exaSearch.searchSupplier).not.toHaveBeenCalled();
      expect(researchSupplier).not.toHaveBeenCalled();
    });

    it('should fall through to LLM when universe match has null supplier info', async () => {
      vi.mocked(readSupplierUniverse).mockResolvedValue([
        {
          id: 'sup-sparse-001', supplierName: 'Sparse Corp', aliases: [], parentId: null,
          parentName: '', categoryA: false, categoryATaxonomyPath: null,
          supplierInfo: null,
        },
      ]);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Sparse Corp',
          description: 'A sparse company',
          industry: 'Technology',
          confidence: 'medium' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Sparse Corp');

      // Should have called LLM research since universe has no substantive info
      expect(researchSupplier).toHaveBeenCalled();
      expect(exaSearch.searchSupplier).toHaveBeenCalled();
      expect(result.industry).toBe('Technology');
      expect(result.description).toBe('A sparse company');
    });

    it('should fall through to LLM when universe match has empty supplier info', async () => {
      vi.mocked(readSupplierUniverse).mockResolvedValue([
        {
          id: 'sup-empty-001', supplierName: 'Empty Info Corp', aliases: [], parentId: null,
          parentName: '', categoryA: false, categoryATaxonomyPath: null,
          supplierInfo: { websiteUrl: 'empty.com' },
        },
      ]);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Empty Info Corp',
          description: 'Now enriched',
          industry: 'Finance',
          confidence: 'high' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Empty Info Corp');

      // Has websiteUrl but no industry or description — should trigger LLM
      expect(researchSupplier).toHaveBeenCalled();
      expect(result.industry).toBe('Finance');
    });

    it('should use universe data when match has description but no industry', async () => {
      vi.mocked(readSupplierUniverse).mockResolvedValue([
        {
          id: 'sup-desc-001', supplierName: 'Desc Corp', aliases: [], parentId: null,
          parentName: '', categoryA: false, categoryATaxonomyPath: null,
          supplierInfo: { description: 'A company with a description' },
        },
      ]);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Desc Corp');

      // Has description — substantive info exists, skip LLM
      expect(researchSupplier).not.toHaveBeenCalled();
      expect(result.confidence).toBe('high');
      expect(result.sources).toContain('ColabIP Supplier Universe');
    });

    it('should store results in supplier service', async () => {
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'Test', supplierType: 'company', confidence: 'high' as const, sources: ['LLM'] },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await researchSingle('Test');

      expect(supplierService.updateSupplier).toHaveBeenCalled();
    });
  });

  describe('researchBatch', () => {
    it('should skip already-researched suppliers', async () => {
      vi.mocked(supplierService.getSupplierByName).mockImplementation(async (name) => {
        if (name === 'Already') {
          return {
            id: '1', supplierName: 'Already', aliases: null, parentSupplierId: null,
            supplierInfo: { description: 'Known' },
            categoryA: false, categoryATaxonomyNodeId: null,
            transactionCount: 0, totalSpend: 0, createdAt: '', updatedAt: '',
          };
        }
        return null;
      });
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'New', confidence: 'medium' as const, sources: [] },
      });
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const progress: Array<[number, number]> = [];
      await researchBatch(['Already', 'New'], (done, total) => progress.push([done, total]));

      expect(researchSupplier).toHaveBeenCalledTimes(1);
    });

    it('should report progress', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'Test', confidence: 'medium' as const, sources: [] },
      });
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const progress: Array<[number, number]> = [];
      await researchBatch(['A', 'B'], (done, total) => progress.push([done, total]));

      expect(progress.length).toBeGreaterThan(0);
      const lastProgress = progress[progress.length - 1];
      expect(lastProgress[0]).toBe(2);
      expect(lastProgress[1]).toBe(2);
    });

    it('should not abort batch on individual failure', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      let callCount = 0;
      vi.mocked(researchSupplier).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('API Error');
        return { result: { officialBusinessName: 'B', confidence: 'medium' as const, sources: [] } };
      });
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await expect(researchBatch(['A', 'B'])).resolves.toBeUndefined();
    });
  });
});
