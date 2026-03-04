import { registerHandler } from './register';
import type { ServiceContainer } from '../container';
import { registerProjectHandlers } from './project';
import { registerChangelogHandlers } from './changelog';
import { registerTaxonomyHandlers } from './taxonomy';
import { registerIngestHandlers } from './ingest';
import { registerSuppliersHandlers } from './suppliers';
import { registerSupplierResearchHandlers } from './supplier-research';
import { registerClassificationHandlers } from './classification';
import { registerRulesHandlers } from './rules';
import { registerTransactionsHandlers } from './transactions';
import { registerExportHandlers } from './export';

export function registerAllHandlers(services: ServiceContainer): void {
  // Test channel
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers
  registerProjectHandlers(services.project, services.db);
  registerChangelogHandlers(services.changelog);
  registerTaxonomyHandlers(services.taxonomy);
  registerIngestHandlers(services.ingest);
  registerSuppliersHandlers(services.suppliers, services.researcher);
  registerSupplierResearchHandlers(services.researcher);
  registerClassificationHandlers(services.classifier);
  registerRulesHandlers(services.rules);
  registerTransactionsHandlers(services.transactions);
  registerExportHandlers(services.export);
}
