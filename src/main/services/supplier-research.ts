import type {
  SupplierUniverse,
  WebSearch,
  ResearchAgent,
  EventBus,
  SupplierResearcher as ISupplierResearcher,
  SupplierService,
  ClassificationAgent,
  TransactionStore as ITransactionStore,
  CatAAgent,
  RuleStore as IRuleStore,
  TaxonomyStore as ITaxonomyStore,
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
    private transactions: ITransactionStore,
    private catAAgent: CatAAgent,
    private taxonomyStore: ITaxonomyStore,
    private ruleStore: IRuleStore,
  ) {}

  async researchSingle(supplierName: string, universeCache?: Map<string, SupplierInfo>, supplierId?: string): Promise<SupplierInfo> {
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

    // Get supplier address from transactions (CSV-imported, authoritative)
    const address = supplierId
      ? await this.transactions.getSupplierAddress(supplierId)
      : undefined;

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
    let candidates: Array<{ id: string; supplierName: string; categoryASupplier: boolean; mappedTaxonomyPaths: string[] | null }>;
    let excludedTailSpend = 0;
    if (supplierIds && supplierIds.length > 0) {
      const fetched = await Promise.all(supplierIds.map((id) => this.supplierService.getProjectSupplier(id)));
      const valid = fetched.filter((s): s is NonNullable<typeof s> => s !== null);
      excludedTailSpend = valid.filter((s) => s.isTailSpend).length;
      candidates = valid.filter((s) => !s.isTailSpend);
    } else {
      const all = await this.supplierService.listProjectSuppliers();
      candidates = all.filter((s) => !s.isResearched && !s.isTailSpend);
    }

    const total = candidates.length;
    if (total === 0) {
      const step = excludedTailSpend > 0
        ? `No suppliers to research (${excludedTailSpend} tail spend supplier${excludedTailSpend > 1 ? 's' : ''} excluded — categorized via transaction data)`
        : 'No suppliers to research';
      emit(0, 0, step);
      return;
    }

    const startStep = excludedTailSpend > 0
      ? `Starting research (${excludedTailSpend} tail spend supplier${excludedTailSpend > 1 ? 's' : ''} excluded)`
      : 'Starting research';
    emit(0, total, startStep);

    // Pre-fetch all universe entries in one batch query — avoids N round-trips during concurrent phase
    const universeCache = await this.supplierUniverse.getSuppliersByNames(
      candidates.map((c) => c.supplierName)
    );

    // Pre-fetch taxonomy nodes once for cat A resolution
    const taxonomyNodes = await this.taxonomyStore.getNodes();

    let completed = 0;
    let catAResolveFailed = 0;
    const queue = [...candidates];

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.isCancelled) break;
        const supplier = queue.shift();
        if (!supplier) break;

        try {
          const info = await this.researchSingle(supplier.supplierName, universeCache, supplier.id);

          try {
            // Check universe for richer data (taxonomy, parent) beyond just SupplierInfo
            const universeRecord = await this.supplierUniverse.getSupplierRecord(supplier.supplierName);
            const parentName = info.parentCompanyName || universeRecord?.parentName;

            if (parentName) {
              const existing = await this.supplierService.findParentByName(parentName);
              const parent = existing ?? (await this.supplierService.addParent(parentName));
              await this.supplierService.assignParent([supplier.id], parent.id);
            }
            // Merge supplierInfo write + markResearched into a single UPDATE
            const updatePayload: { supplierInfo: SupplierInfo; markResearched: true; mappedTaxonomyPaths?: string[] } = {
              supplierInfo: info,
              markResearched: true,
            };
            if (universeRecord?.mappedTaxonomyPaths?.length) {
              updatePayload.mappedTaxonomyPaths = universeRecord.mappedTaxonomyPaths;
            }
            await this.supplierService.updateSupplier(supplier.id, updatePayload);

            // Resolve cat A mappings if supplier is flagged (check both project and universe)
            if (supplier.categoryASupplier || universeRecord?.categoryASupplier) {
              const paths = updatePayload.mappedTaxonomyPaths ?? supplier.mappedTaxonomyPaths ?? [];
              if (paths.length > 0) {
                const resolved = await this.resolveCatASupplier(supplier.id, supplier.supplierName, paths, taxonomyNodes);
                if (!resolved) catAResolveFailed++;
              }
            }
          } catch (updateErr) {
            console.error(`[Research] Failed to persist info for "${supplier.supplierName}":`, updateErr);
            // Don't mark as researched — persistence failed, data is incomplete
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
      const step = catAResolveFailed > 0
        ? `Completed — ${catAResolveFailed} Cat A supplier${catAResolveFailed > 1 ? 's' : ''} could not be mapped to project taxonomy`
        : 'Completed';
      emit(total, total, step);
    }
  }

  /**
   * Categorize non-tail-spend suppliers that have supplier_info but no l1_l2_path.
   * Uses the existing selectCategories agent method.
   *
   * NOTE: This is an internal phase used by `categorizeAll`, which owns the cancel
   * lifecycle (resets `isCancelled` at entry, checks it between phases). This method
   * does not manage cancellation on its own — calling it directly will neither reset
   * a stale cancel flag nor honor a `cancel()` issued mid-run. For user-facing
   * categorization, call `categorizeAll`.
   */
  async categorizeWithSupplierInfo(
    taxonomy: TaxonomyNode[], companyContext: CompanyContext, supplierIds?: string[]
  ): Promise<{ categorized: number; skippedNoInfo: number; invalidPaths: number }> {
    // Fetch candidates: non-tail-spend, no l1_l2_path
    const allSuppliers = await this.supplierService.listProjectSuppliers();
    const idSet = supplierIds ? new Set(supplierIds) : null;
    const eligible = allSuppliers.filter(
      (s) => !s.isTailSpend && s.l1L2Path === null && (!idSet || idSet.has(s.id))
    );
    const skippedNoInfo = eligible.filter((s) => s.supplierInfo === null).length;
    const candidates = eligible.filter((s) => s.supplierInfo !== null);

    if (candidates.length === 0) return { categorized: 0, skippedNoInfo, invalidPaths: 0 };

    const total = candidates.length;
    let completed = 0;
    let categorized = 0;
    let invalidPaths = 0;
    const BATCH_SIZE = 10;

    const batches: typeof candidates[] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    const queue = [...batches];
    let failedBatches = 0;
    let lastError: Error | null = null;

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
            const paths = result.get(i + 1);
            if (paths && paths.length > 0) {
              const validatedPaths: string[] = [];
              for (const path of paths) {
                const validated = validateCategoryPath(path, taxonomy);
                if (validated) {
                  validatedPaths.push(validated);
                } else {
                  invalidPaths++;
                  console.warn(`[Research] Invalid category path "${path}" for supplier "${batch[i].supplierName}" — skipping`);
                }
              }
              if (validatedPaths.length > 0) {
                await this.supplierService.updateSupplier(batch[i].id, { l1L2Path: validatedPaths });
                categorized++;
              }
            }
          }
        } catch (err) {
          console.error('[Research] categorizeWithSupplierInfo batch failed:', err);
          failedBatches++;
          lastError = err instanceof Error ? err : new Error(String(err));
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

    if (failedBatches > 0 && failedBatches === batches.length) {
      throw lastError ?? new Error('All categorization batches failed');
    }

    return { categorized, skippedNoInfo, invalidPaths };
  }

  /**
   * Categorize tail spend suppliers using their transaction groups.
   * Batches: max 10 suppliers, max 300 groups per call. Supplier never split.
   *
   * NOTE: This is an internal phase used by `categorizeAll`, which owns the cancel
   * lifecycle (resets `isCancelled` at entry, checks it between phases). This method
   * does not manage cancellation on its own — calling it directly will neither reset
   * a stale cancel flag nor honor a `cancel()` issued mid-run. For user-facing
   * categorization, call `categorizeAll`.
   */
  async categorizeTailSpend(
    taxonomy: TaxonomyNode[],
    companyContext: CompanyContext,
    columnPriorities: string[],
    supplierIds?: string[]
  ): Promise<{ categorized: number; invalidPaths: number }> {
    // Fetch candidates: tail spend, no l1_l2_path
    const allSuppliers = await this.supplierService.listProjectSuppliers();
    const idSet = supplierIds ? new Set(supplierIds) : null;
    const tailSpendSuppliers = allSuppliers.filter(
      (s) => s.isTailSpend && s.l1L2Path === null && (!idSet || idSet.has(s.id))
    );

    if (tailSpendSuppliers.length === 0) return { categorized: 0, invalidPaths: 0 };

    // Build dedup groups per supplier
    const supplierGroups: Array<{
      id: string;
      name: string;
      groups: Array<{ fields: Array<[string, string]>; count: number }>;
      groupCount: number;
    }> = [];

    for (const supplier of tailSpendSuppliers) {
      if (this.isCancelled) return { categorized: 0, invalidPaths: 0 };

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

    if (supplierGroups.length === 0) return { categorized: 0, invalidPaths: 0 };

    let categorized = 0;
    let invalidPaths = 0;

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
    let failedBatches = 0;
    let lastError: Error | null = null;

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
                await this.supplierService.updateSupplier(batch[i].id, { l1L2Path: [validated] });
                categorized++;
              } else {
                invalidPaths++;
                console.warn(`[Research] Invalid tail spend category path "${path}" for "${batch[i].name}" — skipping`);
              }
            }
          }
        } catch (err) {
          console.error('[Research] categorizeTailSpend batch failed:', err);
          failedBatches++;
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));

    if (failedBatches > 0 && failedBatches === batches.length) {
      throw lastError ?? new Error('All tail spend categorization batches failed');
    }

    return { categorized, invalidPaths };
  }

  /**
   * Fetch transactions for a supplier, cleaned for LLM consumption.
   */
  private async getSupplierTransactions(
    supplierId: string,
    columnPriorities: string[]
  ): Promise<Array<Record<string, unknown>>> {
    const txns = await this.transactions.queryBySupplier(supplierId);

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

  /**
   * For each mapped taxonomy path on a cat A supplier, resolve it to a project taxonomy node
   * and create an override rule with source 'supplier_universe' and category_a_supplier = true.
   */
  private async resolveCatASupplier(
    supplierId: string,
    supplierName: string,
    mappedPaths: string[],
    taxonomyNodes: import('../../shared/types/taxonomy').TaxonomyNode[],
  ): Promise<boolean> {
    // One cat A rule per supplier — skip if one already exists
    const existingCatARule = await this.ruleStore.getCatARuleForSupplier(supplierName);
    if (existingCatARule) {
      return true;
    }

    // Try each mapped path in order; create a rule for the first successful resolution
    let ruleCreated = false;
    for (const mappedPath of mappedPaths) {
      try {
        const { resolvedPath } = await this.catAAgent.resolve(mappedPath, taxonomyNodes);
        const node = taxonomyNodes.find((n) => n.fullPath === resolvedPath);
        if (!node) {
          console.warn(`[CatA] Resolved path "${resolvedPath}" not found in taxonomy for supplier "${supplierName}" — skipping`);
          continue;
        }
        await this.ruleStore.createRule({
          name: `[Cat A] ${supplierName}`,
          groupedConditions: {
            groupConnector: 'AND',
            groups: [{
              connector: 'AND',
              conditions: [{ field: 'supplier_name', operator: 'equals', value: supplierName }],
            }],
          },
          targetTaxonomyNodeId: node.id,
          source: 'supplier_universe',
          categoryASupplier: true,
        });
        await this.supplierService.updateSupplier(supplierId, { categoryASupplier: true });
        ruleCreated = true;
        break;
      } catch (err) {
        console.error(`[CatA] Failed to resolve path "${mappedPath}" for supplier "${supplierName}":`, err);
      }
    }

    if (!ruleCreated) {
      console.warn(`[CatA] All mapped paths failed to resolve for "${supplierName}" — no rule created, not marked as Cat A`);
    }

    return ruleCreated;
  }

  async categorizeAll(
    taxonomy: TaxonomyNode[],
    companyContext: CompanyContext,
    columnPriorities: string[],
    supplierIds?: string[]
  ): Promise<void> {
    this.isCancelled = false;

    const emitTerminal = (status: 'completed' | 'cancelled' | 'failed', step: string): void => {
      this.eventBus.emit('suppliers:research:progress', {
        status,
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: status === 'completed' ? 100 : 0,
        currentSupplier: null,
        currentStep: step,
      } satisfies ResearchProgress);
    };

    this.eventBus.emit('suppliers:research:progress', {
      status: 'running',
      totalSuppliers: 0,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: null,
      currentStep: 'Categorizing suppliers...',
    } satisfies ResearchProgress);

    const errors: string[] = [];
    const warnings: string[] = [];

    let infoResult = { categorized: 0, skippedNoInfo: 0, invalidPaths: 0 };
    try {
      infoResult = await this.categorizeWithSupplierInfo(taxonomy, companyContext, supplierIds);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Research] Non-tail-spend categorization failed:', err);
      errors.push(`Supplier categorization: ${msg}`);
    }

    if (this.isCancelled) {
      emitTerminal('cancelled', 'Cancelled');
      return;
    }

    let tailResult = { categorized: 0, invalidPaths: 0 };
    if (columnPriorities.length > 0) {
      try {
        tailResult = await this.categorizeTailSpend(taxonomy, companyContext, columnPriorities, supplierIds);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Research] Tail spend categorization failed:', err);
        errors.push(`Tail spend categorization: ${msg}`);
      }
    } else {
      warnings.push('Tail spend categorization skipped — no column priorities configured. Set them in the Data step.');
    }

    if (this.isCancelled) {
      emitTerminal('cancelled', 'Cancelled');
      return;
    }

    if (infoResult.skippedNoInfo > 0) {
      warnings.push(`${infoResult.skippedNoInfo} supplier${infoResult.skippedNoInfo > 1 ? 's' : ''} skipped (need research first)`);
    }
    const totalInvalidPaths = infoResult.invalidPaths + tailResult.invalidPaths;
    if (totalInvalidPaths > 0) {
      warnings.push(`${totalInvalidPaths} invalid category path${totalInvalidPaths > 1 ? 's' : ''} returned by LLM`);
    }

    if (errors.length > 0) {
      emitTerminal('failed', errors.join('; '));
    } else {
      emitTerminal('completed', warnings.length > 0 ? warnings.join('; ') : 'Complete');
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
