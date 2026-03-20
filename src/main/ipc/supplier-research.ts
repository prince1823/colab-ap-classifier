import { registerHandler } from './register';
import type { SupplierResearcher, SupplierService } from '../../shared/types/services';

export function registerSupplierResearchHandlers(
  researcher: SupplierResearcher,
  suppliers: SupplierService
): void {
  registerHandler('suppliers:researchAll', async () => {
    // Fire-and-forget — progress is streamed via EventBus
    researcher.researchAll().catch((err) => {
      console.error('[IPC] Supplier research failed:', err);
    });
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
