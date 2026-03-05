import { registerHandler } from './register';
import type { SupplierResearcher } from '../../shared/types/services';

export function registerSupplierResearchHandlers(researcher: SupplierResearcher): void {
  registerHandler('suppliers:researchAll', async () => {
    // Fire-and-forget — progress is streamed via EventBus
    researcher.researchAll().catch((err) => {
      console.error('[IPC] Supplier research failed:', err);
    });
  });

  registerHandler('suppliers:researchSingle', async (_event, supplierName: unknown) => {
    return researcher.researchSingle(supplierName as string);
  });
}
