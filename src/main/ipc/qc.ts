import { registerHandler } from './register';
import type { QCRunner, EventBus } from '../../shared/types/services';

export function registerQCHandlers(qc: QCRunner, eventBus: EventBus): void {
  registerHandler('qc:start', async () => {
    // Fire-and-forget — progress is streamed via EventBus
    qc.runQC().catch((err) => {
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

  registerHandler('qc:cancel', async () => {
    qc.cancel();
  });

  registerHandler('qc:isRunning', async () => {
    return qc.getIsRunning();
  });
}
