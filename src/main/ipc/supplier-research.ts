import { registerHandler } from './register';
import { researchAllProjectSuppliers, cancel } from '../services/supplier-research';

export function registerSupplierResearchHandlers(): void {
  registerHandler('suppliers:research', async () => {
    // Fire-and-forget — progress is streamed via events
    researchAllProjectSuppliers().catch((err) => {
      console.error('[IPC] Supplier research failed:', err);
    });
    return { started: true };
  });

  registerHandler('suppliers:research:cancel', async () => {
    cancel();
  });
}
