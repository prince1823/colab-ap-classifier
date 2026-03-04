import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupplierResearcher } from '../../../src/main/services/supplier-research';
import {
  createMockSupplierUniverse,
  createMockWebSearch,
  createMockResearchAgent,
  createMockEventBus,
} from '../../helpers/mock-services';
import type { SupplierUniverse, WebSearch, ResearchAgent, EventBus } from '../../../src/shared/types/services';

describe('SupplierResearcher', () => {
  let supplierUniverse: SupplierUniverse;
  let webSearch: WebSearch;
  let researchAgent: ResearchAgent;
  let eventBus: EventBus;
  let researcher: SupplierResearcher;

  beforeEach(() => {
    vi.clearAllMocks();
    supplierUniverse = createMockSupplierUniverse();
    webSearch = createMockWebSearch();
    researchAgent = createMockResearchAgent();
    eventBus = createMockEventBus();
    researcher = new SupplierResearcher(supplierUniverse, webSearch, researchAgent, eventBus);
  });

  describe('researchSingle', () => {
    it('should return cached info from universe if available', async () => {
      const cached = { supplierType: 'Corporation', industry: 'Technology', description: 'A tech company' };
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(cached);

      const result = await researcher.researchSingle('Acme');
      expect(result).toEqual(cached);
      expect(webSearch.searchSupplier).not.toHaveBeenCalled();
      expect(researchAgent.researchSupplier).not.toHaveBeenCalled();
    });

    it('should fall back to web search + LLM when not in universe', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(webSearch.searchSupplier).mockResolvedValue(['Acme Corp is a tech company']);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
        industry: 'Software',
      });

      const result = await researcher.researchSingle('Acme Corp');

      // searchSupplier is called with (name, address) — address may be undefined
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', undefined);
      expect(researchAgent.researchSupplier).toHaveBeenCalled();
      expect(supplierUniverse.upsertSupplier).toHaveBeenCalled();
      expect(result).toMatchObject({ supplierType: 'Corporation', industry: 'Software' });
    });

    it('should skip web search when not available', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(webSearch.isAvailable).mockReturnValue(false);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
        industry: 'Software',
      });

      await researcher.researchSingle('Test Corp');

      expect(webSearch.searchSupplier).not.toHaveBeenCalled();
      expect(researchAgent.researchSupplier).toHaveBeenCalled();
    });
  });

  describe('researchAll', () => {
    it('should emit a progress event', async () => {
      await researcher.researchAll();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'suppliers:research:progress',
        expect.objectContaining({ currentStep: 'Starting research' })
      );
    });
  });

  describe('cancel', () => {
    it('should be callable without error', () => {
      expect(() => researcher.cancel()).not.toThrow();
    });
  });
});
