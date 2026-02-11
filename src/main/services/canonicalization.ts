import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
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

  // Insert column mappings
  for (const [canonicalName, csvColumnName] of Object.entries(mapping)) {
    await databaseService.run(
      'INSERT INTO column_mappings (canonical_name, csv_column_name) VALUES (?, ?)',
      canonicalName,
      csvColumnName
    );
  }

  // Insert grouping columns with position
  for (let i = 0; i < groupingColumns.length; i++) {
    await databaseService.run(
      'INSERT INTO invoice_grouping_columns (canonical_name, position) VALUES (?, ?)',
      groupingColumns[i],
      i
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
 * 3. Map CSV columns to canonical names, generate UUIDs, store raw_data
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

  // Also ensure raw_data column exists
  if (!existingColumnNames.has('raw_data')) {
    await databaseService.run(
      'ALTER TABLE transactions ADD COLUMN raw_data JSON'
    );
  }

  // 5. Bulk INSERT rows into transactions table
  const allColumns = ['id', 'row_index', 'raw_data', ...canonicalColumns];
  const placeholders = allColumns.map(() => '?').join(', ');
  const columnList = allColumns.map((c) => `"${c}"`).join(', ');
  const insertSQL = `INSERT INTO transactions (${columnList}) VALUES (${placeholders})`;

  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    const id = uuidv4();
    const rowIndex = i + 1;
    const rawData = JSON.stringify(record);

    const values: unknown[] = [id, rowIndex, rawData];
    for (const canonicalCol of canonicalColumns) {
      const csvCol = mappings[canonicalCol];
      values.push(record[csvCol] ?? null);
    }

    await databaseService.run(insertSQL, ...values);
  }

  // 6. Extract distinct supplier_name values -> INSERT INTO project_suppliers
  const supplierCanonicalCol = 'supplier_name';
  const supplierCsvCol = mappings[supplierCanonicalCol];

  if (supplierCsvCol) {
    // Collect distinct supplier names from imported data
    const supplierNames = new Set<string>();
    for (const record of allRecords) {
      const name = record[supplierCsvCol];
      if (name && name.trim().length > 0) {
        supplierNames.add(name.trim());
      }
    }

    for (const name of supplierNames) {
      // Check if supplier already exists
      const existing = await databaseService.get<{ id: string }>(
        'SELECT id FROM project_suppliers WHERE supplier_name = ?',
        name
      );

      if (!existing) {
        const supplierId = uuidv4();
        await databaseService.run(
          'INSERT INTO project_suppliers (id, supplier_name) VALUES (?, ?)',
          supplierId,
          name
        );
      }
    }

    // 7. Update transaction_count and total_spend on project_suppliers
    const spendCanonicalCol = 'spend_amount';
    const spendCsvCol = mappings[spendCanonicalCol];

    // Build aggregation from the imported records
    const supplierStats = new Map<
      string,
      { count: number; spend: number }
    >();

    for (const record of allRecords) {
      const name = record[supplierCsvCol];
      if (!name || name.trim().length === 0) continue;

      const trimmedName = name.trim();
      const stats = supplierStats.get(trimmedName) || {
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

      supplierStats.set(trimmedName, stats);
    }

    for (const [name, stats] of supplierStats) {
      await databaseService.run(
        'UPDATE project_suppliers SET transaction_count = transaction_count + ?, total_spend = total_spend + ?, updated_at = CURRENT_TIMESTAMP WHERE supplier_name = ?',
        stats.count,
        stats.spend,
        name
      );
    }
  }

  return { rowsInserted: allRecords.length };
}
