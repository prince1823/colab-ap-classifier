import { registerHandler } from './register';
import { listTaxonomies } from '../services/colabip';

export function registerColabipHandlers(): void {
  registerHandler('colabip:listTaxonomies', async () => {
    return listTaxonomies();
  });
}
