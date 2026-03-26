import { registerHandler } from './register';
import type { SupplierResearcher, SupplierService, TaxonomyStore, ProjectStore } from '../../shared/types/services';

export function registerSupplierResearchHandlers(
  researcher: SupplierResearcher,
  suppliers: SupplierService,
  taxonomy: TaxonomyStore,
  project: ProjectStore
): void {
  registerHandler('suppliers:researchAll', async (_event, supplierIds?: unknown) => {
    const ids = Array.isArray(supplierIds) ? (supplierIds as string[]) : undefined;

    const taxonomyNodes = await taxonomy.getNodes();
    let context;
    try {
      context = (await project.getSetting('company_context') as { industry: string }) ?? { industry: 'Unknown' };
    } catch {
      context = { industry: 'Unknown' };
    }
    const columnPriorities = (await project.getSetting('column_priorities') as string[] | null) ?? [];

    // categorizeTailSpend is independent of researchAll — run in parallel
    if (columnPriorities.length > 0) {
      researcher.categorizeTailSpend(taxonomyNodes, context, columnPriorities)
        .catch((err) => console.error('[IPC] Tail spend categorization failed:', err));
    }

    // categorizeWithSupplierInfo depends on researchAll completing first
    researcher.researchAll(ids)
      .then(() => researcher.categorizeWithSupplierInfo(taxonomyNodes, context))
      .catch((err) => console.error('[IPC] Research/categorization failed:', err));
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

    const info = await researcher.researchSingle(supplier.supplierName);

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
