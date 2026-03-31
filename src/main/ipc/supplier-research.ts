import { registerHandler } from './register';
import type { SupplierResearcher, SupplierService, TaxonomyStore, ProjectStore, EventBus } from '../../shared/types/services';
import type { ResearchProgress } from '../../shared/types/classification';

export function registerSupplierResearchHandlers(
  researcher: SupplierResearcher,
  suppliers: SupplierService,
  taxonomy: TaxonomyStore,
  project: ProjectStore,
  eventBus: EventBus
): void {
  // Phase 1 only: web research for selected suppliers
  registerHandler('suppliers:researchAll', async (_event, supplierIds?: unknown) => {
    const ids = Array.isArray(supplierIds) ? (supplierIds as string[]) : undefined;

    // Fire-and-forget: researchAll emits its own terminal event
    (async () => {
      await researcher.researchAll(ids);
    })().catch((err) => {
      eventBus.emit('suppliers:research:progress', {
        status: 'failed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      } satisfies ResearchProgress);
    });
  });

  // Categorize all suppliers without L1/L2: non-tail (using research data) + tail (using transactions)
  registerHandler('suppliers:categorizeAll', async () => {
    const taxonomyNodes = await taxonomy.getNodes();
    let context;
    try {
      context = (await project.getSetting('company_context') as { industry: string }) ?? { industry: 'Unknown' };
    } catch {
      context = { industry: 'Unknown' };
    }
    const columnPriorities = (await project.getSetting('column_priorities') as string[] | null) ?? [];

    // Fire-and-forget: categorize non-tail-spend → categorize tail-spend → completed
    (async () => {
      try {
        await researcher.categorizeWithSupplierInfo(taxonomyNodes, context);
      } catch (err) {
        console.error('[IPC] Non-tail-spend categorization failed:', err);
      }

      if (columnPriorities.length > 0) {
        try {
          await researcher.categorizeTailSpend(taxonomyNodes, context, columnPriorities);
        } catch (err) {
          console.error('[IPC] Tail spend categorization failed:', err);
        }
      }

      eventBus.emit('suppliers:research:progress', {
        status: 'completed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 100,
        currentSupplier: null,
        currentStep: 'Complete',
      } satisfies ResearchProgress);
    })().catch((err) => {
      eventBus.emit('suppliers:research:progress', {
        status: 'failed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      } satisfies ResearchProgress);
    });
  });

  registerHandler('suppliers:cancelResearch', async () => {
    researcher.cancel();
  });

  registerHandler('suppliers:researchSingle', async (_event, supplierId: unknown) => {
    const id = supplierId as string;

    // Look up supplier by ID to get the name for research
    const supplier = await suppliers.getProjectSupplier(id);
    if (!supplier) throw new Error(`Supplier not found: ${id}`);

    // Skip research for tail spend suppliers
    if (await suppliers.isTailSpend(id)) {
      return null;
    }

    const info = await researcher.researchSingle(supplier.supplierName, undefined, id);

    // Assign parent if the research extracted one
    if (info.parentCompanyName) {
      const existing = await suppliers.findParentByName(info.parentCompanyName);
      const parent = existing ?? await suppliers.addParent(info.parentCompanyName);
      await suppliers.assignParent([id], parent.id);
    }

    // Persist research results to project_suppliers and mark as researched
    await suppliers.updateSupplier(id, { supplierInfo: info });
    await suppliers.markResearched(id);

    return info;
  });
}
