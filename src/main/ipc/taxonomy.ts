import { registerHandler } from './register';
import {
  getNodes,
  addNode,
  updateNode,
  deleteNode,
  importFromColabip,
} from '../services/taxonomy';

export function registerTaxonomyHandlers(): void {
  registerHandler('taxonomy:getNodes', async () => {
    return getNodes();
  });

  registerHandler('taxonomy:addNode', async (_event, fullPath: unknown, description?: unknown) => {
    return addNode(fullPath as string, description as string | undefined);
  });

  registerHandler('taxonomy:updateNode', async (_event, nodeId: unknown, updates: unknown) => {
    await updateNode(nodeId as string, updates as { description?: string });
  });

  registerHandler('taxonomy:deleteNode', async (_event, nodeId: unknown) => {
    await deleteNode(nodeId as string);
  });

  registerHandler('taxonomy:importFromColabip', async (_event, industryName: unknown) => {
    await importFromColabip(industryName as string);
  });
}
