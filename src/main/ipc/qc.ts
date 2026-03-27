import { registerHandler } from './register';
import type { QCRunner, EventBus, ProjectStore } from '../../shared/types/services';
import type { QCConfig, FilterConditionQC } from '../../shared/types/classification';
import { DEFAULT_QC_CONFIG } from '../services/qc';

export function registerQCHandlers(qc: QCRunner, eventBus: EventBus, project: ProjectStore): void {
  registerHandler('qc:count', async (_event, scope: unknown) =>
    qc.getSupplierCount(scope as FilterConditionQC[] | undefined)
  );

  registerHandler('qc:run', async (_event, config: unknown) => {
    // Fire-and-forget — progress is streamed via EventBus
    qc.runQC(config as QCConfig | undefined).catch((err) => {
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

  registerHandler('qc:getConfig', async () => {
    const saved = await project.getSetting('qc_config') as QCConfig | null;
    return saved ?? DEFAULT_QC_CONFIG;
  });

  registerHandler('qc:setConfig', async (_event, config: unknown) => {
    await project.setSetting('qc_config', config as QCConfig);
  });

  registerHandler('qc:getDefaults', async () => {
    return DEFAULT_QC_CONFIG;
  });
}
