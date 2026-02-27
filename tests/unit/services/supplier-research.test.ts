import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/agents/research-agent', () => ({
  researchSupplier: vi.fn(),
}));

vi.mock('../../../src/main/services/exa-search', () => ({
  searchSupplier: vi.fn(),
}));

vi.mock('../../../src/main/services/suppliers', () => ({
  getSupplierByName: vi.fn(),
  upsertSupplier: vi.fn(),
}));

vi.mock('../../../src/main/services/project', () => ({
  getMetadata: vi.fn(),
}));

vi.mock('../../../src/main/services/database', () => ({
  databaseService: {
    all: vi.fn(),
  },
}));

import { researchSingle, researchAllProjectSuppliers } from '../../../src/main/services/supplier-research';
import { researchSupplier } from '../../../src/main/agents/research-agent';
import * as exaSearch from '../../../src/main/services/exa-search';
import * as supplierService from '../../../src/main/services/suppliers';
import * as projectService from '../../../src/main/services/project';
import { databaseService } from '../../../src/main/services/database';

describe('SupplierResearchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exaSearch.searchSupplier).mockResolvedValue([]);
    vi.mocked(projectService.getMetadata).mockResolvedValue({
      id: 'test-id',
      projectName: 'Test',
      createdAt: '2024-01-01',
      companyContext: null,
      columnMapping: null,
      taxonomyName: null,
      tailSpendThreshold: 10000,
    });
  });

  describe('researchSingle', () => {
    it('should return existing research when supplier has substantive info', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue({
        id: '1',
        supplierName: 'Acme Corp',
        aliases: null,
        parentSupplierId: null,
        parentName: null,
        supplierInfo: {
          supplierType: 'company',
          industry: 'Manufacturing',
          description: 'Industrial supplier',
          confidence: 'high',
          sources: ['Existing research'],
        },
        categoryA: false,
        categoryATaxonomyNodeId: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      const result = await researchSingle('Acme Corp');

      expect(result.industry).toBe('Manufacturing');
      expect(result.confidence).toBe('high');
      expect(result.sources).toContain('Existing research');
      expect(researchSupplier).not.toHaveBeenCalled();
    });

    it('should fall back to LLM research when supplier has no existing info', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Test Co',
          description: 'A test company',
          supplierType: 'company',
          confidence: 'medium' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

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
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

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
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

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
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      const result = await researchSingle('Test Co');
      expect(result.sources).not.toContain('Exa Web Search');
    });

    it('should fall through to LLM when existing supplier has no substantive info', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue({
        id: '1',
        supplierName: 'Sparse Corp',
        aliases: null,
        parentSupplierId: null,
        parentName: null,
        supplierInfo: { websiteUrl: 'sparse.com' },
        categoryA: false,
        categoryATaxonomyNodeId: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Sparse Corp',
          description: 'Now enriched',
          industry: 'Finance',
          confidence: 'high' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      const result = await researchSingle('Sparse Corp');

      // Has websiteUrl but no industry or description — should trigger LLM
      expect(researchSupplier).toHaveBeenCalled();
      expect(result.industry).toBe('Finance');
    });

    it('should skip LLM when existing supplier has description', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue({
        id: '1',
        supplierName: 'Desc Corp',
        aliases: null,
        parentSupplierId: null,
        parentName: null,
        supplierInfo: { description: 'A company with a description', confidence: 'high', sources: ['Previous'] },
        categoryA: false,
        categoryATaxonomyNodeId: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      const result = await researchSingle('Desc Corp');

      // Has description — substantive info exists, skip LLM
      expect(researchSupplier).not.toHaveBeenCalled();
      expect(result.confidence).toBe('high');
    });

    it('should store results via upsertSupplier', async () => {
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'Test', supplierType: 'company', confidence: 'high' as const, sources: ['LLM'] },
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      await researchSingle('Test');

      expect(supplierService.upsertSupplier).toHaveBeenCalledWith('Test', {
        supplierInfo: expect.objectContaining({
          officialBusinessName: 'Test',
          supplierType: 'company',
        }),
      });
    });

    it('should pass company context from project metadata to research agent', async () => {
      vi.mocked(projectService.getMetadata).mockResolvedValue({
        id: 'test-id',
        projectName: 'Test',
        createdAt: '2024-01-01',
        companyContext: { industry: 'Manufacturing', sector: 'Industrial' },
        columnMapping: null,
        taxonomyName: null,
        tailSpendThreshold: 10000,
      });
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'Test', confidence: 'medium' as const, sources: [] },
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      await researchSingle('Test');

      expect(researchSupplier).toHaveBeenCalledWith(
        'Test',
        { industry: 'Manufacturing', sector: 'Industrial' },
        undefined,
        [],
      );
    });

    it('should pass existing supplier address to Exa search and research agent', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue({
        id: '1',
        supplierName: 'Addr Corp',
        aliases: null,
        parentSupplierId: null,
        parentName: null,
        supplierInfo: { supplierAddress: '123 Main St' },
        categoryA: false,
        categoryATaxonomyNodeId: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'Addr Corp', confidence: 'medium' as const, sources: [] },
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      await researchSingle('Addr Corp');

      expect(exaSearch.searchSupplier).toHaveBeenCalledWith('Addr Corp', '123 Main St');
      expect(researchSupplier).toHaveBeenCalledWith(
        'Addr Corp',
        undefined,
        '123 Main St',
        [],
      );
    });

    it('should apply heuristic supplierType fallback when LLM does not return one', async () => {
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      vi.mocked(researchSupplier).mockResolvedValue({
        result: {
          officialBusinessName: 'Some Corp',
          description: 'A regular company',
          confidence: 'medium' as const,
          sources: ['LLM'],
        },
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      const result = await researchSingle('Some Corp');

      // Heuristic should default to 'company' when nothing indicates otherwise
      expect(result.supplierType).toBe('company');
    });
  });

  describe('researchAllProjectSuppliers', () => {
    it('should skip already-researched suppliers', async () => {
      vi.mocked(databaseService.all).mockResolvedValue([
        { supplier_name: 'Already' },
        { supplier_name: 'New' },
      ]);
      vi.mocked(supplierService.getSupplierByName).mockImplementation(async (name) => {
        if (name === 'Already') {
          return {
            id: '1', supplierName: 'Already', aliases: null, parentSupplierId: null,
            parentName: null,
            supplierInfo: { description: 'Known', industry: 'Tech' },
            categoryA: false, categoryATaxonomyNodeId: null,
            createdAt: '', updatedAt: '',
          };
        }
        return null;
      });
      vi.mocked(researchSupplier).mockResolvedValue({
        result: { officialBusinessName: 'New', confidence: 'medium' as const, sources: [] },
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      await researchAllProjectSuppliers();

      // Only 'New' should trigger LLM research; 'Already' has substantive info
      expect(researchSupplier).toHaveBeenCalledTimes(1);
    });

    it('should not abort batch on individual failure', async () => {
      vi.mocked(databaseService.all).mockResolvedValue([
        { supplier_name: 'A' },
        { supplier_name: 'B' },
      ]);
      vi.mocked(supplierService.getSupplierByName).mockResolvedValue(null);
      let callCount = 0;
      vi.mocked(researchSupplier).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('API Error');
        return { result: { officialBusinessName: 'B', confidence: 'medium' as const, sources: [] } };
      });
      vi.mocked(supplierService.upsertSupplier).mockResolvedValue();

      await expect(researchAllProjectSuppliers()).resolves.toBeUndefined();

      // Both should be attempted; failure of A should not block B
      expect(supplierService.upsertSupplier).toHaveBeenCalledTimes(2);
    });
  });
});
