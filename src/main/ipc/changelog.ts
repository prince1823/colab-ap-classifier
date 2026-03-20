import { registerHandler } from './register';
import type { ChangelogStore } from '../../shared/types/services';
import type { ChangelogFilter } from '../../shared/types/changelog';

export function registerChangelogHandlers(changelog: ChangelogStore): void {
  registerHandler('changelog:list', async (_event, filter: unknown) => {
    return changelog.listChangesPaginated(filter as ChangelogFilter | undefined);
  });

  registerHandler('changelog:revert', async (_event, changeId: unknown) => {
    return changelog.revertChange(changeId as string);
  });
}
