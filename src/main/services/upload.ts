import fs from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { parse } from 'csv-parse/sync';
import type { CSVPreview, CSVPreviewWithMappings, CanonicalizationResult } from '../../shared/types/canonicalization';
import { CANONICAL_COLUMNS } from '../../shared/canonical-columns';
import { suggestMappings } from '../agents/canonicalization-agent';

/**
 * Supported delimiters in order of detection priority.
 */
const DELIMITERS = [',', ';', '\t'] as const;

/**
 * Size of the sample buffer used for encoding and delimiter detection.
 * 64 KB is enough to capture headers + several rows for detection.
 */
const SAMPLE_BUFFER_SIZE = 64 * 1024;

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
 * Read a small sample from the beginning of a file for encoding/delimiter detection.
 * Returns the sample buffer without loading the entire file.
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
      relax_quotes: true,
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
 * Uses only the sample content (not the full file).
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
 * Count newlines in a buffer to estimate row count.
 */
function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) count++;
  }
  return count;
}

/**
 * Estimate total row count from file size without reading the entire file.
 * Reads the first ~64KB, counts lines, computes average bytes per line,
 * then extrapolates to the full file size (minus 1 for the header).
 */
function estimateRowCount(filePath: string): number {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  // For small files, just count lines directly from the sample
  const sampleSize = Math.min(SAMPLE_BUFFER_SIZE, fileSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(sampleSize);
    fs.readSync(fd, buffer, 0, sampleSize, 0);
    const newlines = countNewlines(buffer);

    if (sampleSize >= fileSize) {
      // We read the whole file — exact count (minus 1 for header row)
      return Math.max(0, newlines > 0 ? newlines - 1 : 0);
    }

    if (newlines === 0) return 0;

    // Average bytes per line from sample, extrapolate to full file
    const avgBytesPerLine = sampleSize / newlines;
    const estimatedLines = Math.round(fileSize / avgBytesPerLine);
    // Subtract 1 for header row
    return Math.max(0, estimatedLines - 1);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse a CSV file and return a preview with columns, sample rows, and total row count.
 * Only reads a small sample for preview — does not stream the entire file.
 * Row count is estimated from file size for large files.
 *
 * - Automatically detects delimiter (comma, semicolon, tab)
 * - Handles quoted fields and newlines within quotes
 * - Detects encoding (UTF-8, Latin-1)
 */
export async function parseCSVPreview(filePath: string): Promise<CSVPreview> {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error('File path must not be empty');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Read a small sample for encoding and delimiter detection
  const sampleBuffer = readSampleBuffer(filePath);
  if (sampleBuffer.length === 0) {
    throw new Error('File is empty');
  }

  const encoding = detectEncoding(sampleBuffer);
  let sampleContent = stripBom(sampleBuffer.toString(encoding));

  if (sampleContent.trim().length === 0) {
    throw new Error('File is empty');
  }

  // If the sample buffer is smaller than the file, truncate to the last
  // complete line to avoid cutting mid-field (which causes "Quote Not Closed"
  // errors when a quoted field spans the buffer boundary).
  const fileSize = fs.statSync(filePath).size;
  if (sampleBuffer.length < fileSize) {
    const lastNewline = sampleContent.lastIndexOf('\n');
    if (lastNewline > 0) {
      sampleContent = sampleContent.slice(0, lastNewline);
    }
  }

  const delimiter = detectDelimiter(sampleContent);

  // Parse sample rows from the sample buffer content
  const sampleRecords = parse(sampleContent, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as Record<string, string>[];

  if (sampleRecords.length === 0) {
    throw new Error('CSV file contains no data rows');
  }

  const columns = Object.keys(sampleRecords[0]);
  const sampleRows = sampleRecords;

  // Estimate total rows from file size instead of streaming the whole file
  const totalRows = estimateRowCount(filePath);

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
  const preview = await parseCSVPreview(filePath);

  let mappingSuggestion: CanonicalizationResult;
  try {
    mappingSuggestion = await suggestMappings(preview.columns, preview.sampleRows);
  } catch (err) {
    console.error('[parsePreview] LLM mapping suggestion failed:', err instanceof Error ? err.message : err);
    mappingSuggestion = emptyMappingSuggestion(preview.columns);
  }

  return { ...preview, mappingSuggestion };
}
