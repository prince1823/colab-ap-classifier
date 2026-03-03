import fs from 'fs';
import path from 'path';
import { dialog, BrowserWindow } from 'electron';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'crypto';
import type { CSVPreview, ColumnMapping, ColumnMappingResult, ColumnMappingWithPriority } from '../../shared/types/column-mapping';
import { toEnrichedMapping } from '../../shared/types/column-mapping';
import { CANONICAL_COLUMNS } from '../../shared/canonical-columns';
import { suggestMappings as agentSuggestMappings } from '../agents/column-mapping-agent';
import { databaseService } from './database';
import { invalidateColumnCache } from './transactions';

const SAMPLE_ROW_LIMIT = 10;

/**
 * Supported delimiters in order of detection priority.
 */
const DELIMITERS = [',', ';', '\t'] as const;

/**
 * Show an "Open" dialog to select a CSV file.
 * Returns the chosen path, or null if the user cancelled.
 */
export async function selectFile(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win!, {
    title: 'Select CSV File',
    filters: [{ name: 'CSV Files', extensions: ['csv', 'tsv', 'txt'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
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

    if (byte <= 0x7f) {
      continue;
    }

    let expectedContinuationBytes = 0;
    if ((byte & 0xe0) === 0xc0) {
      expectedContinuationBytes = 1;
    } else if ((byte & 0xf0) === 0xe0) {
      expectedContinuationBytes = 2;
    } else if ((byte & 0xf8) === 0xf0) {
      expectedContinuationBytes = 3;
    } else {
      return 'latin1';
    }

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
 * Try to parse CSV content with a specific delimiter.
 */
function tryParseWithDelimiter(
  content: string,
  delimiter: string
): Record<string, string>[] | null {
  try {
    const records = parse(content, {
      columns: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Record<string, string>[];

    if (records.length === 0) {
      return null;
    }

    return records;
  } catch {
    return null;
  }
}

/**
 * Detect the best delimiter by trying each in order and picking the one
 * that produces the most columns. Comma is preferred when tied.
 */
function detectDelimiter(content: string): string {
  let bestDelimiter = ',';
  let bestColumnCount = 0;

  for (const delimiter of DELIMITERS) {
    const records = tryParseWithDelimiter(content, delimiter);
    if (records && records.length > 0) {
      const columnCount = Object.keys(records[0]).length;
      if (columnCount > bestColumnCount) {
        bestColumnCount = columnCount;
        bestDelimiter = delimiter;
      }
    }
  }

  return bestDelimiter;
}

/**
 * Parse a CSV file and return a preview with columns, sample rows, and total row count.
 */
export function parseCSVPreview(filePath: string): CSVPreview {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error('File path must not be empty');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

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

  const columns = Object.keys(allRecords[0]);
  const sampleRows = allRecords.slice(0, SAMPLE_ROW_LIMIT);
  const totalRows = allRecords.length;

  return { columns, sampleRows, totalRows };
}

/**
 * Build a fallback empty mapping result for when the LLM call fails.
 */
function emptyMappingSuggestion(columns: string[]): ColumnMappingResult {
  return {
    mappings: {},
    confidence: 'low',
    unmappedClientColumns: columns,
    importantUnmappedColumns: [],
    unmappedCanonicalColumns: CANONICAL_COLUMNS.map((c) => c.name),
    reasoning: 'LLM mapping suggestion unavailable.',
  };
}

/**
 * Suggest column mappings via the column-mapping agent (LLM).
 * Gracefully falls back to empty mappings if the LLM call fails.
 */
export async function suggestMappings(
  columns: string[],
  sampleRows: Record<string, string>[]
): Promise<ColumnMappingResult> {
  try {
    return await agentSuggestMappings(columns, sampleRows);
  } catch (err) {
    console.error('[suggestMappings] LLM mapping suggestion failed:', err instanceof Error ? err.message : err);
    return emptyMappingSuggestion(columns);
  }
}

/**
 * Import a CSV file into the transactions table.
 *
 * Steps:
 * 1. Parse the CSV file
 * 2. ALTER TABLE to add mapped canonical columns only
 * 3. INSERT rows with canonical column values (unmapped CSV columns are excluded)
 * 4. Save upload record to the uploads table
 */
export async function importCSV(
  filePath: string,
  columnMapping?: ColumnMapping
): Promise<{ rowsInserted: number; uploadId: string }> {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  // Parse the full CSV
  const buffer = fs.readFileSync(filePath);
  const encoding = detectEncoding(buffer);
  const rawContent = buffer.toString(encoding);
  const content = stripBom(rawContent);
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

  // Determine the mapping to use
  const mapping = columnMapping || {};

  // Get canonical column names that are actually mapped
  const canonicalNames = Object.keys(mapping);

  // ALTER TABLE to add mapped canonical columns only (if they don't already exist)
  const existingColumns = await databaseService.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = 'transactions'"
  );
  const existingSet = new Set(existingColumns.map((c) => c.column_name));

  for (const canonical of canonicalNames) {
    if (!existingSet.has(canonical)) {
      await databaseService.run(`ALTER TABLE transactions ADD COLUMN "${canonical}" VARCHAR`);
    }
  }

  // Invalidate cached columns so queries pick up new columns
  invalidateColumnCache();

  // Build and execute INSERT statements in batches
  let rowsInserted = 0;
  const BATCH_SIZE = 500;

  for (let batchStart = 0; batchStart < allRecords.length; batchStart += BATCH_SIZE) {
    const batch = allRecords.slice(batchStart, batchStart + BATCH_SIZE);

    // Build column list from first record — mapped canonical columns only
    const colNames: string[] = ['id', 'row_index'];
    for (const canonical of canonicalNames) {
      colNames.push(`"${canonical}"`);
    }

    // Build value rows
    const valueRows: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const rec = batch[i];
      const rowIndex = batchStart + i;
      const id = randomUUID();
      const vals: string[] = [`'${id}'`, `${rowIndex}`];

      for (const canonical of canonicalNames) {
        const rawValue = rec[mapping[canonical]];
        vals.push(rawValue !== undefined && rawValue !== null
          ? `'${String(rawValue).replace(/'/g, "''")}'`
          : 'NULL');
      }

      valueRows.push(`(${vals.join(', ')})`);
    }

    const sql = `INSERT INTO transactions (${colNames.join(', ')}) VALUES ${valueRows.join(',\n')}`;
    await databaseService.exec(sql);
    rowsInserted += batch.length;
  }

  // Save upload record to uploads table
  const uploadId = randomUUID();
  const fileName = path.basename(filePath);
  const enrichedMapping = toEnrichedMapping(mapping);
  await databaseService.run(
    `INSERT INTO uploads (id, file_name, column_mappings, row_count, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    uploadId,
    fileName,
    JSON.stringify(enrichedMapping),
    rowsInserted
  );

  return { rowsInserted, uploadId };
}

/**
 * Get the most recent upload record.
 * Returns null if no uploads exist.
 */
export async function getLatestUpload(): Promise<{
  id: string;
  fileName: string;
  columnMappings: ColumnMappingWithPriority | null;
  rowCount: number;
} | null> {
  const row = await databaseService.get<{
    id: string;
    file_name: string;
    column_mappings: string | null;
    row_count: number;
  }>('SELECT * FROM uploads ORDER BY created_at DESC LIMIT 1');

  if (!row) return null;

  return {
    id: row.id,
    fileName: row.file_name,
    columnMappings: row.column_mappings ? JSON.parse(row.column_mappings) : null,
    rowCount: row.row_count,
  };
}
