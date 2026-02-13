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
        { supplierName: 'Acme Corp', parentCompany: 'Acme Inc', supplierType: 'company', website: 'acme.com', industry: 'Manufacturing' },
      ]);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Acme Corp');

      expect(result.officialBusinessName).toBe('Acme Corp');
      expect(result.confidence).toBe('high');
      expect(result.sources).toContain('ColabIP Supplier Universe');
      expect(researchSupplier).not.toHaveBeenCalled();
    });

    it('should fall back to LLM research when not in universe', async () => {
      const mockResult = {
        officialBusinessName: 'Test Co',
        description: 'A test company',
        confidence: 'medium' as const,
        sources: ['LLM'],
      };
      vi.mocked(researchSupplier).mockResolvedValue(mockResult);
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
        officialBusinessName: 'Test Co',
        confidence: 'high' as const,
        sources: ['Company website'],
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
        officialBusinessName: 'Test Co',
        confidence: 'medium' as const,
        sources: ['LLM training data'],
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
        officialBusinessName: 'Test Co',
        confidence: 'medium' as const,
        sources: ['LLM'],
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Test Co');
      expect(result.sources).not.toContain('Exa Web Search');
    });

    it('should not skip Exa search for ColabIP-matched suppliers', async () => {
      vi.mocked(readSupplierUniverse).mockResolvedValue([
        { supplierName: 'Known Corp', parentCompany: '', supplierType: 'company', website: 'known.com', industry: 'Tech' },
      ]);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await researchSingle('Known Corp');

      // When found in ColabIP, should not call Exa at all
      expect(exaSearch.searchSupplier).not.toHaveBeenCalled();
      expect(researchSupplier).not.toHaveBeenCalled();
    });

    it('should retry Exa with company name when confidence is low', async () => {
      vi.mocked(projectService.getMetadata).mockResolvedValue({
        name: 'Acme Manufacturing', filePath: '/test.c91', companyContext: null,
        columnMappings: null, invoiceGroupingColumns: null,
        tailSpendThreshold: 10000, taxonomyName: null, createdAt: null,
      });
      const retryResults = [
        { title: 'Disambiguated', url: 'https://example.com', text: 'Found the right supplier.' },
      ];
      vi.mocked(exaSearch.searchSupplier)
        .mockResolvedValueOnce([])   // first search returns nothing
        .mockResolvedValueOnce(retryResults);  // retry with company name
      vi.mocked(researchSupplier)
        .mockResolvedValueOnce({ confidence: 'low' as const, sources: [] })  // first LLM call
        .mockResolvedValueOnce({ officialBusinessName: 'Ambiguous Inc', confidence: 'high' as const, sources: [] });  // retry LLM call
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Ambiguous Inc');

      // Should have called Exa twice: once normally, once with company name
      expect(exaSearch.searchSupplier).toHaveBeenCalledTimes(2);
      expect(exaSearch.searchSupplier).toHaveBeenLastCalledWith('Ambiguous Inc Acme Manufacturing', undefined);
      // Should have called LLM twice
      expect(researchSupplier).toHaveBeenCalledTimes(2);
      expect(result.confidence).toBe('high');
      expect(result.sources).toContain('Exa Web Search');
    });

    it('should not retry when confidence is medium or high', async () => {
      vi.mocked(researchSupplier).mockResolvedValue({
        officialBusinessName: 'Test', confidence: 'medium' as const, sources: [],
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await researchSingle('Test');

      // Exa called once (initial), not retried
      expect(exaSearch.searchSupplier).toHaveBeenCalledTimes(1);
      expect(researchSupplier).toHaveBeenCalledTimes(1);
    });

    it('should not retry when retry Exa returns empty results', async () => {
      vi.mocked(exaSearch.searchSupplier).mockResolvedValue([]);  // both calls return empty
      vi.mocked(researchSupplier).mockResolvedValue({
        confidence: 'low' as const, sources: [],
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await researchSingle('Unknown');

      // Exa called twice but LLM only once (retry Exa returned nothing)
      expect(exaSearch.searchSupplier).toHaveBeenCalledTimes(2);
      expect(researchSupplier).toHaveBeenCalledTimes(1);
    });

    it('should gracefully handle retry Exa failure', async () => {
      vi.mocked(exaSearch.searchSupplier)
        .mockResolvedValueOnce([])  // first search
        .mockRejectedValueOnce(new Error('Retry failed'));  // retry fails
      vi.mocked(researchSupplier).mockResolvedValue({
        confidence: 'low' as const, sources: [],
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const result = await researchSingle('Failing');

      // Should still complete with the original low-confidence result
      expect(result.confidence).toBe('low');
      expect(researchSupplier).toHaveBeenCalledTimes(1);
    });

    it('should store results in supplier service', async () => {
      vi.mocked(researchSupplier).mockResolvedValue({
        officialBusinessName: 'Test', confidence: 'high' as const, sources: ['LLM'],
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
            id: '1', supplierName: 'Already', parentSupplierId: null,
            supplierType: 'company', supplierInfo: { description: 'Known' },
            categoryA: false, categoryATaxonomyNodeId: null,
            transactionCount: 0, totalSpend: 0, createdAt: '', updatedAt: '',
          };
        }
        return null;
      });
      vi.mocked(researchSupplier).mockResolvedValue({
        officialBusinessName: 'New', confidence: 'medium' as const, sources: [],
      });
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      const progress: Array<[number, number]> = [];
      await researchBatch(['Already', 'New'], (done, total) => progress.push([done, total]));

      expect(researchSupplier).toHaveBeenCalledTimes(1);
    });

    it('should report progress', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(researchSupplier).mockResolvedValue({
        officialBusinessName: 'Test', confidence: 'medium' as const, sources: [],
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
        return { officialBusinessName: 'B', confidence: 'medium' as const, sources: [] };
      });
      vi.mocked(supplierService.updateSupplier).mockResolvedValue();

      await expect(researchBatch(['A', 'B'])).resolves.toBeUndefined();
    });
  });
});
