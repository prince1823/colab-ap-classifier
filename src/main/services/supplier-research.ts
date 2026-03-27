import type {
  SupplierUniverse,
  WebSearch,
  ResearchAgent,
  EventBus,
  SupplierResearcher as ISupplierResearcher,
  SupplierService,
  ClassificationAgent,
  Database,
} from '../../shared/types/services';
import type { SupplierInfo } from '../../shared/types/suppliers';
import type { TaxonomyNode } from '../../shared/types/taxonomy';
import type { CompanyContext } from '../../shared/types/project';
import type { ResearchProgress } from '../../shared/types/classification';
import { buildDedupGroups, extractFields } from '../utils/dedup-groups';
import { validateCategoryPath } from '../agents/classification-agent';
import { cleanDescription } from '../utils/text';

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
    private supplierService: SupplierService,
    private classificationAgent: ClassificationAgent,
    private db: Database
  ) {}

  async researchSingle(supplierName: string, universeCache?: Map<string, SupplierInfo>): Promise<SupplierInfo> {
    // Check if already researched with substantive info
    const existing = universeCache
      ? (universeCache.get(supplierName) ?? null)
      : await this.supplierUniverse.getSupplier(supplierName);
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

  async researchAll(supplierIds?: string[], options?: { suppressTerminal?: boolean }): Promise<void> {
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

    // Pre-fetch all universe entries in one batch query — avoids N round-trips during concurrent phase
    const universeCache = await this.supplierUniverse.getSuppliersByNames(
      candidates.map((c) => c.supplierName)
    );

    let completed = 0;
    const queue = [...candidates];

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.isCancelled) break;
        const supplier = queue.shift();
        if (!supplier) break;

        try {
          const info = await this.researchSingle(supplier.supplierName, universeCache);

          try {
            if (info.parentCompanyName) {
              const existing = await this.supplierService.findParentByName(info.parentCompanyName);
              const parent = existing ?? (await this.supplierService.addParent(info.parentCompanyName));
              await this.supplierService.assignParent([supplier.id], parent.id);
            }
            // Merge supplierInfo write + markResearched into a single UPDATE
            await this.supplierService.updateSupplier(supplier.id, { supplierInfo: info, markResearched: true });
          } catch (updateErr) {
            console.error(`[Research] Failed to persist info for "${supplier.supplierName}":`, updateErr);
            // Still mark researched even if info write failed
            await this.supplierService.markResearched(supplier.id);
          }
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
    } else if (!options?.suppressTerminal) {
      emit(total, total, 'Completed');
    }
  }

  /**
   * Categorize non-tail-spend suppliers that have supplier_info but no l1_l2_path.
   * Uses the existing selectCategories agent method.
   */
  async categorizeWithSupplierInfo(taxonomy: TaxonomyNode[], companyContext: CompanyContext): Promise<void> {
    if (this.isCancelled) return;

    // Fetch candidates: non-tail-spend, has supplier_info, no l1_l2_path
    const allSuppliers = await this.supplierService.listProjectSuppliers();
    const candidates = allSuppliers.filter(
      (s) => !s.isTailSpend && s.supplierInfo !== null && s.l1L2Path === null
    );

    if (candidates.length === 0) return;

    const total = candidates.length;
    let completed = 0;
    const BATCH_SIZE = 10;

    const batches: typeof candidates[] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    const queue = [...batches];

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.isCancelled) break;
        const batch = queue.shift();
        if (!batch) break;

        try {
          const result = await this.classificationAgent.selectCategories({
            suppliers: batch.map((s) => ({
              name: s.supplierName,
              research: s.supplierInfo,
              parentName: s.parentName,
            })),
            taxonomy,
            companyContext,
          });

          for (let i = 0; i < batch.length; i++) {
            const path = result.get(i + 1);
            if (path) {
              const validated = validateCategoryPath(path, taxonomy);
              if (validated) {
                await this.supplierService.updateSupplier(batch[i].id, { l1L2Path: validated });
              } else {
                console.warn(`[Research] Invalid category path "${path}" for supplier "${batch[i].supplierName}" — skipping`);
              }
            }
          }
        } catch (err) {
          console.error('[Research] categorizeWithSupplierInfo batch failed:', err);
        }

        completed += batch.length;
        this.eventBus.emit('suppliers:research:progress', {
          status: 'running' as const,
          totalSuppliers: total,
          processedSuppliers: completed,
          percentage: Math.round((completed / total) * 100),
          currentSupplier: null,
          currentStep: 'Categorizing suppliers...',
        } satisfies ResearchProgress);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
  }

  /**
   * Categorize tail spend suppliers using their transaction groups.
   * Batches: max 10 suppliers, max 300 groups per call. Supplier never split.
   */
  async categorizeTailSpend(
    taxonomy: TaxonomyNode[],
    companyContext: CompanyContext,
    columnPriorities: string[]
  ): Promise<void> {
    if (this.isCancelled) return;

    // Fetch candidates: tail spend, no l1_l2_path
    const allSuppliers = await this.supplierService.listProjectSuppliers();
    const tailSpendSuppliers = allSuppliers.filter(
      (s) => s.isTailSpend && s.l1L2Path === null
    );

    if (tailSpendSuppliers.length === 0) return;

    // Build dedup groups per supplier
    const supplierGroups: Array<{
      id: string;
      name: string;
      groups: Array<{ fields: Array<[string, string]>; count: number }>;
      groupCount: number;
    }> = [];

    for (const supplier of tailSpendSuppliers) {
      if (this.isCancelled) return;

      // Fetch transactions for this supplier
      const txns = await this.getSupplierTransactions(supplier.id, columnPriorities);
      if (txns.length === 0) continue;

      const dedupResult = buildDedupGroups(txns, columnPriorities);
      const groups: Array<{ fields: Array<[string, string]>; count: number }> = [];

      for (let g = 1; g <= dedupResult.groupCount; g++) {
        const ids = dedupResult.groupToTransactionIds.get(g);
        if (!ids) continue;
        const firstTxn = txns.find((t) => String(t.id) === ids[0]);
        if (!firstTxn) continue;
        const fields = extractFields(firstTxn, columnPriorities);
        groups.push({ fields, count: ids.length });
      }

      supplierGroups.push({
        id: supplier.id,
        name: supplier.supplierName,
        groups,
        groupCount: groups.length,
      });
    }

    if (supplierGroups.length === 0) return;

    // Batch: max 10 suppliers, max 300 groups per call
    const MAX_SUPPLIERS = 10;
    const MAX_GROUPS = 300;

    const batches: typeof supplierGroups[] = [];
    let currentBatch: typeof supplierGroups = [];
    let currentGroupCount = 0;

    for (const supplier of supplierGroups) {
      // Single supplier >300 groups gets its own call
      if (supplier.groupCount > MAX_GROUPS) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentGroupCount = 0;
        }
        batches.push([supplier]);
        continue;
      }

      // Would adding this supplier exceed limits?
      if (
        currentBatch.length >= MAX_SUPPLIERS ||
        currentGroupCount + supplier.groupCount > MAX_GROUPS
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentGroupCount = 0;
      }

      currentBatch.push(supplier);
      currentGroupCount += supplier.groupCount;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    // Process batches with worker pool
    const queue = [...batches];

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.isCancelled) break;
        const batch = queue.shift();
        if (!batch) break;

        try {
          const result = await this.classificationAgent.selectCategoriesForTailSpend({
            suppliers: batch.map((s) => ({
              name: s.name,
              groups: s.groups,
            })),
            taxonomy,
            companyContext,
          });

          for (let i = 0; i < batch.length; i++) {
            const path = result.get(i + 1);
            if (path) {
              const validated = validateCategoryPath(path, taxonomy);
              if (validated) {
                await this.supplierService.updateSupplier(batch[i].id, { l1L2Path: validated });
              } else {
                console.warn(`[Research] Invalid tail spend category path "${path}" for "${batch[i].name}" — skipping`);
              }
            }
          }
        } catch (err) {
          console.error('[Research] categorizeTailSpend batch failed:', err);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
  }

  /**
   * Fetch transactions for a supplier, cleaned for LLM consumption.
   */
  private async getSupplierTransactions(
    supplierId: string,
    columnPriorities: string[]
  ): Promise<Array<Record<string, unknown>>> {
    const txns = await this.db.all<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE project_supplier_id = ?',
      supplierId
    );

    // Clean descriptions and inject supplier name
    const supplier = await this.supplierService.getProjectSupplier(supplierId);
    return txns.map((txn) => {
      const cleaned = { ...txn };
      if (typeof cleaned.gl_description === 'string') {
        cleaned.gl_description = cleanDescription(cleaned.gl_description);
      }
      if (supplier) cleaned.supplier_name = supplier.supplierName;
      return cleaned;
    });
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
