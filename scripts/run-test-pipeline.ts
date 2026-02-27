#!/usr/bin/env tsx
/**
 * Script to run the full classification pipeline with test data
 * and document every step in pipeline-runs/
 *
 * Usage: npm run script:pipeline
 */

import 'dotenv/config'; // Load .env file
import path from 'path';
import fs from 'fs/promises';
import { databaseService } from '../src/main/services/database';
import * as projectService from '../src/main/services/project';
import * as taxonomyService from '../src/main/services/taxonomy';
import * as canonicalizationService from '../src/main/services/canonicalization';
import * as uploadService from '../src/main/services/upload';
import * as supplierService from '../src/main/services/suppliers';
import * as transactionsService from '../src/main/services/transactions';
import * as rulesService from '../src/main/services/rules';
import * as classificationPipeline from '../src/main/services/classification-pipeline';
import * as exportService from '../src/main/services/export';
import * as colabipService from '../src/main/services/colabip';
import * as settingsService from '../src/main/services/settings';

// Paths
const TEST_DATA_DIR = path.resolve(process.cwd(), 'test_data');
const CSV_PATH = path.join(TEST_DATA_DIR, 'input.csv');
const YAML_PATH = path.join(TEST_DATA_DIR, 'Innova_Care_Health_Jun_23.yaml');
const COLABIP_DIR = path.resolve(process.cwd(), 'colabip');
const PIPELINE_RUNS_DIR = path.resolve(process.cwd(), 'pipeline-runs');
const PROJECT_PATH = path.join(PIPELINE_RUNS_DIR, 'test-run.c91');

// Documentation
let docContent = '';

function log(message: string) {
  console.log(message);
  docContent += message + '\n';
}

function section(title: string) {
  const line = '='.repeat(80);
  log('');
  log(line);
  log(title);
  log(line);
  log('');
}

async function saveDoc(filename: string) {
  await fs.mkdir(PIPELINE_RUNS_DIR, { recursive: true });
  const docPath = path.join(PIPELINE_RUNS_DIR, filename);
  await fs.writeFile(docPath, docContent, 'utf-8');
  console.log(`\n📄 Documentation saved to: ${docPath}`);
}

async function main() {
  log(`Classification Pipeline Test Run`);
  log(`Started at: ${new Date().toISOString()}`);
  log('');

  try {
    // ====================================================================
    // Phase 1: Project Setup
    // ====================================================================
    section('PHASE 1: PROJECT SETUP');

    // Parse YAML to extract company context
    log('Reading company context from YAML...');
    const yamlContent = await fs.readFile(YAML_PATH, 'utf-8');
    const companyMatch = yamlContent.match(/company_context:\s+industry:\s+(.+)\s+sector:\s+(.+)\s+description:\s+(.+)\s+business_focus:\s+(.+)/s);

    log('Creating new project...');
    await fs.mkdir(PIPELINE_RUNS_DIR, { recursive: true });

    // Remove old project if exists
    try {
      await fs.unlink(PROJECT_PATH);
    } catch { /* ignore */ }

    await databaseService.openDatabase(PROJECT_PATH);
    log(`✓ Project created: ${PROJECT_PATH}`);
    log(`  Database file size: ${(await fs.stat(PROJECT_PATH)).size} bytes`);

    // Set project name
    await databaseService.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      'project_name',
      'Innova Care Health Test Run'
    );
    log('✓ Project name set: Innova Care Health Test Run');

    // Set company context
    log('');
    log('Setting company context from YAML...');

    // Parse company context from YAML
    const industryMatch = yamlContent.match(/industry:\s+(.+)/);
    const sectorMatch = yamlContent.match(/sector:\s+(.+)/);
    const descMatch = yamlContent.match(/description:\s+(.+)/);
    const focusMatch = yamlContent.match(/business_focus:\s+(.+)/);

    const industry = industryMatch ? industryMatch[1].trim() : 'Healthcare Services';
    const sector = sectorMatch ? sectorMatch[1].trim() : 'Value-Based Care';
    const description = descMatch ? descMatch[1].trim() : 'Healthcare organization';
    const business_focus = focusMatch ? focusMatch[1].trim() : 'Patient care';

    await databaseService.run(
      `UPDATE company_context
       SET industry = ?,
           sector = ?,
           description = ?,
           business_focus = ?,
           procurement_nuances = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      industry,
      sector,
      description,
      business_focus,
      'Focus on clinical and non-clinical healthcare spend management'
    );

    const cc = await databaseService.get<{ industry: string; sector: string }>(
      'SELECT industry, sector, description, business_focus FROM company_context WHERE id = 1'
    );
    log(`✓ Company context set:`);
    log(`  Industry: ${cc?.industry}`);
    log(`  Sector: ${cc?.sector}`);

    // ====================================================================
    // Phase 2: Taxonomy Import
    // ====================================================================
    section('PHASE 2: TAXONOMY IMPORT');

    log('Setting ColabIP base path...');
    colabipService.setColabipBasePath(COLABIP_DIR);
    log(`✓ ColabIP path: ${COLABIP_DIR}`);

    log('');
    log('Importing healthcare taxonomy from ColabIP...');
    await taxonomyService.importFromColabip('healthcare');

    const nodes = await taxonomyService.getNodes();
    const l1Nodes = nodes.filter((n) => n.depth === 1);
    const l2Nodes = nodes.filter((n) => n.depth === 2);
    const l3Nodes = nodes.filter((n) => n.depth === 3);
    const l4Nodes = nodes.filter((n) => n.depth === 4);

    log(`✓ Taxonomy imported: ${nodes.length} total nodes`);
    log(`  L1 (top level): ${l1Nodes.length} nodes`);
    log(`  L2: ${l2Nodes.length} nodes`);
    log(`  L3: ${l3Nodes.length} nodes`);
    log(`  L4 (leaf): ${l4Nodes.length} nodes`);
    log('');
    log('Sample L1 paths:');
    l1Nodes.slice(0, 5).forEach((n) => log(`  - ${n.fullPath}`));
    log('');
    log('Sample L4 paths:');
    l4Nodes.slice(0, 10).forEach((n) => log(`  - ${n.fullPath}`));

    // ====================================================================
    // Phase 3: CSV Upload & Canonicalization
    // ====================================================================
    section('PHASE 3: CSV UPLOAD & CANONICALIZATION');

    log('Previewing CSV file...');
    const preview = await uploadService.parsePreview(CSV_PATH);
    log(`✓ CSV preview:`);
    log(`  Total rows: ${preview.totalRows}`);
    log(`  Columns (${preview.columns.length}): ${preview.columns.slice(0, 10).join(', ')}...`);
    log('');
    log('Sample rows:');
    preview.sampleRows.slice(0, 3).forEach((row, i) => {
      log(`  Row ${i + 1}: ${JSON.stringify(row).substring(0, 100)}...`);
    });

    log('');
    log('Creating column mappings...');
    const mapping = {
      supplier_name: 'supplier_name',
      spend_amount: 'amount',
      invoice_date: 'Accounting Date',
      gl_description: 'gl_description',
      line_description: 'line_description',
      cost_center: 'cost_center',
      company_name: 'Company Name',
    };

    await canonicalizationService.saveMappings(mapping, ['supplier_name']);
    log(`✓ Column mappings saved: ${Object.keys(mapping).length} columns`);
    Object.entries(mapping).forEach(([canonical, csv]) => {
      log(`  ${canonical} ← ${csv}`);
    });

    log('');
    log('Importing CSV data...');
    const importResult = await canonicalizationService.importCSV(CSV_PATH);
    log(`✓ Imported ${importResult.rowsInserted} transactions`);

    // ====================================================================
    // Phase 4: Supplier Extraction & Research
    // ====================================================================
    section('PHASE 4: SUPPLIER EXTRACTION');

    const suppliers = await supplierService.listSuppliers();
    log(`✓ Extracted ${suppliers.length} unique suppliers`);
    log('');

    const totalSpend = suppliers.reduce((sum, s) => sum + s.totalSpend, 0);
    log(`Total spend: $${totalSpend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    log('');
    log('Supplier breakdown:');
    suppliers
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .forEach((s, i) => {
        const pct = ((s.totalSpend / totalSpend) * 100).toFixed(1);
        log(`  ${i + 1}. ${s.supplierName}: $${s.totalSpend.toFixed(2)} (${pct}%, ${s.transactionCount} txn)`);
      });

    // ====================================================================
    // Phase 5: Classification Pipeline
    // ====================================================================
    section('PHASE 5: CLASSIFICATION PIPELINE');

    log('Starting classification pipeline...');
    log('  Scope: all transactions');

    // Set LLM provider to OpenAI (runtime settings)
    settingsService.updateSettings({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    log('  LLM Provider: openai');
    log('  Model: gpt-4o-mini');
    log('');

    const startTime = Date.now();
    const { runId } = await classificationPipeline.startClassification({
      scope: 'all',
    });
    log(`✓ Pipeline run started: ${runId}`);

    // Wait for completion
    let status = classificationPipeline.getStatus();
    const maxWait = 300000; // 5 minutes

    const progressSteps: string[] = [];
    while (
      status &&
      !['completed', 'failed', 'cancelled'].includes(status.status) &&
      Date.now() - startTime < maxWait
    ) {
      if (status.currentStep && !progressSteps.includes(status.currentStep)) {
        log(`  ${status.currentStep}...`);
        progressSteps.push(status.currentStep);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = classificationPipeline.getStatus();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (status?.status === 'completed') {
      log('');
      log(`✓ Classification completed in ${elapsed}s`);
      log(`  Transactions processed: ${status.processedCount}`);
      log(`  Transactions classified: ${status.classifiedCount}`);
      if (status.errorCount) {
        log(`  Errors: ${status.errorCount}`);
      }
    } else if (status?.status === 'failed') {
      log('');
      log(`✗ Classification failed: ${status.error}`);
      throw new Error(`Pipeline failed: ${status.error}`);
    } else {
      log('');
      log(`✗ Classification timed out after ${elapsed}s`);
      throw new Error('Pipeline timeout');
    }

    // ====================================================================
    // Phase 6: Results Analysis
    // ====================================================================
    section('PHASE 6: RESULTS ANALYSIS');

    log('Analyzing classification results...');

    const txns = await databaseService.all<{
      id: string;
      supplier_name: string;
      spend_amount: number;
      taxonomy_node_id: string | null;
      review_score: number | null;
      classification_reasoning: string | null;
    }>(
      'SELECT id, supplier_name, spend_amount, taxonomy_node_id, review_score, classification_reasoning FROM transactions ORDER BY spend_amount DESC'
    );

    const taxonomy = await taxonomyService.getNodes();

    log(`Total transactions: ${txns.length}`);
    log('');

    let classifiedCount = 0;
    let ruleMatchedCount = 0;
    let llmClassifiedCount = 0;
    let highReviewCount = 0;

    log('Transaction classifications:');
    for (const txn of txns) {
      const node = taxonomy.find((n) => n.id === txn.taxonomy_node_id);
      const path = node?.fullPath ?? '(unclassified)';
      const score = txn.review_score ?? 0;
      const source = (score === 0 ? 'aligned/rule' : 'LLM');
      const amount = typeof txn.spend_amount === 'number' ? txn.spend_amount : parseFloat(String(txn.spend_amount || 0));

      if (txn.taxonomy_node_id) {
        classifiedCount++;
        if (score === 0) {
          ruleMatchedCount++;
        } else {
          llmClassifiedCount++;
        }
        if (score > 50) {
          highReviewCount++;
        }
      }

      log(`  ${txn.supplier_name} ($${amount.toFixed(2)})`);
      log(`    → ${path}`);
      log(`    Review score: ${score}/100, Source: ${source}`);
      if (txn.classification_reasoning) {
        const reasoning = txn.classification_reasoning.substring(0, 100);
        log(`    Reasoning: ${reasoning}...`);
      }
      log('');
    }

    log('Summary:');
    log(`  Total: ${txns.length}`);
    log(`  Classified: ${classifiedCount} (${((classifiedCount / txns.length) * 100).toFixed(1)}%)`);
    log(`  By rules/aligned: ${ruleMatchedCount}`);
    log(`  By LLM: ${llmClassifiedCount}`);
    log(`  High review score (>50): ${highReviewCount}`);

    // ====================================================================
    // Phase 7: Database Inspection
    // ====================================================================
    section('PHASE 7: DATABASE INSPECTION');

    log('Querying .c91 database contents...');
    log('');

    // Settings
    const settings = await databaseService.all<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    );
    log('Settings table:');
    settings.forEach((s) => log(`  ${s.key} = ${s.value}`));

    log('');

    // Suppliers with research data
    const researchedSuppliers = await databaseService.all<{
      supplier_name: string;
      supplier_type: string;
      supplier_info: string;
    }>(
      "SELECT supplier_name, supplier_type, supplier_info FROM project_suppliers WHERE supplier_info IS NOT NULL AND supplier_info != '{}'"
    );

    log(`Suppliers with research data: ${researchedSuppliers.length}`);
    researchedSuppliers.slice(0, 5).forEach((s) => {
      log(`  ${s.supplier_name}:`);
      log(`    Type: ${s.supplier_type}`);
      try {
        const info = JSON.parse(s.supplier_info);
        if (info.industry) log(`    Industry: ${info.industry}`);
        if (info.description) log(`    Description: ${info.description.substring(0, 80)}...`);
      } catch { /* ignore */ }
    });

    log('');

    // Override rules
    const rules = await rulesService.listRules();
    log(`Override rules: ${rules.length}`);
    rules.forEach((r) => {
      log(`  ${r.name}:`);
      log(`    Source: ${r.source}, Priority: ${r.priorityScore}`);
      log(`    Conditions: ${JSON.stringify(r.conditions)}`);
    });

    log('');

    // Changelog
    const changes = await databaseService.all<{
      source: string;
      description: string;
      affected_count: number;
    }>('SELECT source, description, affected_count FROM change_log ORDER BY created_at DESC LIMIT 10');
    log(`Recent changelog entries: ${changes.length}`);
    changes.forEach((c) => {
      log(`  [${c.source}] ${c.description} (${c.affected_count} affected)`);
    });

    // ====================================================================
    // Phase 8: Export
    // ====================================================================
    section('PHASE 8: EXPORT');

    const exportPath = path.join(PIPELINE_RUNS_DIR, 'test-run-export.csv');
    log(`Exporting to CSV: ${exportPath}`);

    const exportResult = await exportService.exportCSV(exportPath);
    log(`✓ Exported ${exportResult.rowsExported} rows`);

    const csvContent = await fs.readFile(exportPath, 'utf-8');
    const lines = csvContent.split('\n');
    log(`  CSV file: ${lines.length} lines`);
    log(`  Header: ${lines[0].substring(0, 150)}...`);
    log('');
    log('Sample rows:');
    lines.slice(1, 4).forEach((line, i) => {
      log(`  Row ${i + 1}: ${line.substring(0, 150)}...`);
    });

    // ====================================================================
    // Summary
    // ====================================================================
    section('SUMMARY');

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const dbSize = (await fs.stat(PROJECT_PATH)).size;

    log('Pipeline execution complete!');
    log('');
    log('Files generated:');
    log(`  Project database: ${PROJECT_PATH} (${(dbSize / 1024).toFixed(1)} KB)`);
    log(`  Export CSV: ${exportPath}`);
    log('');
    log('Key metrics:');
    log(`  Total runtime: ${totalElapsed}s`);
    log(`  Transactions imported: ${importResult.rowsInserted}`);
    log(`  Suppliers identified: ${suppliers.length}`);
    log(`  Taxonomy nodes: ${nodes.length}`);
    log(`  Classified: ${classifiedCount}/${txns.length}`);
    log(`  Total spend: $${totalSpend.toFixed(2)}`);
    log('');
    log('Status: SUCCESS ✓');

    await databaseService.closeDatabase();

  } catch (error) {
    log('');
    log('ERROR:');
    log(String(error));
    if (error instanceof Error && error.stack) {
      log('');
      log('Stack trace:');
      log(error.stack);
    }

    if (databaseService.isOpen()) {
      await databaseService.closeDatabase();
    }

    throw error;
  } finally {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await saveDoc(`pipeline-run-${timestamp}.md`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
