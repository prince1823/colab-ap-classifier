import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupplierResearcher } from '../../../src/main/services/supplier-research';
import {
  createMockSupplierUniverse,
  createMockWebSearch,
  createMockResearchAgent,
  createMockEventBus,
  createMockSupplierService,
  createMockTransactionStore,
} from '../../helpers/mock-services';
import type { SupplierUniverse, WebSearch, ResearchAgent, EventBus, SupplierService, TransactionStore } from '../../../src/shared/types/services';

describe('SupplierResearcher', () => {
  let supplierUniverse: SupplierUniverse;
  let webSearch: WebSearch;
  let researchAgent: ResearchAgent;
  let eventBus: EventBus;
  let supplierService: SupplierService;
  let transactions: TransactionStore;
  let researcher: SupplierResearcher;

  beforeEach(() => {
    vi.clearAllMocks();
    supplierUniverse = createMockSupplierUniverse();
    webSearch = createMockWebSearch();
    researchAgent = createMockResearchAgent();
    eventBus = createMockEventBus();
    supplierService = createMockSupplierService();
    transactions = createMockTransactionStore();
    researcher = new SupplierResearcher(supplierUniverse, webSearch, researchAgent, eventBus, supplierService, transactions);
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

    it('should pass transaction address to web search and research agent when supplierId provided', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(transactions.getSupplierAddress).mockResolvedValue('123 Main St, Springfield');
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
        industry: 'Software',
      });

      await researcher.researchSingle('Acme Corp', 'supplier-123');

      expect(transactions.getSupplierAddress).toHaveBeenCalledWith('supplier-123');
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', '123 Main St, Springfield');
      expect(researchAgent.researchSupplier).toHaveBeenCalledWith(
        'Acme Corp',
        undefined,
        '123 Main St, Springfield',
        expect.any(Array)
      );
    });

    it('should pass undefined address when supplierId not provided', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
      });

      await researcher.researchSingle('Acme Corp');

      expect(transactions.getSupplierAddress).not.toHaveBeenCalled();
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', undefined);
      expect(researchAgent.researchSupplier).toHaveBeenCalledWith(
        'Acme Corp',
        undefined,
        undefined,
        expect.any(Array)
      );
    });

    it('should pass undefined address when transaction has no supplier_address column', async () => {
      vi.mocked(supplierUniverse.getSupplier).mockResolvedValue(null);
      vi.mocked(transactions.getSupplierAddress).mockResolvedValue(undefined);
      vi.mocked(researchAgent.researchSupplier).mockResolvedValue({
        supplierType: 'Corporation',
      });

      await researcher.researchSingle('Acme Corp', 'supplier-123');

      expect(transactions.getSupplierAddress).toHaveBeenCalledWith('supplier-123');
      expect(webSearch.searchSupplier).toHaveBeenCalledWith('Acme Corp', undefined);
      expect(researchAgent.researchSupplier).toHaveBeenCalledWith(
        'Acme Corp',
        undefined,
        undefined,
        expect.any(Array)
      );
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
