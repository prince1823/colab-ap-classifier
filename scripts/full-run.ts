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

import { loadEnv, resetEnvLoaded } from '../src/main/load-env';
resetEnvLoaded();
loadEnv(path.resolve(__dirname, '..'));

// ─── Parse config ───────────────────────────────────────────────────────────

interface RunConfig {
  projectName: string;
  companyContext: Record<string, string>;
  columnMapping: Record<string, string>;
  taxonomy?: string;
  columnPriorities?: string[];
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

// ─── Service imports ────────────────────────────────────────────────────────

import { DuckDBDatabase } from '../src/main/services/database';
import { DuckDBSupplierUniverse } from '../src/main/services/supplier-universe';
import { OpenRouterLLMClient } from '../src/main/services/llm-client';
import { ExaWebSearch } from '../src/main/services/exa-search';
import { LLMClassificationAgent } from '../src/main/agents/classification-agent';
import { LLMResearchAgent } from '../src/main/agents/research-agent';
import { LLMColumnMappingAgent } from '../src/main/agents/column-mapping-agent';
import { ChangelogStore } from '../src/main/services/changelog';
import { TransactionStore } from '../src/main/services/transactions';
import { ProjectStore } from '../src/main/services/project';
import { TaxonomyStore } from '../src/main/services/taxonomy';
import { RuleStore } from '../src/main/services/rules';
import { IngestService } from '../src/main/services/ingest';
import { SupplierService } from '../src/main/services/supplier-service';
import { SupplierResearcher } from '../src/main/services/supplier-research';
import { ClassificationRunner } from '../src/main/services/classification';

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
    'classification_status', 'human_reviewed',
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

  log(`Full run: ${config.projectName}`);
  log(`  Input:    ${csvPath}`);
  log(`  Taxonomy: ${taxonomyPath}`);
  log(`  Rules:    ${hasRules ? rulesPath : '(none)'}`);
  log(`  Universe: ${seedUniverse ? `seeded from ${seedUniverse}` : '(fresh)'}`);
  log(`  Output:   ${outputDir}`);
  log('');

  // Count CSV rows
  const csvContent = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  const csvRowCount = csvContent.trim().split(/\r?\n/).length - 1;
  log(`Input CSV: ${csvRowCount} rows`);

  // ─── Bootstrap services ─────────────────────────────────────────────────

  const db = new DuckDBDatabase();
  const scriptAppConfig = {
    getApiKey: () => null,
    setApiKey: async () => {},
    getProvider: () => 'openrouter',
    setProvider: async () => {},
    getModel: () => 'claude-3-5-haiku-latest',
    setModel: async () => {},
    getSupplierUniversePath: () => UNIVERSE_PATH,
    setSupplierUniversePath: async () => {},
    clearSupplierUniversePath: async () => {},
  };
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
  const rules = new RuleStore(db);
  const suppliers = new SupplierService(db, supplierUniverse);
  const ingest = new IngestService(db, transactions, suppliers, columnMappingAgent);
  const researcher = new SupplierResearcher(supplierUniverse, webSearch, researchAgent, eventBus as any);
  const classifier = new ClassificationRunner(
    db, taxonomy, project, rules,
    transactions, changelog, classificationAgent, eventBus as any, supplierUniverse
  );

  try {
    // ─── Phase 1: Create project ──────────────────────────────────────────

    let start = Date.now();
    await project.createProject(config.projectName, DB_PATH);
    await project.setSetting('company_context', config.companyContext);
    if (config.columnPriorities) {
      await project.setSetting('column_priorities', config.columnPriorities);
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

    start = Date.now();
    const importResult = await ingest.importCSV(csvPath, columnMapping);
    timings.push({ phase: 'Import CSV', ms: Date.now() - start });
    log(`  ✓ Import CSV: ${importResult.rowsInserted} rows`);

    // ─── Phase 4: Supplier normalization ──────────────────────────────────

    start = Date.now();
    const projectSuppliers = await suppliers.listProjectSuppliers();
    timings.push({ phase: 'Supplier normalization', ms: Date.now() - start });
    log(`  ✓ Supplier normalization: ${projectSuppliers.length} suppliers`);

    // ─── Phase 5: Supplier research ───────────────────────────────────────

    if (!config.skipSupplierResearch) {
      start = Date.now();
      log('  Researching suppliers:');
      for (const ps of projectSuppliers) {
        const cached = await supplierUniverse.getSupplier(ps.supplierName);
        const hadSubstantiveInfo = !!(cached?.industry || cached?.description);
        const info = await researcher.researchSingle(ps.supplierName);
        // Write back research results to project_suppliers (mirrors IPC handler logic)
        await suppliers.updateSupplier(ps.id, { supplierInfo: info });
        await suppliers.markResearched(ps.id);
        const source = hadSubstantiveInfo ? 'universe (cached)' : 'LLM';
        log(`    ${ps.supplierName} → ${source}`);
      }
      timings.push({ phase: 'Supplier research', ms: Date.now() - start });
      log(`  ✓ Supplier research: ${projectSuppliers.length} suppliers`);
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
          conditions: rf.conditions,
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
    const stats = await transactions.getStats();
    timings.push({ phase: 'Classification', ms: Date.now() - start });
    log(`  ✓ Classification complete: ${stats.classifiedRows}/${stats.totalRows} classified`);

    // ─── Phase 8: Export CSV ──────────────────────────────────────────────

    start = Date.now();
    const rowsExported = await exportCSV(db, EXPORT_PATH);
    timings.push({ phase: 'Export CSV', ms: Date.now() - start });
    log(`  ✓ Export CSV: ${rowsExported} rows → ${EXPORT_PATH}`);

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
