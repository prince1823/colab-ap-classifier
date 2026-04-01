import { registerHandler } from './register';
import type { TaxonomyStore } from '../../shared/types/services';

export function registerTaxonomyHandlers(taxonomy: TaxonomyStore): void {
  registerHandler('taxonomy:getNodeCount', async () => {
    return taxonomy.getNodeCount();
  });

  registerHandler('taxonomy:getNodes', async () => {
    return taxonomy.getNodes();
  });

  registerHandler('taxonomy:addNode', async (_event, fullPath: unknown, description?: unknown) => {
    return taxonomy.addNode(fullPath as string, description as string | undefined);
  });

  registerHandler('taxonomy:updateNode', async (_event, nodeId: unknown, updates: unknown) => {
    await taxonomy.updateNode(nodeId as string, updates as { description?: string });
  });

  registerHandler('taxonomy:renameNode', async (_event, nodeId: unknown, newName: unknown) => {
    await taxonomy.renameNode(nodeId as string, newName as string);
  });

  registerHandler('taxonomy:mergeNodes', async (_event, sourceId: unknown, targetId: unknown) => {
    return taxonomy.mergeNodes(sourceId as string, targetId as string);
  });

  registerHandler('taxonomy:deleteNode', async (_event, nodeId: unknown) => {
    return taxonomy.deleteNode(nodeId as string);
  });

  registerHandler('taxonomy:importFromFile', async (_event, filePath: unknown) => {
    return taxonomy.importFromFile(filePath as string);
  });
}
