import fs from 'fs';
import { createReadStream } from 'fs';
import { dialog, BrowserWindow } from 'electron';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import type { CSVPreview, CSVPreviewWithMappings, CanonicalizationResult } from '../../shared/types/canonicalization';
import { CANONICAL_COLUMNS } from '../../shared/canonical-columns';
import { suggestMappings } from '../agents/canonicalization-agent';

const SAMPLE_ROW_LIMIT = 10;

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
 * Parse a CSV file and return a preview with columns, sample rows, and total row count.
 * Uses streaming to avoid loading the entire file into memory.
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
  const sampleContent = stripBom(sampleBuffer.toString(encoding));

  if (sampleContent.trim().length === 0) {
    throw new Error('File is empty');
  }

  const delimiter = detectDelimiter(sampleContent);

  // Stream the full file to collect sample rows and count total rows
  const sampleRows: Record<string, string>[] = [];
  let columns: string[] = [];
  let totalRows = 0;

  return new Promise<CSVPreview>((resolve, reject) => {
    const parser = parseStream({
      columns: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    const stream = createReadStream(filePath, { encoding });

    // Strip BOM from the stream's first chunk
    let firstChunk = true;

    stream.on('data', (chunk: string | Buffer) => {
      let data = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
      if (firstChunk) {
        data = stripBom(data);
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
      let record: Record<string, string> | null;
      while ((record = parser.read() as Record<string, string> | null) !== null) {
        totalRows++;
        if (columns.length === 0) {
          columns = Object.keys(record);
        }
        if (sampleRows.length < SAMPLE_ROW_LIMIT) {
          sampleRows.push(record);
        }
      }
    });

    parser.on('error', (err) => {
      reject(err);
    });

    parser.on('end', () => {
      if (totalRows === 0) {
        reject(new Error('CSV file contains no data rows'));
        return;
      }
      resolve({ columns, sampleRows, totalRows });
    });
  });
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
