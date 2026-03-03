import { registerHandler } from './register';
import {
  selectSavePath,
  selectOpenPath,
  createProject,
  openProject,
  closeProject,
  getSetting,
  setSetting,
  deleteSetting,
  getAllSettings,
} from '../services/project';

export function registerProjectHandlers(): void {
  registerHandler('project:new', async (_event, projectName: unknown, filePath?: unknown) => {
    // If no filePath, prompt user with save dialog
    let targetPath = filePath as string | undefined;
    if (!targetPath) {
      const selected = await selectSavePath();
      if (!selected) return null; // user cancelled
      targetPath = selected;
    }
    return createProject(projectName as string, targetPath);
  });

  registerHandler('project:open', async (_event, filePath?: unknown) => {
    // If no filePath, prompt user with open dialog
    let targetPath = filePath as string | undefined;
    if (!targetPath) {
      const selected = await selectOpenPath();
      if (!selected) return null; // user cancelled
      targetPath = selected;
    }
    return openProject(targetPath);
  });

  registerHandler('project:close', async () => {
    await closeProject();
  });

  registerHandler('project:getSetting', async (_event, key: unknown) => {
    return getSetting(key as string);
  });

  registerHandler('project:setSetting', async (_event, key: unknown, value: unknown) => {
    await setSetting(key as string, value);
  });

  registerHandler('project:deleteSetting', async (_event, key: unknown) => {
    await deleteSetting(key as string);
  });

  registerHandler('project:getAllSettings', async () => {
    return getAllSettings();
  });
}
