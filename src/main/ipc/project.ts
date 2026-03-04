import { registerHandler } from './register';
import type { ProjectStore } from '../../shared/types/services';

export function registerProjectHandlers(project: ProjectStore): void {
  registerHandler('project:new', async (_event, projectName: unknown, filePath?: unknown) => {
    let targetPath = filePath as string | undefined;
    if (!targetPath) {
      const selected = await project.selectSavePath();
      if (!selected) return null;
      targetPath = selected;
    }
    return project.createProject(projectName as string, targetPath);
  });

  registerHandler('project:open', async (_event, filePath?: unknown) => {
    let targetPath = filePath as string | undefined;
    if (!targetPath) {
      const selected = await project.selectOpenPath();
      if (!selected) return null;
      targetPath = selected;
    }
    return project.openProject(targetPath);
  });

  registerHandler('project:close', async () => {
    await project.closeProject();
  });

  registerHandler('project:getSetting', async (_event, key: unknown) => {
    return project.getSetting(key as string);
  });

  registerHandler('project:setSetting', async (_event, key: unknown, value: unknown) => {
    await project.setSetting(key as string, value);
  });

  registerHandler('project:deleteSetting', async (_event, key: unknown) => {
    await project.deleteSetting(key as string);
  });

  registerHandler('project:getAllSettings', async () => {
    return project.getAllSettings();
  });
}
