import type {
  Database,
  SupplierUniverse,
  EventBus,
  LLMClient,
  WebSearch,
  ClassificationAgent,
  ResearchAgent,
  ColumnMappingAgent,
  IAppConfigService,
  ChangelogStore as IChangelogStore,
  TransactionStore as ITransactionStore,
  ProjectStore as IProjectStore,
  TaxonomyStore as ITaxonomyStore,
  SupplierService as ISupplierService,
  RuleStore as IRuleStore,
  IngestService as IIngestService,
  ExportService as IExportService,
  SupplierResearcher as ISupplierResearcher,
  ClassificationRunner as IClassificationRunner,
} from '../shared/types/services';

import { DuckDBDatabase } from './services/database';
import { DuckDBSupplierUniverse } from './services/supplier-universe';
import { eventBus } from './event-bus';
import { OpenRouterLLMClient } from './services/llm-client';
import { AppConfigService } from './services/app-config';
import { ExaWebSearch } from './services/exa-search';
import { LLMClassificationAgent } from './agents/classification-agent';
import { LLMResearchAgent } from './agents/research-agent';
import { LLMColumnMappingAgent } from './agents/column-mapping-agent';
import { ChangelogStore } from './services/changelog';
import { TransactionStore } from './services/transactions';
import { ProjectStore } from './services/project';
import { TaxonomyStore } from './services/taxonomy';
import { SupplierService } from './services/supplier-service';
import { RuleStore } from './services/rules';
import { IngestService } from './services/ingest';
import { ExportService } from './services/export';
import { SupplierResearcher } from './services/supplier-research';
import { ClassificationRunner } from './services/classification';

export interface ServiceContainer {
  // Leaf
  db: Database;
  supplierUniverse: SupplierUniverse;
  eventBus: EventBus;
  llm: LLMClient;
  appConfig: IAppConfigService;
  webSearch: WebSearch;
  // Agents
  classificationAgent: ClassificationAgent;
  researchAgent: ResearchAgent;
  columnMappingAgent: ColumnMappingAgent;
  // Data
  changelog: IChangelogStore;
  transactions: ITransactionStore;
  project: IProjectStore;
  taxonomy: ITaxonomyStore;
  suppliers: ISupplierService;
  rules: IRuleStore;
  ingest: IIngestService;
  export: IExportService;
  // Orchestrators
  researcher: ISupplierResearcher;
  classifier: IClassificationRunner;
}

export function createContainer(): ServiceContainer {
  // Leaf layer
  const db = new DuckDBDatabase();
  const supplierUniverse = new DuckDBSupplierUniverse();
  const appConfig = new AppConfigService();
  const llm = new OpenRouterLLMClient(appConfig);

  // Wire configured supplier universe path
  const configuredPath = appConfig.getSupplierUniversePath();
  if (configuredPath) {
    supplierUniverse.setDefaultPath(configuredPath);
  }
  const webSearch = new ExaWebSearch();

  // Agents
  const classificationAgent = new LLMClassificationAgent(llm);
  const researchAgent = new LLMResearchAgent(llm);
  const columnMappingAgent = new LLMColumnMappingAgent(llm);

  // Data layer (order matters — respect dependency graph)
  const changelog = new ChangelogStore(db);
  const transactions = new TransactionStore(db, changelog);
  const project = new ProjectStore(db, transactions, supplierUniverse);
  const taxonomy = new TaxonomyStore(db, project);
  const suppliers = new SupplierService(db, supplierUniverse);
  const rules = new RuleStore(db, transactions);
  const ingest = new IngestService(db, transactions, suppliers, columnMappingAgent);
  const exportSvc = new ExportService(db);

  // Orchestrators
  const researcher = new SupplierResearcher(
    supplierUniverse, webSearch, researchAgent, eventBus
  );
  const classifier = new ClassificationRunner(
    db, taxonomy, project, rules,
    transactions, changelog, classificationAgent, eventBus, supplierUniverse
  );

  return {
    db, supplierUniverse, eventBus, llm, appConfig, webSearch,
    classificationAgent, researchAgent, columnMappingAgent,
    changelog, transactions, project, taxonomy, suppliers, rules,
    ingest, export: exportSvc, researcher, classifier,
  };
}
