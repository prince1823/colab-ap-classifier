import { registerHandler } from './register';
import type { ChangelogStore } from '../../shared/types/services';

export function registerChangelogHandlers(changelog: ChangelogStore): void {
  registerHandler('changelog:list', async () => {
    return changelog.listChanges();
  });

  registerHandler('changelog:revert', async (_event, changeId: unknown) => {
    return changelog.revertChange(changeId as string);
  });
}
