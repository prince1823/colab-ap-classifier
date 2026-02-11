import { registerHandler } from './register';
import {
  isProjectOpen,
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
  registerHandler('project:isOpen', () => {
    return isProjectOpen();
  });

  registerHandler('project:selectSavePath', async () => {
    return selectSavePath();
  });

  registerHandler('project:selectOpenPath', async () => {
    return selectOpenPath();
  });

  registerHandler('project:new', async (_event, projectName: unknown) => {
    const result = await createProject(projectName as string);

    // TODO: call addRecent from recent-projects service when it exists
    // e.g. addRecent({ path: result.filePath, name: result.name, lastOpened: new Date().toISOString() });

    return result;
  });

  registerHandler('project:open', async (_event, filePath: unknown) => {
    const result = await openProject(filePath as string);

    // TODO: call addRecent from recent-projects service when it exists
    // e.g. addRecent({ path: result.filePath, name: result.name, lastOpened: new Date().toISOString() });

    return result;
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
