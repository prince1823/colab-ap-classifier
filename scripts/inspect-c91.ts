#!/usr/bin/env tsx
/**
 * Inspect .c91 database contents
 *
 * Usage: npm run script:inspect
 */

import { Database } from 'duckdb-async';
import path from 'path';

async function main() {
  const dbPath = path.join(process.cwd(), 'pipeline-runs/test-run.c91');
  const db = await Database.create(dbPath);

  console.log('\n' + '='.repeat(70));
  console.log('DATABASE INSPECTION: test-run.c91');
  console.log('='.repeat(70));

  // Transactions
  console.log('\n📊 TRANSACTIONS:');
  console.log('='.repeat(70));
  const transactions = await db.all(`
    SELECT
      id,
      supplier_name,
      spend_amount,
      classification_path,
      classification_l1,
      classification_l2,
      classification_l3,
      review_score,
      substr(classification_reasoning, 1, 80) || '...' as reasoning_preview
    FROM transactions
  `);

  transactions.forEach((row: any) => {
    console.log(`\nTransaction #${row.id}:`);
    console.log(`  Supplier: ${row.supplier_name}`);
    console.log(`  Amount: $${row.spend_amount}`);
    console.log(`  Classification: ${row.classification_path}`);
    console.log(`    L1: ${row.classification_l1}`);
    console.log(`    L2: ${row.classification_l2}`);
    console.log(`    L3: ${row.classification_l3}`);
    console.log(`  Review Score: ${row.review_score}/100`);
    console.log(`  Reasoning: ${row.reasoning_preview}`);
  });

  // Taxonomy stats
  console.log('\n\n📚 TAXONOMY:');
  console.log('='.repeat(70));
  const taxonomyStats = await db.all(`
    SELECT
      depth,
      COUNT(*) as count
    FROM taxonomy
    GROUP BY depth
    ORDER BY depth
  `);

  taxonomyStats.forEach((row: any) => {
    console.log(`  L${row.depth}: ${row.count} nodes`);
  });

  // Suppliers
  console.log('\n\n🏢 SUPPLIERS:');
  console.log('='.repeat(70));
  const suppliers = await db.all(`
    SELECT
      name,
      supplier_type,
      industry,
      substr(description, 1, 80) || '...' as description_preview
    FROM suppliers
    WHERE research_data IS NOT NULL
  `);

  suppliers.forEach((row: any) => {
    console.log(`\n${row.name}:`);
    console.log(`  Type: ${row.supplier_type}`);
    console.log(`  Industry: ${row.industry}`);
    console.log(`  Description: ${row.description_preview}`);
  });

  // Settings
  console.log('\n\n⚙️  SETTINGS:');
  console.log('='.repeat(70));
  const settings = await db.all(`
    SELECT key, value FROM settings
  `);

  settings.forEach((row: any) => {
    console.log(`  ${row.key} = ${row.value}`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('END OF INSPECTION');
  console.log('='.repeat(70) + '\n');

  await db.close();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
