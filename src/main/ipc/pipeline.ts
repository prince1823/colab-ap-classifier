import { registerHandler } from './register';
import * as pipelineService from '../services/pipeline';

export function registerPipelineHandlers(): void {
  registerHandler('pipeline:start', async () => {
    // Fire-and-forget — progress is streamed via events
    pipelineService.startPipeline().catch((err) => {
      console.error('[IPC] Pipeline failed:', err);
    });
    return { started: true };
  });

  registerHandler('pipeline:approve', async () => {
    pipelineService.approve();
  });

  registerHandler('pipeline:cancel', async () => {
    await pipelineService.cancel();
  });
}
