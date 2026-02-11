import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/agents/research-agent', () => ({
  researchSupplier: vi.fn(),
}));

vi.mock('../../../src/main/services/colabip', () => ({
  readSupplierUniverse: vi.fn(),
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
import * as supplierService from '../../../src/main/services/suppliers';
import * as projectService from '../../../src/main/services/project';

describe('SupplierResearchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readSupplierUniverse).mockResolvedValue([]);
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

      expect(researchSupplier).toHaveBeenCalledWith('Test Co', undefined, undefined);
      expect(result.officialBusinessName).toBe('Test Co');
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
