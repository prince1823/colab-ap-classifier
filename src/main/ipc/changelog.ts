import { registerHandler } from './register';
import { listChanges, revertChange } from '../services/changelog';

export function registerChangelogHandlers(): void {
  registerHandler('changelog:list', async () => {
    return listChanges();
  });

  registerHandler('changelog:revert', async (_event, ...args: unknown[]) => {
    const changeId = args[0] as string;
    await revertChange(changeId);
  });
}
