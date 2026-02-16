import fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { parse } from 'csv-parse/sync';
import type { CSVPreview, CSVPreviewWithMappings, CanonicalizationResult } from '../../shared/types/canonicalization';
import { CANONICAL_COLUMNS, suggestMappings } from '../agents/canonicalization-agent';

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

  // Try to detect invalid UTF-8 sequences.
  // Valid UTF-8 multi-byte sequences follow strict patterns.
  // If we find invalid sequences, assume latin1.
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];

    if (byte <= 0x7f) {
      // ASCII — always valid
      continue;
    }

    // Multi-byte sequence start
    let expectedContinuationBytes = 0;
    if ((byte & 0xe0) === 0xc0) {
      expectedContinuationBytes = 1;
    } else if ((byte & 0xf0) === 0xe0) {
      expectedContinuationBytes = 2;
    } else if ((byte & 0xf8) === 0xf0) {
      expectedContinuationBytes = 3;
    } else {
      // Invalid leading byte for UTF-8 — treat as latin1
      return 'latin1';
    }

    // Validate continuation bytes
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
 * Returns parsed records if successful, or null if the delimiter
 * does not produce a valid multi-column result.
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

    // A valid parse should produce multiple columns for multi-column files.
    // If only 1 column is produced, the delimiter might be wrong —
    // but we still return it as a fallback.
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
 * This is the synchronous CSV-only parsing step (no LLM call).
 *
 * - Automatically detects delimiter (comma, semicolon, tab)
 * - Handles quoted fields and newlines within quotes
 * - Detects encoding (UTF-8, Latin-1)
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
 * Build a fallback empty CanonicalizationResult for when the LLM call fails.
 */
function emptyMappingSuggestion(columns: string[]): CanonicalizationResult {
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
 * Parse a CSV file, return a preview, and automatically suggest column mappings
 * via the CanonicalizationAgent (LLM-first flow).
 *
 * If the LLM call fails, the preview is still returned with empty mappings
 * so the user can map manually.
 */
export async function parsePreview(filePath: string): Promise<CSVPreviewWithMappings> {
  const preview = parseCSVPreview(filePath);

  let mappingSuggestion: CanonicalizationResult;
  try {
    mappingSuggestion = await suggestMappings(preview.columns, preview.sampleRows);
  } catch (err) {
    console.error('[parsePreview] LLM mapping suggestion failed:', err instanceof Error ? err.message : err);
    mappingSuggestion = emptyMappingSuggestion(preview.columns);
  }

  return { ...preview, mappingSuggestion };
}
