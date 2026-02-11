import { registerHandler } from './register';
import { listTaxonomies, listRulePacks } from '../services/colabip';

export function registerColabipHandlers(): void {
  registerHandler('colabip:listTaxonomies', async () => {
    return listTaxonomies();
  });

  registerHandler('colabip:listRulePacks', async () => {
    return listRulePacks();
  });
}
