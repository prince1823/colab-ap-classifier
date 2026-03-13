import { registerHandler } from './register';
import type { ILicenseService } from '../../shared/types/services';

export function registerLicenseHandlers(license: ILicenseService): void {
  registerHandler('license:activate', async (_event, key: unknown) => {
    return license.activate(key as string);
  });

  registerHandler('license:getStatus', async () => {
    return license.getStatus();
  });

  registerHandler('license:checkNow', async () => {
    return license.checkNow();
  });
}
