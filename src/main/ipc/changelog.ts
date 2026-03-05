import { registerHandler } from './register';
import type { ChangelogStore } from '../../shared/types/services';

export function registerChangelogHandlers(changelog: ChangelogStore): void {
  registerHandler('changelog:list', async () => {
    return changelog.listChanges();
  });

  registerHandler('changelog:revert', async (_event, ...args: unknown[]) => {
    const changeId = args[0] as string;
    return changelog.revertChange(changeId);
  });
}
