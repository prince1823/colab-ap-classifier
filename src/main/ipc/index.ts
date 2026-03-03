import { registerHandler } from './register';
import { registerColabipHandlers } from './colabip';
import { registerProjectHandlers } from './project';
import { registerChangelogHandlers } from './changelog';
import { registerTaxonomyHandlers } from './taxonomy';
import { registerIngestHandlers } from './ingest';
import { registerSuppliersHandlers } from './suppliers';
import { registerSupplierResearchHandlers } from './supplier-research';
import { registerRulesHandlers } from './rules';
import { registerTransactionsHandlers } from './transactions';
import { registerPipelineHandlers } from './pipeline';
import { registerExportHandlers } from './export';

export function registerAllHandlers(): void {
  // Test channel — proves IPC is working end-to-end
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers
  registerColabipHandlers();
  registerProjectHandlers();
  registerChangelogHandlers();
  registerTaxonomyHandlers();
  registerIngestHandlers();
  registerSuppliersHandlers();
  registerSupplierResearchHandlers();
  registerRulesHandlers();
  registerTransactionsHandlers();
  registerPipelineHandlers();
  registerExportHandlers();
}
