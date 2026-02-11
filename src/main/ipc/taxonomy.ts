import { registerHandler } from './register';
import {
  getTaxonomyMetadata,
  getNodes,
  setTaxonomy,
  importFromColabip,
} from '../services/taxonomy';
import type { TaxonomySetInput } from '../../shared/types';

export function registerTaxonomyHandlers(): void {
  registerHandler('taxonomy:get', async () => {
    return getTaxonomyMetadata();
  });

  registerHandler('taxonomy:getNodes', async () => {
    return getNodes();
  });

  registerHandler('taxonomy:set', async (_event, input: unknown) => {
    await setTaxonomy(input as TaxonomySetInput);
  });

  registerHandler('taxonomy:importFromColabip', async (_event, industryName: unknown) => {
    await importFromColabip(industryName as string);
  });
}
