import { registerHandler } from './register';
import * as classificationPipeline from '../services/classification-pipeline';
import type { ClassificationStartOptions } from '../../shared/types';

export function registerClassificationHandlers(): void {
  registerHandler('classification:start', async (_event, options: unknown) => {
    return classificationPipeline.startClassification(
      options as ClassificationStartOptions
    );
  });

  registerHandler('classification:getStatus', async () => {
    return classificationPipeline.getStatus();
  });

  registerHandler('classification:cancel', async (_event, runId: unknown) => {
    return classificationPipeline.cancelClassification(runId as string);
  });
}
