import { registerHandler } from './register';
import * as classificationService from '../services/classification';

export function registerClassificationHandlers(): void {
  registerHandler('classification:start', async () => {
    // Fire-and-forget — progress is streamed via events
    classificationService.startClassification().catch((err) => {
      console.error('[IPC] Classification failed:', err);
    });
    return { started: true };
  });

  registerHandler('classification:cancel', async () => {
    await classificationService.cancel();
  });
}
