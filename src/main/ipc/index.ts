import { registerHandler } from './register';
import { registerColabipHandlers } from './colabip';
import { registerProjectHandlers } from './project';
import { registerRecentProjectsHandlers } from './recent-projects';
import { registerSettingsHandlers } from './settings';
import { registerChangelogHandlers } from './changelog';
import { registerTaxonomyHandlers } from './taxonomy';
import { registerUploadHandlers } from './upload';
import { registerSuppliersHandlers } from './suppliers';
import { registerCanonicalizationHandlers } from './canonicalization';
import { registerSupplierResearchHandlers } from './supplier-research';
import { registerRulesHandlers } from './rules';
import { registerTransactionsHandlers } from './transactions';

export function registerAllHandlers(): void {
  // Test channel — proves IPC is working end-to-end
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers
  registerColabipHandlers();
  registerProjectHandlers();
  registerRecentProjectsHandlers();
  registerSettingsHandlers();
  registerChangelogHandlers();
  registerTaxonomyHandlers();
  registerUploadHandlers();
  registerSuppliersHandlers();
  registerCanonicalizationHandlers();
  registerSupplierResearchHandlers();
  registerRulesHandlers();
  registerTransactionsHandlers();
}
