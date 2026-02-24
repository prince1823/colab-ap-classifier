import { registerHandler } from './register';
import {
  getSettings,
  updateSettings,
  getModels,
  getProviders,
} from '../services/settings';
import type { SettingsUpdateInput } from '../../shared/types/settings';

export function registerSettingsHandlers(): void {
  registerHandler('settings:get', async () => {
    return getSettings();
  });

  registerHandler('settings:update', async (_event, input: unknown) => {
    updateSettings(input as SettingsUpdateInput);
  });

  registerHandler('settings:getModels', async (_event, provider?: unknown) => {
    return getModels(typeof provider === 'string' ? provider : undefined);
  });

  registerHandler('settings:getProviders', async () => {
    return getProviders();
  });
}
