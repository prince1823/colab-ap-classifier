/**
 * Standalone full-run script for the classification pipeline.
 *
 * Runs the entire backend pipeline end-to-end against real data,
 * saving all output for manual inspection. No assertions, no test framework.
 *
 * Usage:
 *   npx tsx scripts/full-run.ts <run-dir>
 *
 * Run directory must contain:
 *   config.json   — project name, company context, column mapping, options
 *   input.csv     — transaction data
 *
 * Optional files in run directory:
 *   taxonomy.txt  — overrides the taxonomy name in config.json
 *   rules.json    — override rules (skipped if absent)
 *   universe.db   — pre-seeded supplier universe (copied into output, avoids re-researching)
 *
 * config.json format:
 *   {
 *     "projectName": "...",
 *     "companyContext": { ... },
 *     "columnMapping": { ... },
 *     "taxonomy": "healthcare_services",  // name under colabip/taxonomies/
 *     "skipSupplierResearch": false,
 *     "skipRules": false
 *   }
 *
 * Output is written to <run-dir>/output/run-<timestamp>/
 */

import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

// ─── Args & validation ──────────────────────────────────────────────────────

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: npx tsx scripts/full-run.ts <run-dir>');
  process.exit(1);
}

const resolvedDir = path.resolve(runDir);
const configPath = path.join(resolvedDir, 'config.json');

if (!fs.existsSync(configPath)) {
  console.error(`Missing config.json in ${resolvedDir}`);
  process.exit(1);
}

// CSV: try config.csvFile, then input.csv, then the only .csv in the dir
function findCSV(): string {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (cfg.csvFile) {
    const p = path.resolve(resolvedDir, cfg.csvFile);
    if (fs.existsSync(p)) return p;
    console.error(`csvFile specified but not found: ${p}`);
    process.exit(1);
  }
  const defaultPath = path.join(resolvedDir, 'input.csv');
  if (fs.existsSync(defaultPath)) return defaultPath;
  // Fallback: single .csv file in directory
  const csvFiles = fs.readdirSync(resolvedDir).filter(f => f.endsWith('.csv'));
  if (csvFiles.length === 1) return path.join(resolvedDir, csvFiles[0]);
  console.error(`No input.csv found in ${resolvedDir} (and no csvFile in config.json)`);
  process.exit(1);
}
const csvPath = findCSV();

// ─── Load env before any service imports ────────────────────────────────────
// Walk up from __dirname to find the nearest directory containing a .env file.
// This handles running from a git worktree where .env lives in the main repo root.

import { loadEnv, resetEnvLoaded } from '../src/main/load-env';

function findEnvRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.env'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return startDir; // fallback — loadEnv will silently skip if not found
}

resetEnvLoaded();
loadEnv(findEnvRoot(path.resolve(__dirname, '..')));

// ─── Parse config ───────────────────────────────────────────────────────────

interface RunConfig {
  projectName: string;
  companyContext: Record<string, string>;
  columnMapping: Record<string, string>;
  taxonomy?: string;
  columnPriorities?: string[];
  sampleCount?: number;
  skipSupplierResearch?: boolean;
  skipRules?: boolean;
}

const config: RunConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (!config.columnMapping) {
  console.error('config.json must have "columnMapping"');
  process.exit(1);
}
const columnMapping = config.columnMapping;

// Resolve taxonomy file: local taxonomy.txt > colabip taxonomy by name
const localTaxonomy = path.join(resolvedDir, 'taxonomy.txt');
let taxonomyPath: string;
if (fs.existsSync(localTaxonomy)) {
  taxonomyPath = localTaxonomy;
} else if (config.taxonomy) {
  taxonomyPath = path.resolve(__dirname, '..', 'colabip', 'taxonomies', config.taxonomy, 'taxonomy.txt');
  if (!fs.existsSync(taxonomyPath)) {
    console.error(`Taxonomy not found: ${taxonomyPath}`);
    process.exit(1);
  }
} else {
  console.error('No taxonomy.txt in run dir and no "taxonomy" name in config.json');
  process.exit(1);
}

// Rules (optional)
const rulesPath = path.join(resolvedDir, 'rules.json');
const hasRules = fs.existsSync(rulesPath) && !config.skipRules;

// ─── Output directory ───────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outputDir = path.join(resolvedDir, 'output', `run-${timestamp}`);
fs.mkdirSync(outputDir, { recursive: true });

// Set LLM_TRACE_FILE before any service module is imported.
// llm-trace.ts captures process.env.LLM_TRACE_FILE at evaluation time (module-level const),
// so this must be set before the first dynamic import of any service that transitively uses it.
const TRACE_PATH = path.join(outputDir, 'trace.jsonl');
process.env.LLM_TRACE_FILE = TRACE_PATH;

const DEBUG_LOG_PATH = path.join(outputDir, 'debug.log');
process.env.LOG_FILE = DEBUG_LOG_PATH;

const DB_PATH = path.join(outputDir, 'project.c91');
const UNIVERSE_PATH = path.join(outputDir, 'universe.db');
const EXPORT_PATH = path.join(outputDir, 'classified.csv');
const LOG_PATH = path.join(outputDir, 'run.log');

// Copy seed universe if provided in run directory
const seedUniverse = [
  path.join(resolvedDir, 'universe.db'),
  path.join(resolvedDir, 'supplier_universe.db'),
].find(p => fs.existsSync(p));
if (seedUniverse) {
  fs.copyFileSync(seedUniverse, UNIVERSE_PATH);
}

// ─── Logger ─────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// Service imports are done dynamically inside main() so that LLM_TRACE_FILE is set
// before llm-trace.ts is first evaluated (it captures the env var at module load time).

// ─── Trace tail (mirrors trace.jsonl summaries into run.log) ─────────────────
//
// Polls trace.jsonl by byte position at a fixed interval. Completely external to
// the agent/LLM hot path — no changes to llm-trace.ts or any agent.

type TraceEntry = import('../src/main/utils/llm-trace').TraceEntry;

function formatTraceSummary(entry: TraceEntry): string | null {
  if (entry.agent === 'research') return null; // already logged in research loop
  const ms = `(${entry.elapsedMs}ms)`;
  const err = entry.error ? ` ⚠ ${entry.error}` : '';
  switch (entry.agent) {
    case 'classification-l3':
      // supplier omitted on legacy single-supplier path — falls back to '?'
      return `    [LLM] l3: ${entry.supplier ?? '?'} — ${entry.groupCount ?? 0} groups ${ms}${err}`;
    case 'classification-category':
      // groupCount not populated for category calls
      return `    [LLM] category: ${entry.supplier ?? `${entry.supplierCount ?? 0} suppliers`} ${ms}${err}`;
    case 'classification-tailspend-category':
      return `    [LLM] tailspend-category: ${entry.supplierCount ?? 0} suppliers, ${entry.groupCount ?? 0} groups ${ms}${err}`;
    case 'classification-tailspend-l3':
      return `    [LLM] tailspend-l3: ${entry.supplierCount ?? 0} suppliers, ${entry.groupCount ?? 0} groups ${ms}${err}`;
    case 'column-mapping':
      return `    [LLM] column-mapping ${ms}${err}`;
    case 'qc':
      return `    [LLM] qc ${ms}${err}`;
    default:
      return `    [LLM] ${entry.agent} ${ms}${err}`;
  }
}

function startTraceTail(tracePath: string): () => void {
  let lastPos = 0;

  const processNewLines = () => {
    let stat: fs.Stats;
    try { stat = fs.statSync(tracePath); } catch { return; }
    if (stat.size <= lastPos) return;

    const buf = Buffer.alloc(stat.size - lastPos);
    const fd = fs.openSync(tracePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, lastPos);
    fs.closeSync(fd);
    lastPos = stat.size;

    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TraceEntry;
        const summary = formatTraceSummary(entry);
        if (summary) log(summary);
      } catch { /* skip malformed lines */ }
    }
  };

  const interval = setInterval(processNewLines, 200);

  return () => {
    clearInterval(interval);
    processNewLines(); // flush any lines written since last tick
  };
}

// ─── CSV export (inline, no Electron dependency) ────────────────────────────

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function exportCSV(db: DuckDBDatabase, outPath: string): Promise<number> {
  const colRows = await db.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
  );
  const allColumns = colRows.map((r) => r.column_name);

  const metaColumns = ['id', 'row_index', 'upload_id', 'taxonomy_node_id',
    'classification_status', 'human_reviewed', 'flagged_for_review',
    'original_supplier_name', 'supplier_name', 'project_supplier_id', 'created_at', 'updated_at'];

  const canonicalColumns = allColumns.filter((c) => !metaColumns.includes(c));

  const rows = await db.all<Record<string, unknown>>(
    `SELECT t.*, tax.full_path as classification_path, ps.supplier_name as canonical_supplier_name
     FROM transactions t
     LEFT JOIN taxonomy tax ON t.taxonomy_node_id = tax.id
     LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
     ORDER BY t.row_index`
  );

  const headers = [
    ...canonicalColumns,
    'canonical_supplier_name',
    'classification_path',
    'classification_l1',
    'classification_l2',
    'classification_l3',
    'classification_status',
    'flagged_for_review',
  ];

  const csvLines: string[] = [headers.map(escapeCSV).join(',')];

  for (const row of rows) {
    const classificationPath = (row.classification_path as string) || '';
    const parts = classificationPath.split('|');
    const values = [
      ...canonicalColumns.map((col) => row[col] ?? ''),
      row.canonical_supplier_name ?? '',
      classificationPath,
      parts[0] || '',
      parts[1] || '',
      parts[2] || '',
      row.classification_status ?? 'unclassified',
      row.flagged_for_review ? 'true' : 'false',
    ];
    csvLines.push(values.map((v) => escapeCSV(String(v))).join(','));
  }

  fs.writeFileSync(outPath, csvLines.join('\r\n') + '\r\n', 'utf-8');
  return rows.length;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const timings: Array<{ phase: string; ms: number }> = [];

  function phase(name: string) {
    return {
      done: () => {
        const ms = Date.now() - (phase as any)._start;
        timings.push({ phase: name, ms });
        log(`  ✓ ${name} (${(ms / 1000).toFixed(1)}s)`);
      },
    };
  }

  // ─── Dynamic service imports (after LLM_TRACE_FILE is set) ────────────────
  const { DuckDBDatabase } = await import('../src/main/services/database');
  const { DuckDBSupplierUniverse } = await import('../src/main/services/supplier-universe');
  const { OpenRouterLLMClient } = await import('../src/main/services/llm-client');
  const { ExaWebSearch } = await import('../src/main/services/exa-search');
  const { LLMClassificationAgent } = await import('../src/main/agents/classification-agent');
  const { LLMResearchAgent } = await import('../src/main/agents/research-agent');
  const { LLMColumnMappingAgent } = await import('../src/main/agents/column-mapping-agent');
  const { ChangelogStore } = await import('../src/main/services/changelog');
  const { TransactionStore } = await import('../src/main/services/transactions');
  const { ProjectStore } = await import('../src/main/services/project');
  const { TaxonomyStore } = await import('../src/main/services/taxonomy');
  const { RuleStore } = await import('../src/main/services/rules');
  const { IngestService } = await import('../src/main/services/ingest');
  const { SupplierService } = await import('../src/main/services/supplier-service');
  const { SupplierResearcher } = await import('../src/main/services/supplier-research');
  const { ClassificationRunner } = await import('../src/main/services/classification');

  log(`Full run: ${config.projectName}`);
  log(`  Input:    ${csvPath}`);
  log(`  Taxonomy: ${taxonomyPath}`);
  log(`  Rules:    ${hasRules ? rulesPath : '(none)'}`);
  log(`  Universe: ${seedUniverse ? `seeded from ${seedUniverse}` : '(fresh)'}`);
  log(`  Output:   ${outputDir}`);
  log(`  Trace:    ${TRACE_PATH}`);
  log('');

  // ─── Bootstrap services ─────────────────────────────────────────────────

  const db = new DuckDBDatabase();
  // Minimal app config for script use — only LLM provider/model/universe path are needed.
  // License and key-storage methods are no-ops; API keys come from env vars via EnvLLMConfig.
  const scriptAppConfig = {
    getApiKey: (_provider: string) => null,
    setApiKey: async (_provider: string, _key: string) => {},
    getProvider: () => process.env.CLASSIFIER_LLM_PROVIDER ?? 'openrouter',
    setProvider: async (_provider: string) => {},
    getModel: () => process.env.CLASSIFIER_MODEL ?? 'claude-3-5-haiku-latest',
    setModel: async (_model: string) => {},
    getSupplierUniversePath: () => UNIVERSE_PATH,
    setSupplierUniversePath: async (_p: string) => {},
    clearSupplierUniversePath: async () => {},
    getLicenseKey: () => null,
    setLicenseKey: async (_key: string) => {},
    clearLicenseKey: async () => {},
    getLicenseData: () => null,
    setLicenseData: async (_data: unknown) => {},
  } as any;
  const supplierUniverse = new DuckDBSupplierUniverse(scriptAppConfig);
  const eventBus = new EventEmitter();
  const llm = new OpenRouterLLMClient();
  const webSearch = new ExaWebSearch();

  const classificationAgent = new LLMClassificationAgent(llm);
  const researchAgent = new LLMResearchAgent(llm);
  const columnMappingAgent = new LLMColumnMappingAgent(llm);

  const changelog = new ChangelogStore(db);
  const transactions = new TransactionStore(db, changelog);
  const project = new ProjectStore(db, transactions, supplierUniverse);
  const taxonomy = new TaxonomyStore(db, project);
  const rules = new RuleStore(db, transactions, project);
  const suppliers = new SupplierService(db, supplierUniverse);
  const ingest = new IngestService(db, transactions, suppliers, columnMappingAgent, eventBus as any);
  const researcher = new SupplierResearcher(
    supplierUniverse, webSearch, researchAgent, eventBus as any,
    suppliers, classificationAgent, transactions
  );
  const classifier = new ClassificationRunner(
    db, taxonomy, project, rules,
    transactions, changelog, classificationAgent, eventBus as any, supplierUniverse, suppliers
  );

  try {
    // ─── Phase 1: Create project ──────────────────────────────────────────

    let start = Date.now();
    await project.createProject(config.projectName, DB_PATH);
    await project.setSetting('company_context', config.companyContext);
    if (config.columnPriorities) {
      await project.setSetting('column_priorities', config.columnPriorities);
    }
    if (config.sampleCount !== undefined) {
      await project.setSetting('classification_sample_count', config.sampleCount);
    }
    timings.push({ phase: 'Create project', ms: Date.now() - start });
    log('  ✓ Create project');

    // ─── Phase 2: Load taxonomy ───────────────────────────────────────────

    start = Date.now();
    const taxResult = await taxonomy.importFromFile(taxonomyPath);
    const nodes = await taxonomy.getNodes();
    const l3Count = nodes.filter((n) => n.depth === 3).length;
    timings.push({ phase: 'Load taxonomy', ms: Date.now() - start });
    log(`  ✓ Load taxonomy: ${taxResult.nodeCount} nodes (${l3Count} L3)`);

    // ─── Phase 3: Import CSV ──────────────────────────────────────────────
    // Start trace tail here — covers all LLM calls from column-mapping through classification.
    const stopTraceTail = startTraceTail(TRACE_PATH);

    start = Date.now();
    await ingest.importCSV(csvPath, columnMapping);
    const importStats = await transactions.getStats();
    timings.push({ phase: 'Import CSV', ms: Date.now() - start });
    log(`  ✓ Import CSV: ${importStats.totalRows} rows`);

    // ─── Phase 4: Supplier normalization ──────────────────────────────────

    start = Date.now();
    const projectSuppliers = await suppliers.listProjectSuppliers();
    timings.push({ phase: 'Supplier normalization', ms: Date.now() - start });
    log(`  ✓ Supplier normalization: ${projectSuppliers.length} suppliers`);

    // ─── Phase 5: Supplier research ───────────────────────────────────────

    if (!config.skipSupplierResearch) {
      start = Date.now();
      log('  Researching suppliers:');
      const nonTailSpend = projectSuppliers.filter((ps) => !ps.isTailSpend);
      for (const ps of nonTailSpend) {
        const cached = await supplierUniverse.getSupplier(ps.supplierName);
        const hadSubstantiveInfo = !!(cached?.industry || cached?.description);
        const info = await researcher.researchSingle(ps.supplierName);
        // Write back research results to project_suppliers (mirrors IPC handler logic)
        await suppliers.updateSupplier(ps.id, { supplierInfo: info, markResearched: true });
        const source = hadSubstantiveInfo ? 'universe (cached)' : 'LLM';
        const industry = info.industry ? ` [${info.industry}]` : '';
        const desc = info.description ? ` — ${info.description.slice(0, 100)}` : '';
        log(`    ${ps.supplierName} → ${source}${industry}${desc}`);
      }
      timings.push({ phase: 'Supplier research', ms: Date.now() - start });
      log(`  ✓ Supplier research: ${nonTailSpend.length} suppliers (${projectSuppliers.length - nonTailSpend.length} tail-spend skipped)`);
    } else {
      log('  ⊘ Supplier research: skipped');
    }

    // ─── Phase 5b: Confirm all suppliers ──────────────────────────────────

    start = Date.now();
    for (const ps of projectSuppliers) {
      await suppliers.confirmSupplier(ps.id, 'confirmed');
    }
    timings.push({ phase: 'Confirm suppliers', ms: Date.now() - start });
    log(`  ✓ Confirm suppliers: ${projectSuppliers.length} confirmed`);

    // ─── Phase 5c: Categorize suppliers (populate l1_l2_path) ─────────────

    if (!config.skipSupplierResearch) {
      start = Date.now();
      const taxonomyNodes = await taxonomy.getNodes();
      const companyContext = config.companyContext;
      const columnPriorities = config.columnPriorities ?? [];

      await researcher.categorizeWithSupplierInfo(taxonomyNodes, companyContext);

      if (columnPriorities.length > 0) {
        await researcher.categorizeTailSpend(taxonomyNodes, companyContext, columnPriorities);
      }

      const updatedSuppliers = await suppliers.listProjectSuppliers();
      const withPath = updatedSuppliers.filter((s) => s.l1L2Path !== null);
      timings.push({ phase: 'Categorize suppliers', ms: Date.now() - start });
      log(`  ✓ Categorize suppliers: ${withPath.length}/${updatedSuppliers.length} with l1_l2_path`);
    } else {
      log('  ⊘ Categorize suppliers: skipped (research was skipped)');
    }

    // ─── Phase 6: Override rules ──────────────────────────────────────────

    if (hasRules) {
      start = Date.now();
      const rulesFixture = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
      const taxNodes = await taxonomy.getNodes();
      let ruleCount = 0;

      for (const rf of rulesFixture) {
        const targetNode = taxNodes.find((n: any) => n.fullPath === rf.targetTaxonomyPath);
        if (!targetNode) {
          log(`  ⚠ Rule "${rf.name}": taxonomy path not found: ${rf.targetTaxonomyPath}`);
          continue;
        }
        await rules.createRule({
          name: rf.name,
          groupedConditions: {
            groupConnector: 'AND' as const,
            groups: [{ connector: 'AND' as const, conditions: rf.conditions }],
          },
          targetTaxonomyNodeId: targetNode.id,
          priorityScore: rf.priorityScore,
        });
        ruleCount++;
      }
      timings.push({ phase: 'Override rules', ms: Date.now() - start });
      log(`  ✓ Override rules: ${ruleCount} created`);
    } else {
      log('  ⊘ Override rules: skipped');
    }

    // ─── Phase 7: Classification ──────────────────────────────────────────

    start = Date.now();
    log('  Classifying by supplier:');
    eventBus.on('classification:progress', (progress: any) => {
      if (progress.currentSupplier && progress.currentStep?.startsWith('Classifying:')) {
        log(`    [${progress.processedSuppliers + 1}/${progress.totalSuppliers}] ${progress.currentSupplier}`);
      }
    });
    await classifier.classifyAll();
    eventBus.removeAllListeners('classification:progress');
    stopTraceTail(); // flush any remaining trace lines before logging summary
    const stats = await transactions.getStats();
    timings.push({ phase: 'Classification', ms: Date.now() - start });
    log(`  ✓ Classification complete: ${stats.classifiedRows}/${stats.totalRows} classified`);

    // ─── Phase 8: QC (not run in full-run script) ─────────────────────────
    // QC consolidation is omitted here intentionally — it is run interactively
    // in the app after the user reviews raw classification results.

    // ─── Phase 9: Export CSV ──────────────────────────────────────────────

    start = Date.now();
    const rowsExported = await exportCSV(db, EXPORT_PATH);
    timings.push({ phase: 'Export CSV', ms: Date.now() - start });
    log(`  ✓ Export CSV: ${rowsExported} rows → ${EXPORT_PATH} (includes flagged_for_review column)`);

    // ─── Summary ──────────────────────────────────────────────────────────

    const totalMs = Date.now() - t0;
    log('');
    log('─── Timing Summary ────────────────────────────');
    for (const t of timings) {
      log(`  ${t.phase.padEnd(25)} ${(t.ms / 1000).toFixed(1)}s`);
    }
    log(`  ${'Total'.padEnd(25)} ${(totalMs / 1000).toFixed(1)}s`);
    log('');
    log(`Output: ${outputDir}`);
    log(`  project.c91:    ${DB_PATH}`);
    log(`  classified.csv: ${EXPORT_PATH}`);
    log(`  run.log:        ${LOG_PATH}`);
    log(`  trace.jsonl:    ${TRACE_PATH}`);
    log(`  debug.log:      ${DEBUG_LOG_PATH}`);

  } finally {
    // ─── Cleanup ────────────────────────────────────────────────────────

    if (db.isOpen()) {
      try { await db.run('CHECKPOINT'); } catch { /* ignore */ }
      await db.closeDatabase();
    }
    if (supplierUniverse.isOpen()) {
      await supplierUniverse.close();
    }
    logStream.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
