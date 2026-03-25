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
import { registerSettingsHandlers } from './settings';
import { registerSupplierUniverseHandlers } from './supplier-universe';
import { registerLicenseHandlers } from './license';
import { registerFeedbackHandlers } from './feedback';
import { registerQCHandlers } from './qc';

export function registerAllHandlers(services: ServiceContainer): void {
  // Test channel
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers
  registerProjectHandlers(services.project, services.db, services.supplierUniverse, services.suppliers);
  registerChangelogHandlers(services.changelog);
  registerTaxonomyHandlers(services.taxonomy);
  registerIngestHandlers(services.ingest);
  registerSuppliersHandlers(services.suppliers, services.researcher);
  registerSupplierResearchHandlers(services.researcher, services.suppliers);
  registerClassificationHandlers(services.classifier, services.eventBus);
  registerRulesHandlers(services.rules);
  registerTransactionsHandlers(services.transactions);
  registerExportHandlers(services.export);
  registerSettingsHandlers(services.appConfig);
  registerSupplierUniverseHandlers(services.supplierUniverse);
  registerLicenseHandlers(services.license);
  registerFeedbackHandlers(
    services.feedbackAgent, services.changelog, services.taxonomy,
    services.project, services.suppliers, services.rules,
  );
  registerQCHandlers(services.qc, services.eventBus, services.project);
}
