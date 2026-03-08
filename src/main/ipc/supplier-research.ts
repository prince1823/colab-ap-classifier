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

  registerHandler('suppliers:researchSingle', async (_event, supplierName: unknown) => {
    const info = await researcher.researchSingle(supplierName as string);

    // Persist research results to project_suppliers and mark as researched
    await suppliers.updateSupplier(supplierName as string, { supplierInfo: info });
    await suppliers.markResearched(supplierName as string);

    return info;
  });
}
