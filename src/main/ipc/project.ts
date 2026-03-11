import { registerHandler } from './register';
import type { ProjectStore, Database, SupplierUniverse } from '../../shared/types/services';
import type { ProjectMetadata, ProjectMetadataUpdate, CompanyContext } from '../../shared/types/project';

export function registerProjectHandlers(project: ProjectStore, db: Database, supplierUniverse: SupplierUniverse): void {
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

  registerHandler('project:finalizeOpen', async () => {
    await supplierUniverse.open();
    const settings = await project.getAllSettings();
    return {
      filePath: db.getFilePath() ?? '',
      name: (settings.project_name as string) ?? 'Untitled',
    };
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

  // Compatibility: assemble ProjectMetadata from settings KV store
  registerHandler('project:getMetadata', async () => {
    const settings = await project.getAllSettings();
    return {
      id: '',
      projectName: (settings.project_name as string) ?? 'Untitled',
      filePath: db.getFilePath(),
      createdAt: '',
      companyContext: (settings.company_context as CompanyContext) ?? null,
      taxonomyName: (settings.taxonomy_name as string) ?? null,
      tailSpendThreshold: (settings.tail_spend_threshold as number) ?? 10000,
    } satisfies ProjectMetadata;
  });

  registerHandler('project:updateMetadata', async (_event, updates: unknown) => {
    const u = updates as ProjectMetadataUpdate;
    if (u.companyContext !== undefined) {
      await project.setSetting('company_context', u.companyContext);
    }
    if (u.taxonomyName !== undefined) {
      await project.setSetting('taxonomy_name', u.taxonomyName);
    }
    if (u.tailSpendThreshold !== undefined) {
      await project.setSetting('tail_spend_threshold', u.tailSpendThreshold);
    }
  });
}
