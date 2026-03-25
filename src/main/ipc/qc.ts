import { registerHandler } from './register';
import type { QCRunner, EventBus } from '../../shared/types/services';
import type { TransactionFilter } from '../../shared/types/transactions';

export function registerQCHandlers(qc: QCRunner, eventBus: EventBus): void {
  registerHandler('qc:count', async (_event, filter: unknown) =>
    qc.getSupplierCount(filter as TransactionFilter | undefined)
  );

  registerHandler('qc:start', async (_event, filter: unknown) => {
    // Fire-and-forget — progress is streamed via EventBus
    qc.runQC(filter as TransactionFilter | undefined).catch((err) => {
      console.error('[IPC] QC failed:', err);
      eventBus.emit('qc:progress', {
        status: 'failed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      });
    });
  });

  registerHandler('qc:stop', async () => {
    qc.stop();
  });

  registerHandler('qc:isRunning', async () => {
    return qc.getIsRunning();
  });
}
