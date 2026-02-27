import { registerHandler } from './register';
import * as pipelineService from '../services/pipeline';

export function registerClassificationHandlers(): void {
  registerHandler('classification:start', async () => {
    // Fire-and-forget — progress is streamed via events
    pipelineService.startPipeline().catch((err) => {
      console.error('[IPC] Pipeline failed:', err);
    });
    return { started: true };
  });

  registerHandler('classification:approve', async () => {
    pipelineService.approve();
  });

  registerHandler('classification:cancel', async () => {
    await pipelineService.cancel();
  });
}
