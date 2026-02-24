import { registerHandler } from './register';
import {
  listRecent,
  clearRecent,
  removeRecent,
} from '../services/recent-projects';

export function registerRecentProjectsHandlers(): void {
  registerHandler('recentProjects:list', async () => {
    return listRecent();
  });

  registerHandler('recentProjects:clear', async () => {
    await clearRecent();
  });

  registerHandler('recentProjects:remove', async (_event, filePath: unknown) => {
    await removeRecent(filePath as string);
  });
}
