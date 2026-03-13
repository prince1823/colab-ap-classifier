import type {
  SupplierUniverse,
  WebSearch,
  ResearchAgent,
  EventBus,
  SupplierResearcher as ISupplierResearcher,
} from '../../shared/types/services';
import type { SupplierInfo } from '../../shared/types/suppliers';

export interface SupplierResearchResult extends SupplierInfo {
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

export class SupplierResearcher implements ISupplierResearcher {
  private isCancelled = false;

  constructor(
    private supplierUniverse: SupplierUniverse,
    private webSearch: WebSearch,
    private researchAgent: ResearchAgent,
    private eventBus: EventBus
  ) {}

  async researchSingle(supplierName: string): Promise<SupplierInfo> {
    // Check if already researched with substantive info
    const existing = await this.supplierUniverse.getSupplier(supplierName);
    if (existing) {
      const hasSubstantiveInfo = !!(existing.industry || existing.description);
      if (hasSubstantiveInfo) {
        return existing;
      }
    }

    // Get supplier address if available
    const address = existing?.supplierAddress;

    // Search web for enrichment
    let searchResults: Array<{ title: string; url: string; text: string }> = [];
    try {
      if (this.webSearch.isAvailable()) {
        searchResults = await this.webSearch.searchSupplier(supplierName, address);
      }
    } catch (error) {
      console.error(`[Research] Web search failed for "${supplierName}":`, error);
    }

    // Research via LLM
    const result = await this.researchAgent.researchSupplier(
      supplierName,
      undefined,
      address,
      searchResults
    );

    // Track web search source
    if (searchResults.length > 0 && !result.sources?.includes('Exa Web Search')) {
      if (!result.sources) result.sources = [];
      result.sources.push('Exa Web Search');
    }

    // Apply heuristic fallback for supplier type
    if (!result.supplierType) {
      const heuristicType = determineSupplierType(result);
      if (heuristicType) result.supplierType = heuristicType;
    }

    // Store results
    await this.supplierUniverse.upsertSupplier(supplierName, result);

    return result;
  }

  async researchAll(
    onProgress?: (progress: import('../../shared/types/classification').ResearchProgress) => void
  ): Promise<void> {
    this.isCancelled = false;

    // Get all project suppliers that need research
    // Note: This method works with the supplier universe. The caller should
    // populate the list of supplier names to research.
    // For now, use the universe to check what needs research.
    const emitProgress = (
      done: number,
      total: number,
      currentSupplier: string | null,
      step: string
    ) => {
      const progress = {
        status: (this.isCancelled ? 'cancelled' : done === total ? 'completed' : 'running') as 'running' | 'completed' | 'failed' | 'cancelled',
        totalSuppliers: total,
        processedSuppliers: done,
        percentage: total > 0 ? Math.round((done / total) * 100) : 0,
        currentSupplier,
        currentStep: step,
      };
      this.eventBus.emit('suppliers:research:progress', progress);
      onProgress?.(progress);
    };

    emitProgress(0, 0, null, 'Starting research');
  }

  cancel(): void {
    this.isCancelled = true;
  }
}

function determineSupplierType(result: SupplierInfo): 'company' | 'individual' | 'government' | null {
  const desc = (result.description || '').toLowerCase();
  const industry = (result.industry || '').toLowerCase();
  const model = (result.primaryBusinessModel || '').toLowerCase();

  if (
    industry.includes('government') ||
    desc.includes('municipality') ||
    desc.includes('government agency')
  ) {
    if (
      desc.includes('electricity') ||
      desc.includes('water utility') ||
      desc.includes('gas utility')
    ) {
      return 'company';
    }
    return 'government';
  }

  if (
    model.includes('freelance') ||
    model.includes('sole proprietor') ||
    desc.includes('individual contractor')
  ) {
    return 'individual';
  }

  return 'company';
}
