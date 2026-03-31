/**
 * Classification accuracy evaluation script.
 *
 * Compares AI-classified output against ground truth labels from the source CSV.
 *
 * Usage:
 *   npx tsx scripts/accuracy.ts <test-data-folder>
 *
 * Example:
 *   npx tsx scripts/accuracy.ts test_data/03-29-classification-accuracy
 *
 * The test-data folder must contain:
 *   - A CSV with "Level 1", "Level 2", "Level 3" ground truth columns (largest CSV in folder)
 *   - config.json with columnMapping (supplier_name, spend_amount)
 *   - output/run-<timestamp>/classified.csv from a classification run
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';

// ── Types ──────────────────────────────────────────────────────────────────

interface Config {
  columnMapping: {
    supplier_name: string;
    spend_amount: string;
    [key: string]: string;
  };
}

interface ClassifiedRow {
  canonical_supplier_name: string;
  spend_amount: string;
  classification_l1: string;
  classification_l2: string;
  classification_l3: string;
}

interface SupplierStats {
  totalSpend: number;
  totalTxns: number;
  misclassifiedTxns: [number, number, number];
  misclassifiedSpend: [number, number, number];
  gtCounts: [Map<string, number>, Map<string, number>, Map<string, number>];
  predCounts: [Map<string, number>, Map<string, number>, Map<string, number>];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return (s || '').trim().toLowerCase();
}

function mode(counts: Map<string, number>): string {
  let best = '';
  let bestCount = 0;
  for (const [val, count] of counts) {
    if (count > bestCount) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}

function incr(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function fmtPct(n: number, d: number): string {
  if (d === 0) return 'N/A';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmtMoney(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}k`;
  return `$${amount.toFixed(0)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fuzzyLookup(supplierInfo: Map<string, Record<string, string>>, name: string): Record<string, string> | undefined {
  const exact = supplierInfo.get(name);
  if (exact) return exact;
  // Try startsWith match (handles "inc" / "llc" suffix differences)
  for (const [key, val] of supplierInfo) {
    if (key.startsWith(name) || name.startsWith(key)) return val;
  }
  return undefined;
}

// ── Discovery ──────────────────────────────────────────────────────────────

function findGroundTruthCsv(folder: string): string {
  const files = fs.readdirSync(folder)
    .filter(f => f.endsWith('.csv') && f !== 'input.csv')
    .map(f => ({ name: f, size: fs.statSync(path.join(folder, f)).size }))
    .sort((a, b) => b.size - a.size);

  if (files.length === 0) throw new Error(`No ground truth CSV found in ${folder}`);
  return path.join(folder, files[0].name);
}

function findLatestClassifiedCsv(folder: string): { csvPath: string; runName: string } {
  const outputDir = path.join(folder, 'output');
  if (!fs.existsSync(outputDir)) throw new Error(`No output/ directory in ${folder}`);

  const runs = fs.readdirSync(outputDir)
    .filter(d => d.startsWith('run-') && fs.statSync(path.join(outputDir, d)).isDirectory())
    .sort();

  if (runs.length === 0) throw new Error(`No run directories in ${outputDir}`);

  // Find the latest run that has a classified.csv
  for (let i = runs.length - 1; i >= 0; i--) {
    const csvPath = path.join(outputDir, runs[i], 'classified.csv');
    if (fs.existsSync(csvPath)) return { csvPath, runName: runs[i] };
  }

  throw new Error(`No run with classified.csv found in ${outputDir}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const folder = process.argv[2];
  const runArg = process.argv[3]; // optional: specific run name (e.g., run-2026-03-29T14-29-49)
  if (!folder) {
    console.error('Usage: npx tsx scripts/accuracy.ts <test-data-folder> [run-name]');
    process.exit(1);
  }

  const resolvedFolder = path.resolve(folder);
  if (!fs.existsSync(resolvedFolder)) {
    console.error(`Folder not found: ${resolvedFolder}`);
    process.exit(1);
  }

  // Load config
  const configPath = path.join(resolvedFolder, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`No config.json in ${resolvedFolder}`);
  const config: Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const gtSupplierCol = config.columnMapping.supplier_name;
  const gtSpendCol = config.columnMapping.spend_amount;

  // Load supplier info if present
  const supplierInfoPath = path.join(resolvedFolder, 'supplier_info.csv');
  const supplierInfo = new Map<string, Record<string, string>>();
  if (fs.existsSync(supplierInfoPath)) {
    const infoRows: Record<string, string>[] = parseSync(fs.readFileSync(supplierInfoPath, 'utf-8'), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
    for (const row of infoRows) {
      const key = norm(row['vendor_norm_name_lookup'] || '');
      if (key) supplierInfo.set(key, row);
    }
    console.log(`Supplier info: ${supplierInfo.size} suppliers loaded`);
  }

  // Find files
  const gtCsvPath = findGroundTruthCsv(resolvedFolder);
  let classifiedPath: string;
  let runName: string;
  if (runArg) {
    runName = runArg;
    classifiedPath = path.join(resolvedFolder, 'output', runArg, 'classified.csv');
    if (!fs.existsSync(classifiedPath)) throw new Error(`No classified.csv in ${runArg}`);
  } else {
    ({ csvPath: classifiedPath, runName } = findLatestClassifiedCsv(resolvedFolder));
  }

  console.log(`Ground truth: ${path.basename(gtCsvPath)}`);
  console.log(`Classified:   ${runName}/classified.csv`);
  console.log('');

  // Load classified CSV (small, fits in memory)
  const classifiedRaw = fs.readFileSync(classifiedPath, 'utf-8');
  const classifiedRows: ClassifiedRow[] = parseSync(classifiedRaw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  console.log(`Classified rows: ${fmtNum(classifiedRows.length)}`);

  // Accumulators
  const levels = ['L1', 'L2', 'L3'] as const;
  const txnCorrect = [0, 0, 0];
  const txnTotal = [0, 0, 0];
  const spendCorrect = [0, 0, 0];
  let totalSpend = 0;
  const suppliers = new Map<string, SupplierStats>();
  // Track misclassification pairs: "gt_path → pred_path" at each level
  const misclassPairs: [Map<string, number>, Map<string, number>, Map<string, number>] = [new Map(), new Map(), new Map()];
  // Track per-supplier txn counts for each misclassification pair
  const misclassSuppliers: [Map<string, Map<string, number>>, Map<string, Map<string, number>>, Map<string, Map<string, number>>] = [new Map(), new Map(), new Map()];
  // Multiple L2 analysis accumulators (per supplier)
  const supplierPredL2s = new Map<string, Set<string>>();        // distinct predicted L2s
  const supplierGtL2Dist = new Map<string, Map<string, number>>(); // GT L2 → count
  const supplierPredL2Dist = new Map<string, Map<string, number>>(); // predicted L2 → count
  const supplierPredL2Correct = new Map<string, Map<string, number>>(); // predicted L2 → correct count
  const supplierPredL3s = new Map<string, Set<string>>();        // distinct predicted L3s

  let validationErrors = 0;
  let rowIndex = 0;

  // Stream ground truth CSV
  await new Promise<void>((resolve, reject) => {
    const parser = fs.createReadStream(gtCsvPath).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
      })
    );

    parser.on('data', (gtRow: Record<string, string>) => {
      if (rowIndex >= classifiedRows.length) return;

      const classified = classifiedRows[rowIndex];
      const gtSupplier = norm(gtRow[gtSupplierCol] || '');
      const classifiedSupplier = norm(classified.canonical_supplier_name || '');
      const gtSpend = parseFloat(gtRow[gtSpendCol] || '0') || 0;
      const classifiedSpend = parseFloat(classified.spend_amount || '0') || 0;

      // Validate alignment: check spend matches (supplier names may be normalized differently)
      if (Math.abs(gtSpend - classifiedSpend) > 0.01) {
        if (validationErrors === 0) {
          console.error(`\nAlignment mismatch at row ${rowIndex + 1}:`);
          console.error(`  GT spend: ${gtSpend}, Classified spend: ${classifiedSpend}`);
          console.error(`  GT supplier: "${gtSupplier}", Classified supplier: "${classifiedSupplier}"`);
        }
        validationErrors++;
      }

      // Ground truth levels
      const gtLevels = [
        norm(gtRow['Level 1'] || ''),
        norm(gtRow['Level 2'] || ''),
        norm(gtRow['Level 3'] || ''),
      ];
      const predLevels = [
        norm(classified.classification_l1 || ''),
        norm(classified.classification_l2 || ''),
        norm(classified.classification_l3 || ''),
      ];

      const spend = Math.abs(gtSpend);
      totalSpend += spend;

      // Transaction-level accuracy
      for (let i = 0; i < 3; i++) {
        txnTotal[i]++;
        if (gtLevels[i] === predLevels[i]) {
          txnCorrect[i]++;
          spendCorrect[i] += spend;
        }
      }

      // Supplier-level accumulation (keyed on classified supplier name)
      const supplierKey = classifiedSupplier || gtSupplier;
      if (supplierKey) {
        let stats = suppliers.get(supplierKey);
        if (!stats) {
          stats = {
            totalSpend: 0,
            totalTxns: 0,
            misclassifiedTxns: [0, 0, 0],
            misclassifiedSpend: [0, 0, 0],
            gtCounts: [new Map(), new Map(), new Map()],
            predCounts: [new Map(), new Map(), new Map()],
          };
          suppliers.set(supplierKey, stats);
        }
        stats.totalSpend += spend;
        stats.totalTxns++;
        for (let i = 0; i < 3; i++) {
          if (gtLevels[i]) incr(stats.gtCounts[i], gtLevels[i]);
          if (predLevels[i]) incr(stats.predCounts[i], predLevels[i]);
          if (gtLevels[i] !== predLevels[i]) {
            stats.misclassifiedTxns[i]++;
            stats.misclassifiedSpend[i] += spend;
            if (gtLevels[i] && predLevels[i]) {
              const pairKey = `${gtLevels[i]} → ${predLevels[i]}`;
              incr(misclassPairs[i], pairKey);
              let s = misclassSuppliers[i].get(pairKey);
              if (!s) { s = new Map(); misclassSuppliers[i].set(pairKey, s); }
              incr(s, supplierKey);
            }
          }
        }

        // Multiple L2 analysis
        const predL2 = predLevels[1];
        const gtL2 = gtLevels[1];
        const predL3 = predLevels[2];

        if (!supplierPredL2s.has(supplierKey)) supplierPredL2s.set(supplierKey, new Set());
        if (predL2) supplierPredL2s.get(supplierKey)!.add(predL2);

        if (!supplierGtL2Dist.has(supplierKey)) supplierGtL2Dist.set(supplierKey, new Map());
        if (gtL2) incr(supplierGtL2Dist.get(supplierKey)!, gtL2);

        if (!supplierPredL2Dist.has(supplierKey)) supplierPredL2Dist.set(supplierKey, new Map());
        if (predL2) incr(supplierPredL2Dist.get(supplierKey)!, predL2);

        if (!supplierPredL2Correct.has(supplierKey)) supplierPredL2Correct.set(supplierKey, new Map());
        if (predL2 && predL2 === gtL2) incr(supplierPredL2Correct.get(supplierKey)!, predL2);

        if (!supplierPredL3s.has(supplierKey)) supplierPredL3s.set(supplierKey, new Set());
        if (predL3) supplierPredL3s.get(supplierKey)!.add(predL3);
      }

      rowIndex++;
    });

    parser.on('end', resolve);
    parser.on('error', reject);
  });

  // Validation summary
  if (validationErrors > 0) {
    console.error(`\nWARNING: ${fmtNum(validationErrors)} rows had spend amount mismatches.`);
    console.error('Results may be unreliable. Check that both files are in the same order.\n');
  } else {
    console.log(`Validated ${fmtNum(rowIndex)} rows: spend amounts match across both files.`);
  }

  if (rowIndex === 0) {
    console.error('No rows processed. Check that classified.csv and ground truth have data.');
    process.exit(1);
  }

  // Supplier-level accuracy
  const supplierCorrect = [0, 0, 0];
  const supplierTotal = suppliers.size;
  const headSupplierCorrect = [0, 0, 0];
  let headSupplierTotal = 0;
  let headSpend = 0;
  const tailSupplierCorrect = [0, 0, 0];
  let tailSupplierTotal = 0;
  let tailSpend = 0;

  for (const [, stats] of suppliers) {
    const isHead = stats.totalSpend > 10_000;
    if (isHead) {
      headSupplierTotal++;
      headSpend += stats.totalSpend;
    } else {
      tailSupplierTotal++;
      tailSpend += stats.totalSpend;
    }

    for (let i = 0; i < 3; i++) {
      const gtMode = mode(stats.gtCounts[i]);
      const predMode = mode(stats.predCounts[i]);
      if (gtMode && gtMode === predMode) {
        supplierCorrect[i]++;
        if (isHead) headSupplierCorrect[i]++;
        else tailSupplierCorrect[i]++;
      }
    }
  }

  // Build markdown report
  const datasetName = path.basename(resolvedFolder);
  const lines: string[] = [];
  const log = (s: string = '') => lines.push(s);

  log(`# Classification Accuracy Report`);
  log();
  log(`| | |`);
  log(`|---|---|`);
  log(`| **Dataset** | ${datasetName} |`);
  log(`| **Run** | ${runName} |`);
  log(`| **Transactions** | ${fmtNum(rowIndex)} |`);
  log(`| **Suppliers** | ${fmtNum(supplierTotal)} |`);

  log();
  log(`## Transaction-Level Accuracy`);
  log();
  log(`| Level | Accuracy | Correct | Total |`);
  log(`|-------|----------|---------|-------|`);
  for (let i = 0; i < 3; i++) {
    log(`| ${levels[i]} | ${fmtPct(txnCorrect[i], txnTotal[i])} | ${fmtNum(txnCorrect[i])} | ${fmtNum(txnTotal[i])} |`);
  }

  log();
  log(`## Spend-Level Accuracy`);
  log();
  log(`| Level | Accuracy | Correct Spend | Total Spend |`);
  log(`|-------|----------|---------------|-------------|`);
  for (let i = 0; i < 3; i++) {
    log(`| ${levels[i]} | ${fmtPct(spendCorrect[i], totalSpend)} | ${fmtMoney(spendCorrect[i])} | ${fmtMoney(totalSpend)} |`);
  }

  log();
  log(`## Supplier-Level Accuracy`);
  log();
  log(`| Level | Accuracy | Correct | Total |`);
  log(`|-------|----------|---------|-------|`);
  for (let i = 0; i < 3; i++) {
    log(`| ${levels[i]} | ${fmtPct(supplierCorrect[i], supplierTotal)} | ${fmtNum(supplierCorrect[i])} | ${fmtNum(supplierTotal)} |`);
  }

  log();
  log(`## Supplier-Level Accuracy by Spend Segment`);
  log();
  log(`### Head (> $10k) — ${fmtNum(headSupplierTotal)} suppliers, ${fmtMoney(headSpend)}`);
  log();
  log(`| Level | Accuracy |`);
  log(`|-------|----------|`);
  for (let i = 0; i < 3; i++) {
    log(`| ${levels[i]} | ${fmtPct(headSupplierCorrect[i], headSupplierTotal)} |`);
  }

  log();
  log(`### Tail (<= $10k) — ${fmtNum(tailSupplierTotal)} suppliers, ${fmtMoney(tailSpend)}`);
  log();
  log(`| Level | Accuracy |`);
  log(`|-------|----------|`);
  for (let i = 0; i < 3; i++) {
    log(`| ${levels[i]} | ${fmtPct(tailSupplierCorrect[i], tailSupplierTotal)} |`);
  }

  // Most common misclassifications at each level
  log();
  log(`## Most Common Misclassifications`);
  for (let i = 0; i < 3; i++) {
    const sorted = [...misclassPairs[i].entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (sorted.length === 0) continue;
    log();
    log(`### ${levels[i]}`);
    log();
    log(`| Ground Truth → Predicted | Txns | Suppliers |`);
    log(`|--------------------------|------|-----------|`);
    for (const [pair, count] of sorted) {
      const supplierMap = misclassSuppliers[i].get(pair);
      const names = supplierMap
        ? [...supplierMap.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, cnt]) => {
              const supplierTxns = suppliers.get(name)?.totalTxns || cnt;
              return `${name} (${fmtPct(cnt, supplierTxns)})`;
            })
            .join(', ')
        : '';
      log(`| ${pair} | ${fmtNum(count)} | ${names} |`);
    }
  }

  // Supplier info flag breakdowns
  if (supplierInfo.size > 0) {
    // Build per-supplier correctness (mode match) at each level
    const supplierCorrectMap = new Map<string, [boolean, boolean, boolean]>();
    for (const [name, stats] of suppliers) {
      const correct: [boolean, boolean, boolean] = [false, false, false];
      for (let i = 0; i < 3; i++) {
        const gtMode = mode(stats.gtCounts[i]);
        const predMode = mode(stats.predCounts[i]);
        correct[i] = !!(gtMode && gtMode === predMode);
      }
      supplierCorrectMap.set(name, correct);
    }

    // Match suppliers to info rows
    let matched = 0;
    let unmatched = 0;
    const enriched: { name: string; info: Record<string, string>; correct: [boolean, boolean, boolean] }[] = [];
    for (const [name, correct] of supplierCorrectMap) {
      const info = fuzzyLookup(supplierInfo, name);
      if (info) {
        enriched.push({ name, info, correct });
        matched++;
      } else {
        unmatched++;
      }
    }

    log();
    log(`## Supplier-Level Accuracy by Supplier Attributes`);
    log();
    log(`*From supplier_info.csv — ${matched} matched, ${unmatched} unmatched*`);

    // Helper to build a flag breakdown table
    const flagBreakdown = (title: string, groupFn: (info: Record<string, string>) => string) => {
      const groups = new Map<string, { total: number; correct: [number, number, number] }>();
      for (const { info, correct } of enriched) {
        const group = groupFn(info);
        let g = groups.get(group);
        if (!g) { g = { total: 0, correct: [0, 0, 0] }; groups.set(group, g); }
        g.total++;
        for (let i = 0; i < 3; i++) if (correct[i]) g.correct[i]++;
      }

      log();
      log(`### ${title}`);
      log();
      log(`| Group | Suppliers | L1 | L2 | L3 |`);
      log(`|-------|-----------|----|----|----| `);
      for (const [group, g] of groups) {
        log(`| ${group} | ${g.total} | ${fmtPct(g.correct[0], g.total)} | ${fmtPct(g.correct[1], g.total)} | ${fmtPct(g.correct[2], g.total)} |`);
      }
    };

    // Spend bracket
    const bracketOrder = ['>50M', '10-50M', '1-10M', '100k-1M', '10k-100k', '<10k', '<100'];
    flagBreakdown('By Spend Bracket', (info) => {
      const b = (info['spend_bracket'] || '').trim();
      return b || 'unknown';
    });

    // Ambiguous name
    flagBreakdown('By Ambiguous Name', (info) => {
      return (info['ambiguous_name'] || '').trim().toUpperCase() === 'TRUE' ? 'Ambiguous' : 'Not ambiguous';
    });

    // Multi L2
    flagBreakdown('By Multi-L2', (info) => {
      return (info['multi_l2'] || '').trim().toUpperCase() === 'TRUE' ? 'Multi-L2' : 'Single-L2';
    });

    // Single transaction
    flagBreakdown('By Single Transaction', (info) => {
      return (info['single_txn'] || '').trim().toUpperCase() === 'TRUE' ? 'Single txn' : 'Multiple txns';
    });

    // Multi-domain (has domains listed)
    flagBreakdown('By Multi-Domain', (info) => {
      return (info['domains'] || '').trim() ? 'Multi-domain' : 'Single-domain';
    });
  }

  // Multiple L2 Analysis — split by spend segment
  const buildL2Row = (name: string): string => {
    const predL2Set = supplierPredL2s.get(name) || new Set();
    const gtL2Dist = supplierGtL2Dist.get(name) || new Map();
    const predL2Dist = supplierPredL2Dist.get(name) || new Map();
    const predL2Correct = supplierPredL2Correct.get(name) || new Map();
    const predL3Set = supplierPredL3s.get(name) || new Set();

    const totalGtRows = [...gtL2Dist.values()].reduce((a, b) => a + b, 0);

    const l2Parts: string[] = [];
    for (const l2 of predL2Set) {
      const gtCount = gtL2Dist.get(l2) || 0;
      const predCount = predL2Dist.get(l2) || 0;
      const correctCount = predL2Correct.get(l2) || 0;
      const coverage = totalGtRows > 0 ? ((gtCount / totalGtRows) * 100).toFixed(0) : '0';
      const accuracy = predCount > 0 ? ((correctCount / predCount) * 100).toFixed(0) : '0';
      l2Parts.push(`${l2} (${coverage}% cov, ${accuracy}% acc)`);
    }

    const missedParts: string[] = [];
    for (const [gtL2, count] of gtL2Dist) {
      if (!predL2Set.has(gtL2)) {
        const pct = totalGtRows > 0 ? ((count / totalGtRows) * 100).toFixed(0) : '0';
        missedParts.push(`${gtL2} (${pct}%)`);
      }
    }
    const missedCol = missedParts.length > 0 ? missedParts.join(', ') : '—';

    return `| ${name} | ${l2Parts.join(', ')} | ${missedCol} | ${predL3Set.size} |`;
  };

  const sortedSupplierKeys = [...supplierPredL2s.keys()].sort();
  const headSupplierKeys = sortedSupplierKeys.filter(name => (suppliers.get(name)?.totalSpend || 0) > 10_000);
  const tailSupplierKeys = sortedSupplierKeys.filter(name => (suppliers.get(name)?.totalSpend || 0) <= 10_000);

  log();
  log(`## Multiple L2 Analysis`);

  log();
  log(`### Head (> $10k) — ${fmtNum(headSupplierKeys.length)} suppliers`);
  log();
  log(`| Supplier | Predicted L2s (coverage, accuracy) | Missed L2 | # L3s |`);
  log(`|----------|-------------------------------------|-----------|-------|`);
  for (const name of headSupplierKeys) log(buildL2Row(name));

  log();
  log(`### Tail (<= $10k) — ${fmtNum(tailSupplierKeys.length)} suppliers`);
  log();
  log(`| Supplier | Predicted L2s (coverage, accuracy) | Missed L2 | # L3s |`);
  log(`|----------|-------------------------------------|-----------|-------|`);
  for (const name of tailSupplierKeys) log(buildL2Row(name));

  const report = lines.join('\n') + '\n';

  // Print to stdout
  console.log('');
  process.stdout.write(report);

  // Save to the same output run folder
  const runDir = path.dirname(classifiedPath);
  const reportPath = path.join(runDir, 'accuracy.md');
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`\nReport saved to: ${reportPath}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
