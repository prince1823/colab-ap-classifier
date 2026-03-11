import { registerHandler } from './register';
import type { ClassificationRunner, EventBus } from '../../shared/types/services';
import type { FilterCondition } from '../../shared/types/transactions';

export function registerClassificationHandlers(classifier: ClassificationRunner, eventBus: EventBus): void {
  registerHandler('classification:start', async (_event, ...args: unknown[]) => {
    const conditions = args[0] as FilterCondition[] | undefined;
    // Fire-and-forget — progress is streamed via EventBus
    classifier.classifyAll(conditions).catch((err) => {
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

  registerHandler('classification:scopeCount', async (_event, ...args: unknown[]) => {
    const conditions = args[0] as FilterCondition[] | undefined;
    return classifier.getScopeCount(conditions);
  });
}
