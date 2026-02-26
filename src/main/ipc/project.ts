import { registerHandler } from './register';
import {
  selectSavePath,
  selectOpenPath,
  createProject,
  openProject,
  closeProject,
  getMetadata,
  updateMetadata,
} from '../services/project';
import type { ProjectMetadataUpdate } from '../../shared/types';

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

  registerHandler('project:getMetadata', async () => {
    return getMetadata();
  });

  registerHandler('project:updateMetadata', async (_event, updates: unknown) => {
    await updateMetadata(updates as ProjectMetadataUpdate);
  });
}
