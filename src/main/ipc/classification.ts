import { registerHandler } from './register';
import type { ClassificationRunner, EventBus } from '../../shared/types/services';

export function registerClassificationHandlers(classifier: ClassificationRunner, eventBus: EventBus): void {
  registerHandler('classification:start', async () => {
    // Fire-and-forget — progress is streamed via EventBus
    classifier.classifyAll().catch((err) => {
      console.error('[IPC] Classification failed:', err);
      // Safety net: emit failed event so renderer is always notified
      eventBus.emit('classification:progress', {
        status: 'failed',
        totalSuppliers: 0,
        processedSuppliers: 0,
        percentage: 0,
        currentSupplier: null,
        currentStep: err instanceof Error ? err.message : String(err),
      });
    });
  });

  registerHandler('classification:cancel', async () => {
    await classifier.cancel();
  });
}
