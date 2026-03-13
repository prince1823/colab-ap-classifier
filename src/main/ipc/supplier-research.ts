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
    // Look up supplier name from ID — research service needs the name for web search
    const supplier = await suppliers.getProjectSupplier(supplierId as string);
    if (!supplier) throw new Error(`Supplier not found: ${supplierId}`);

    // Skip research for tail spend suppliers
    if (supplier.isTailSpend) {
      return null;
    }

    const info = await researcher.researchSingle(supplier.supplierName);

    // Persist research results to project_suppliers and mark as researched
    await suppliers.updateSupplier(supplierId as string, { supplierInfo: info });
    await suppliers.markResearched(supplierId as string);

    return info;
  });
}
