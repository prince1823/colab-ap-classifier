import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
import { invalidateColumnCache } from './transactions';
import { readSupplierUniverse } from './colabip';
import { buildMatcherIndex } from './supplier-matcher';
import { resolveTaxonomyPath } from './taxonomy-utils';
import { getNodes as getTaxonomyNodes } from './taxonomy';
import type {
  CanonicalColumnMapping,
} from '../../shared/types/canonicalization';

// NOTE: suggestMappings was removed from this service — LLM mapping suggestions
// are now called directly from the upload service as part of parsePreview (LLM-first flow).

/**
 * Persist canonical column mappings and invoice grouping columns to the database.
 * Validates that no conflicting mappings exist before saving.
 */
export async function saveMappings(
  mapping: CanonicalColumnMapping,
  groupingColumns: string[]
): Promise<void> {
  // Validate: check for conflicting mappings already in the DB
  const existing = await getMappings();
  if (existing) {
    for (const [canonicalName, csvColumn] of Object.entries(mapping)) {
      if (
        canonicalName in existing &&
        existing[canonicalName] !== csvColumn
      ) {
        throw new Error(
          `Conflicting mapping for "${canonicalName}": existing maps to "${existing[canonicalName]}", new maps to "${csvColumn}"`
        );
      }
    }
  }

  // Clear existing mappings and grouping columns, then re-insert
  await databaseService.run('DELETE FROM column_mappings');
  await databaseService.run('DELETE FROM invoice_grouping_columns');

  // Insert column mappings (batch)
  const mappingEntries = Object.entries(mapping);
  if (mappingEntries.length > 0) {
    const rowPlaceholders = mappingEntries.map(() => '(?, ?)').join(', ');
    const values = mappingEntries.flat();
    await databaseService.run(
      `INSERT INTO column_mappings (canonical_name, csv_column_name) VALUES ${rowPlaceholders}`,
      ...values
    );
  }

  // Insert grouping columns with position (batch)
  if (groupingColumns.length > 0) {
    const rowPlaceholders = groupingColumns.map(() => '(?, ?)').join(', ');
    const values: unknown[] = [];
    for (let i = 0; i < groupingColumns.length; i++) {
      values.push(groupingColumns[i], i);
    }
    await databaseService.run(
      `INSERT INTO invoice_grouping_columns (canonical_name, position) VALUES ${rowPlaceholders}`,
      ...values
    );
  }
}

/**
 * Read saved column mappings from the database.
 * Returns null if no mappings have been saved.
 */
export async function getMappings(): Promise<CanonicalColumnMapping | null> {
  const rows = await databaseService.all<{
    canonical_name: string;
    csv_column_name: string;
  }>('SELECT canonical_name, csv_column_name FROM column_mappings');

  if (rows.length === 0) {
    return null;
  }

  const mapping: CanonicalColumnMapping = {};
  for (const row of rows) {
    mapping[row.canonical_name] = row.csv_column_name;
  }
  return mapping;
}

/**
 * Get saved invoice grouping columns, ordered by position.
 */
export async function getGroupingColumns(): Promise<string[]> {
  const rows = await databaseService.all<{
    canonical_name: string;
    position: number;
  }>('SELECT canonical_name, position FROM invoice_grouping_columns ORDER BY position');

  return rows.map((r) => r.canonical_name);
}

/**
 * Detect the file encoding by checking for a UTF-8 BOM or
 * attempting to validate the content as UTF-8.
 * Falls back to latin1 if the buffer contains invalid UTF-8 sequences.
 */
function detectEncoding(buffer: Buffer): BufferEncoding {
  // Check for UTF-8 BOM
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte <= 0x7f) continue;

    let expectedContinuationBytes = 0;
    if ((byte & 0xe0) === 0xc0) expectedContinuationBytes = 1;
    else if ((byte & 0xf0) === 0xe0) expectedContinuationBytes = 2;
    else if ((byte & 0xf8) === 0xf0) expectedContinuationBytes = 3;
    else return 'latin1';

    for (let j = 1; j <= expectedContinuationBytes; j++) {
      if (i + j >= buffer.length || (buffer[i + j] & 0xc0) !== 0x80) {
        return 'latin1';
      }
    }
    i += expectedContinuationBytes;
  }

  return 'utf-8';
}

/**
 * Strip UTF-8 BOM from the start of a string if present.
 */
function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

/**
 * Detect the best delimiter by trying each candidate and picking the one
 * that produces the most columns.
 */
function detectDelimiter(content: string): string {
  const delimiters = [',', ';', '\t'];
  let bestDelimiter = ',';
  let bestColumnCount = 0;

  for (const delimiter of delimiters) {
    try {
      const records = parse(content, {
        columns: true,
        delimiter,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      }) as Record<string, string>[];

      if (records.length > 0) {
        const columnCount = Object.keys(records[0]).length;
        if (columnCount > bestColumnCount) {
          bestColumnCount = columnCount;
          bestDelimiter = delimiter;
        }
      }
    } catch {
      // skip this delimiter
    }
  }

  return bestDelimiter;
}

/**
 * Import a full CSV file into the transactions table.
 *
 * 1. Read and parse the CSV file
 * 2. Get saved column_mappings from the database
 * 3. Map CSV columns to canonical names, generate UUIDs
 * 4. ALTER TABLE transactions to add any canonical columns that don't exist
 * 5. Bulk INSERT rows into the transactions table
 * 6. Extract distinct supplier_name values and INSERT INTO project_suppliers
 * 7. Update transaction_count and total_spend on project_suppliers
 */
export async function importCSV(
  filePath: string
): Promise<{ rowsInserted: number }> {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error('File path must not be empty');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // 1. Read and parse the CSV file
  const buffer = fs.readFileSync(filePath);
  const encoding = detectEncoding(buffer);
  const rawContent = buffer.toString(encoding);
  const content = stripBom(rawContent);

  if (content.trim().length === 0) {
    throw new Error('File is empty');
  }

  const delimiter = detectDelimiter(content);

  const allRecords = parse(content, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];

  if (allRecords.length === 0) {
    throw new Error('CSV file contains no data rows');
  }

  // 2. Get saved column mappings
  const mappings = await getMappings();
  if (!mappings) {
    throw new Error(
      'No column mappings found. Please save mappings before importing.'
    );
  }

  // Build reverse mapping: csv_column_name -> canonical_name
  const csvToCanonical: Record<string, string> = {};
  for (const [canonicalName, csvColumnName] of Object.entries(mappings)) {
    csvToCanonical[csvColumnName] = canonicalName;
  }

  // 3. Determine the canonical columns present in the mapping
  const canonicalColumns = Object.keys(mappings);

  // 4. ALTER TABLE transactions to add any canonical columns that don't exist
  const existingColumns = await databaseService.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND table_schema = 'main'"
  );
  const existingColumnNames = new Set(
    existingColumns.map((c) => c.column_name)
  );

  for (const canonicalCol of canonicalColumns) {
    if (!existingColumnNames.has(canonicalCol)) {
      await databaseService.run(
        `ALTER TABLE transactions ADD COLUMN "${canonicalCol}" VARCHAR`
      );
    }
  }

  // Invalidate cached column list after schema changes
  invalidateColumnCache();

  // Add index on supplier_name after column creation
  if (canonicalColumns.includes('supplier_name')) {
    await databaseService.run(
      'CREATE INDEX IF NOT EXISTS idx_transactions_supplier ON transactions(supplier_name)'
    );
  }

  // 5. Bulk INSERT rows into transactions table (batched for performance)
  const allColumns = ['id', 'row_index', ...canonicalColumns];
  const columnList = allColumns.map((c) => `"${c}"`).join(', ');
  const singleRowPlaceholders = `(${allColumns.map(() => '?').join(', ')})`;
  const INSERT_BATCH_SIZE = 500;

  for (let batchStart = 0; batchStart < allRecords.length; batchStart += INSERT_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + INSERT_BATCH_SIZE, allRecords.length);
    const batchValues: unknown[] = [];
    const rowPlaceholders: string[] = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const record = allRecords[i];
      const id = uuidv4();
      const rowIndex = i + 1;

      batchValues.push(id, rowIndex);
      for (const canonicalCol of canonicalColumns) {
        const csvCol = mappings[canonicalCol];
        batchValues.push(record[csvCol] ?? null);
      }
      rowPlaceholders.push(singleRowPlaceholders);
    }

    await databaseService.run(
      `INSERT INTO transactions (${columnList}) VALUES ${rowPlaceholders.join(', ')}`,
      ...batchValues
    );
  }

  // 6. Extract distinct supplier_name values -> match against universe -> INSERT INTO project_suppliers
  const supplierCanonicalCol = 'supplier_name';
  const supplierCsvCol = mappings[supplierCanonicalCol];

  if (supplierCsvCol) {
    // Load supplier universe and taxonomy nodes for matching
    const universe = await readSupplierUniverse();
    const matcher = buildMatcherIndex(universe);
    const taxonomyNodes = await getTaxonomyNodes();

    // Collect distinct supplier names from imported data
    const supplierNames = new Set<string>();
    for (const record of allRecords) {
      const name = record[supplierCsvCol];
      if (name && name.trim().length > 0) {
        supplierNames.add(name.trim());
      }
    }

    // Bulk-load all existing supplier names to avoid N+1 existence checks
    const existingRows = await databaseService.all<{ supplier_name: string }>(
      'SELECT supplier_name FROM project_suppliers'
    );
    const existingSupplierNames = new Set(existingRows.map((r) => r.supplier_name));

    // Map raw CSV names to resolved canonical names (for updating transaction rows)
    const nameResolution = new Map<string, string>();

    // Collect new suppliers for batch insert
    const newSuppliersWithMeta: unknown[][] = [];
    const newSuppliersBasic: unknown[][] = [];

    for (const name of supplierNames) {
      // Try to match against supplier universe
      const universeMatch = matcher.match(name);
      const canonicalName = universeMatch ? universeMatch.supplierName : name;
      nameResolution.set(name, canonicalName);

      // Check if supplier already exists under the canonical name (in-memory, no query)
      if (!existingSupplierNames.has(canonicalName)) {
        existingSupplierNames.add(canonicalName); // prevent duplicate inserts within this batch
        const supplierId = universeMatch?.id ?? uuidv4();

        if (universeMatch) {
          // Pre-populate with universe metadata
          const categoryATaxonomyNodeId = universeMatch.categoryATaxonomyPath
            ? resolveTaxonomyPath(universeMatch.categoryATaxonomyPath, taxonomyNodes)
            : null;

          if (universeMatch.categoryATaxonomyPath && categoryATaxonomyNodeId === null) {
            console.warn(
              `[Canonicalization] Could not resolve categoryATaxonomyPath "${universeMatch.categoryATaxonomyPath}" for supplier "${canonicalName}" — Category A path will be null`
            );
          }

          const supplierInfoJson = universeMatch.supplierInfo
            ? JSON.stringify(universeMatch.supplierInfo)
            : null;

          newSuppliersWithMeta.push([
            supplierId,
            canonicalName,
            universeMatch.aliases.length > 0 ? JSON.stringify(universeMatch.aliases) : null,
            universeMatch.parentId,
            universeMatch.parentName || null,
            supplierInfoJson,
            universeMatch.categoryA,
            categoryATaxonomyNodeId,
          ]);
        } else {
          newSuppliersBasic.push([supplierId, canonicalName]);
        }
      }
    }

    // Batch insert suppliers with universe metadata
    const SUPPLIER_BATCH_SIZE = 200;
    for (let i = 0; i < newSuppliersWithMeta.length; i += SUPPLIER_BATCH_SIZE) {
      const batch = newSuppliersWithMeta.slice(i, i + SUPPLIER_BATCH_SIZE);
      const rowPlaceholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      await databaseService.run(
        `INSERT INTO project_suppliers (id, supplier_name, aliases, parent_supplier_id, parent_name, supplier_info, category_a, category_a_taxonomy_node_id) VALUES ${rowPlaceholders}`,
        ...batch.flat()
      );
    }

    // Batch insert basic suppliers (no universe match)
    for (let i = 0; i < newSuppliersBasic.length; i += SUPPLIER_BATCH_SIZE) {
      const batch = newSuppliersBasic.slice(i, i + SUPPLIER_BATCH_SIZE);
      const rowPlaceholders = batch.map(() => '(?, ?)').join(', ');
      await databaseService.run(
        `INSERT INTO project_suppliers (id, supplier_name) VALUES ${rowPlaceholders}`,
        ...batch.flat()
      );
    }

    // Update transaction rows with resolved canonical supplier names (batched)
    const nameMappings = Array.from(nameResolution.entries()).filter(
      ([rawName, canonicalName]) => rawName !== canonicalName
    );
    const NAME_BATCH_SIZE = 200;
    for (let i = 0; i < nameMappings.length; i += NAME_BATCH_SIZE) {
      const batch = nameMappings.slice(i, i + NAME_BATCH_SIZE);
      const caseClauses = batch.map(() => 'WHEN supplier_name = ? THEN ?').join(' ');
      const rawNames = batch.map(([raw]) => raw);
      const caseParams: unknown[] = [];
      for (const [rawName, canonicalName] of batch) {
        caseParams.push(rawName, canonicalName);
      }
      const inPlaceholders = rawNames.map(() => '?').join(',');
      await databaseService.run(
        `UPDATE transactions SET supplier_name = CASE ${caseClauses} ELSE supplier_name END WHERE supplier_name IN (${inPlaceholders})`,
        ...caseParams,
        ...rawNames
      );
    }

    // 7. Update transaction_count and total_spend on project_suppliers
    const spendCanonicalCol = 'spend_amount';
    const spendCsvCol = mappings[spendCanonicalCol];

    // Build aggregation using resolved canonical names
    const supplierStats = new Map<
      string,
      { count: number; spend: number }
    >();

    for (const record of allRecords) {
      const name = record[supplierCsvCol];
      if (!name || name.trim().length === 0) continue;

      const trimmedName = name.trim();
      const canonicalName = nameResolution.get(trimmedName) ?? trimmedName;
      const stats = supplierStats.get(canonicalName) || {
        count: 0,
        spend: 0,
      };
      stats.count += 1;

      if (spendCsvCol) {
        const rawSpend = record[spendCsvCol];
        if (rawSpend) {
          // Remove currency symbols, commas, etc. and parse as number
          const numericStr = rawSpend.replace(/[^0-9.\-]/g, '');
          const spend = parseFloat(numericStr);
          if (!isNaN(spend)) {
            stats.spend += spend;
          }
        }
      }

      supplierStats.set(canonicalName, stats);
    }

    // Batch update supplier stats using CASE expressions
    const statsEntries = Array.from(supplierStats.entries());
    const STATS_BATCH_SIZE = 200;
    for (let i = 0; i < statsEntries.length; i += STATS_BATCH_SIZE) {
      const batch = statsEntries.slice(i, i + STATS_BATCH_SIZE);
      const names = batch.map(([name]) => name);
      const namePlaceholders = names.map(() => '?').join(',');
      const countCases = batch.map(() => 'WHEN supplier_name = ? THEN transaction_count + ?').join(' ');
      const spendCases = batch.map(() => 'WHEN supplier_name = ? THEN total_spend + ?').join(' ');

      const countParams: unknown[] = [];
      const spendParams: unknown[] = [];
      for (const [name, stats] of batch) {
        countParams.push(name, stats.count);
        spendParams.push(name, stats.spend);
      }

      await databaseService.run(
        `UPDATE project_suppliers SET transaction_count = CASE ${countCases} ELSE transaction_count END, total_spend = CASE ${spendCases} ELSE total_spend END, updated_at = CURRENT_TIMESTAMP WHERE supplier_name IN (${namePlaceholders})`,
        ...countParams,
        ...spendParams,
        ...names
      );
    }
  }

  return { rowsInserted: allRecords.length };
}
