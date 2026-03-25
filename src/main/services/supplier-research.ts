import type {
  SupplierUniverse,
  WebSearch,
  ResearchAgent,
  EventBus,
  SupplierResearcher as ISupplierResearcher,
  SupplierService,
} from '../../shared/types/services';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type { ResearchProgress } from '../../shared/types/classification';

export interface SupplierResearchResult extends SupplierInfo {
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

const CONCURRENCY = 5;

export class SupplierResearcher implements ISupplierResearcher {
  private isCancelled = false;

  constructor(
    private supplierUniverse: SupplierUniverse,
    private webSearch: WebSearch,
    private researchAgent: ResearchAgent,
    private eventBus: EventBus,
    private supplierService: SupplierService
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

  async researchAll(supplierIds?: string[]): Promise<void> {
    this.isCancelled = false;

    const emit = (done: number, total: number, step: string): void => {
      const status: ResearchProgress['status'] =
        this.isCancelled ? 'cancelled' : done === total ? 'completed' : 'running';
      this.eventBus.emit('suppliers:research:progress', {
        status,
        totalSuppliers: total,
        processedSuppliers: done,
        percentage: total > 0 ? Math.round((done / total) * 100) : 0,
        currentSupplier: null,
        currentStep: step,
      } satisfies ResearchProgress);
    };

    // Gather candidates
    let candidates: Array<{ id: string; supplierName: string }>;
    if (supplierIds && supplierIds.length > 0) {
      const fetched = await Promise.all(supplierIds.map((id) => this.supplierService.getProjectSupplier(id)));
      candidates = fetched.filter(
        (s): s is NonNullable<typeof s> => s !== null && !s.isTailSpend
      );
    } else {
      const all = await this.supplierService.listProjectSuppliers();
      candidates = all.filter((s) => !s.isResearched && !s.isTailSpend);
    }

    const total = candidates.length;
    if (total === 0) {
      emit(0, 0, 'No suppliers to research');
      return;
    }

    emit(0, total, 'Starting research');

    let completed = 0;
    const queue = [...candidates];

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.isCancelled) break;
        const supplier = queue.shift();
        if (!supplier) break;

        try {
          const info = await this.researchSingle(supplier.supplierName);

          if (info.parentCompanyName) {
            const existing = await this.supplierService.findParentByName(info.parentCompanyName);
            const parent = existing ?? (await this.supplierService.addParent(info.parentCompanyName));
            await this.supplierService.assignParent([supplier.id], parent.id);
          }

          await this.supplierService.updateSupplier(supplier.id, { supplierInfo: info });
          await this.supplierService.markResearched(supplier.id);
        } catch (err) {
          console.error(`[Research] Failed for "${supplier.supplierName}":`, err);
        }

        completed++;
        emit(completed, total, 'Researching suppliers...');
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));

    // Emit terminal state
    if (this.isCancelled) {
      this.eventBus.emit('suppliers:research:progress', {
        status: 'cancelled',
        totalSuppliers: total,
        processedSuppliers: completed,
        percentage: Math.round((completed / total) * 100),
        currentSupplier: null,
        currentStep: 'Cancelled',
      } satisfies ResearchProgress);
    } else {
      emit(total, total, 'Completed');
    }
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
