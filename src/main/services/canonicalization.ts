import fs from 'fs';
import { createReadStream } from 'fs';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
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
 * Size of the sample buffer used for encoding and delimiter detection.
 */
const SAMPLE_BUFFER_SIZE = 64 * 1024;

/**
 * Read a small sample from the beginning of a file for encoding/delimiter detection.
 */
function readSampleBuffer(filePath: string, size: number = SAMPLE_BUFFER_SIZE): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const readSize = Math.min(size, stats.size);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream-parse a CSV file and call a callback for each row.
 * Returns the total number of rows processed.
 */
async function streamCSV(
  filePath: string,
  encoding: BufferEncoding,
  delimiter: string,
  onBatch: (batch: Record<string, string>[], startIndex: number) => Promise<void>,
  batchSize: number = 500
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const parser = parseStream({
      columns: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    const stream = createReadStream(filePath, { encoding });

    let firstChunk = true;
    let totalRows = 0;
    let currentBatch: Record<string, string>[] = [];
    let batchStartIndex = 0;
    let processing = false;
    let streamEnded = false;

    const flushBatch = async () => {
      if (currentBatch.length === 0) return;
      const batch = currentBatch;
      const startIdx = batchStartIndex;
      currentBatch = [];
      batchStartIndex = totalRows;
      await onBatch(batch, startIdx);
    };

    stream.on('data', (chunk: string | Buffer) => {
      let data = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
      if (firstChunk) {
        if (data.charCodeAt(0) === 0xfeff) {
          data = data.slice(1);
        }
        firstChunk = false;
      }
      parser.write(data);
    });

    stream.on('end', () => {
      parser.end();
    });

    stream.on('error', (err) => {
      parser.destroy();
      reject(err);
    });

    parser.on('readable', () => {
      // If already processing a flush, don't re-enter
      if (processing) return;
      processing = true;

      const drain = async () => {
        try {
          let record: Record<string, string> | null;
          while ((record = parser.read() as Record<string, string> | null) !== null) {
            currentBatch.push(record);
            totalRows++;
            if (currentBatch.length >= batchSize) {
              parser.pause();
              await flushBatch();
              parser.resume();
            }
          }
        } catch (err) {
          reject(err);
        } finally {
          processing = false;
          // If stream ended while we were processing, finalize
          if (streamEnded) {
            try {
              await flushBatch();
              resolve(totalRows);
            } catch (err) {
              reject(err);
            }
          }
        }
      };

      drain();
    });

    parser.on('error', (err) => {
      reject(err);
    });

    parser.on('end', () => {
      if (processing) {
        // drain() will handle finalization
        streamEnded = true;
      } else {
        flushBatch().then(() => resolve(totalRows)).catch(reject);
      }
    });
  });
}

/**
 * Import a full CSV file into the transactions table using streaming.
 * Never loads the entire file into a single string — supports arbitrarily large CSVs.
 *
 * 1. Detect encoding/delimiter from a small sample
 * 2. Get saved column_mappings from the database
 * 3. Stream-parse CSV, inserting rows in batches
 * 4. Extract distinct supplier_name values and INSERT INTO project_suppliers
 * 5. Update transaction_count and total_spend on project_suppliers
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

  // 1. Detect encoding and delimiter from a small sample
  const sampleBuffer = readSampleBuffer(filePath);
  if (sampleBuffer.length === 0) {
    throw new Error('File is empty');
  }

  const encoding = detectEncoding(sampleBuffer);
  const sampleContent = stripBom(sampleBuffer.toString(encoding));

  if (sampleContent.trim().length === 0) {
    throw new Error('File is empty');
  }

  const delimiter = detectDelimiter(sampleContent);

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

  // Prepare INSERT template
  const allColumns = ['id', 'row_index', ...canonicalColumns];
  const columnList = allColumns.map((c) => `"${c}"`).join(', ');
  const singleRowPlaceholders = `(${allColumns.map(() => '?').join(', ')})`;
  const INSERT_BATCH_SIZE = 500;

  // Collect supplier names and stats during streaming
  const supplierCsvCol = mappings['supplier_name'];
  const spendCsvCol = mappings['spend_amount'];
  const supplierNames = new Set<string>();
  const supplierStats = new Map<string, { count: number; spend: number }>();

  // 5. Stream-parse CSV and insert rows in batches
  const totalRows = await streamCSV(
    filePath,
    encoding,
    delimiter,
    async (batch, startIndex) => {
      // Insert this batch into transactions
      const batchValues: unknown[] = [];
      const rowPlaceholders: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const record = batch[i];
        const id = uuidv4();
        const rowIndex = startIndex + i + 1;

        batchValues.push(id, rowIndex);
        for (const canonicalCol of canonicalColumns) {
          const csvCol = mappings[canonicalCol];
          batchValues.push(record[csvCol] ?? null);
        }
        rowPlaceholders.push(singleRowPlaceholders);

        // Collect supplier names and stats while streaming
        if (supplierCsvCol) {
          const name = record[supplierCsvCol];
          if (name && name.trim().length > 0) {
            const trimmedName = name.trim();
            supplierNames.add(trimmedName);

            const stats = supplierStats.get(trimmedName) || { count: 0, spend: 0 };
            stats.count += 1;

            if (spendCsvCol) {
              const rawSpend = record[spendCsvCol];
              if (rawSpend) {
                const numericStr = rawSpend.replace(/[^0-9.\-]/g, '');
                const spend = parseFloat(numericStr);
                if (!isNaN(spend)) {
                  stats.spend += spend;
                }
              }
            }

            supplierStats.set(trimmedName, stats);
          }
        }
      }

      await databaseService.run(
        `INSERT INTO transactions (${columnList}) VALUES ${rowPlaceholders.join(', ')}`,
        ...batchValues
      );
    },
    INSERT_BATCH_SIZE
  );

  if (totalRows === 0) {
    throw new Error('CSV file contains no data rows');
  }

  // 6. Extract distinct supplier_name values -> match against universe -> INSERT INTO project_suppliers
  if (supplierCsvCol && supplierNames.size > 0) {
    // Load supplier universe and taxonomy nodes for matching
    const universe = await readSupplierUniverse();
    const matcher = buildMatcherIndex(universe);
    const taxonomyNodes = await getTaxonomyNodes();

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
    // Re-aggregate stats using resolved canonical names
    const resolvedStats = new Map<string, { count: number; spend: number }>();
    for (const [rawName, stats] of supplierStats) {
      const canonicalName = nameResolution.get(rawName) ?? rawName;
      const existing = resolvedStats.get(canonicalName) || { count: 0, spend: 0 };
      existing.count += stats.count;
      existing.spend += stats.spend;
      resolvedStats.set(canonicalName, existing);
    }

    const statsEntries = Array.from(resolvedStats.entries());
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

  return { rowsInserted: totalRows };
}
