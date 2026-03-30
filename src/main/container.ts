import type {
  Database,
  SupplierUniverse,
  EventBus,
  LLMClient,
  WebSearch,
  ClassificationAgent,
  ResearchAgent,
  ColumnMappingAgent,
  FeedbackAgent,
  CatAAgent,
  IAppConfigService,
  ILicenseService,
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
  QCRunner as IQCRunner,
  QCAgent as IQCAgent,
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
import { LLMFeedbackAgent } from './agents/feedback-agent';
import { LLMCatAAgent } from './agents/cat-a-agent';
import { LLMQCAgent } from './agents/qc-agent';
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
import { QCRunner } from './services/qc';
import { LicenseService } from './services/license-service';

export interface ServiceContainer {
  // Leaf
  db: Database;
  supplierUniverse: SupplierUniverse;
  eventBus: EventBus;
  llm: LLMClient;
  appConfig: IAppConfigService;
  webSearch: WebSearch;
  license: ILicenseService;
  // Agents
  classificationAgent: ClassificationAgent;
  researchAgent: ResearchAgent;
  columnMappingAgent: ColumnMappingAgent;
  feedbackAgent: FeedbackAgent;
  catAAgent: CatAAgent;
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
  qc: IQCRunner;
}

export function createContainer(): ServiceContainer {
  // Leaf layer
  const db = new DuckDBDatabase();
  const appConfig = new AppConfigService();
  const supplierUniverse = new DuckDBSupplierUniverse(appConfig);
  const llm = new OpenRouterLLMClient(appConfig);
  const webSearch = new ExaWebSearch(appConfig);
  const license = new LicenseService(appConfig, eventBus);

  // Agents
  const classificationAgent = new LLMClassificationAgent(llm);
  const researchAgent = new LLMResearchAgent(llm);
  const columnMappingAgent = new LLMColumnMappingAgent(llm);
  const feedbackAgent = new LLMFeedbackAgent(llm);
  const catAAgent: CatAAgent = new LLMCatAAgent(llm);
  const qcAgent: IQCAgent = new LLMQCAgent(llm);

  // Data layer (order matters — respect dependency graph)
  const changelog = new ChangelogStore(db);
  const transactions = new TransactionStore(db, changelog);
  const project = new ProjectStore(db, transactions, supplierUniverse);
  const taxonomy = new TaxonomyStore(db, project);
  const suppliers = new SupplierService(db, supplierUniverse);
  const rules = new RuleStore(db, transactions, project);
  const ingest = new IngestService(db, transactions, suppliers, columnMappingAgent, eventBus);
  const exportSvc = new ExportService(db);

  // Orchestrators
  const researcher = new SupplierResearcher(
    supplierUniverse, webSearch, researchAgent, eventBus, suppliers,
    classificationAgent, transactions, catAAgent, taxonomy, rules
  );
  const classifier = new ClassificationRunner(
    db, taxonomy, project, rules,
    transactions, changelog, classificationAgent, eventBus, supplierUniverse, suppliers
  );
  const qc = new QCRunner(db, transactions, eventBus, qcAgent, supplierUniverse, project, taxonomy, suppliers);

  return {
    db, supplierUniverse, eventBus, llm, appConfig, webSearch, license,
    classificationAgent, researchAgent, columnMappingAgent, feedbackAgent, catAAgent,
    changelog, transactions, project, taxonomy, suppliers, rules,
    ingest, export: exportSvc, researcher, classifier, qc,
  };
}
