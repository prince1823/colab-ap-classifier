import { registerHandler } from './register';
import type { ClassificationRunner } from '../../shared/types/services';

export function registerClassificationHandlers(classifier: ClassificationRunner): void {
  registerHandler('classification:start', async () => {
    // Fire-and-forget — progress is streamed via EventBus
    classifier.classifyAll().catch((err) => {
      console.error('[IPC] Classification failed:', err);
    });
  });

  registerHandler('classification:cancel', async () => {
    await classifier.cancel();
  });
}
