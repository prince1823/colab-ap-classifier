import fs from 'fs';
import path from 'path';
import { dialog, BrowserWindow } from 'electron';
import { parse as parseSync } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import { randomUUID } from 'crypto';
import type {
  CSVPreview,
  ColumnMapping,
  ColumnMappingResult,
  MappingRow,
  DeriveMappingsSource,
  DerivedMappings,
} from '../../shared/types/column-mapping';
import { toEnrichedMapping, toSimpleMapping } from '../../shared/types/column-mapping';
import type { ColumnMappingWithPriority } from '../../shared/types/column-mapping';
import { CANONICAL_COLUMNS, REQUIRED_CANONICAL_COLUMNS } from '../../shared/canonical-columns';
import type {
  Database,
  IngestService as IIngestService,
  TransactionStore as ITransactionStore,
  SupplierService as ISupplierService,
  ColumnMappingAgent,
  EventBus,
  UploadRecord,
} from '../../shared/types/services';
import type { IngestProgress } from '../../shared/types/classification';

const SAMPLE_ROW_LIMIT = 100;
const IMPORT_BATCH_SIZE = 5000;
const PREVIEW_BUFFER_SIZE = 65536; // 64KB for preview/detection
const DELIMITERS = [',', ';', '\t'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectEncoding(buffer: Buffer): BufferEncoding {
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

function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

function tryParseWithDelimiter(
  content: string,
  delimiter: string
): Record<string, string>[] | null {
  try {
    const records = parseSync(content, {
      columns: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Record<string, string>[];

    if (records.length === 0) return null;
    return records;
  } catch {
    return null;
  }
}

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
 * Read a small prefix of a file for encoding/delimiter detection.
 * Avoids loading the entire file into memory.
 */
function readFilePrefix(filePath: string, maxBytes: number = PREVIEW_BUFFER_SIZE): { buffer: Buffer; encoding: BufferEncoding; content: string } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, 0);
    const encoding = detectEncoding(buffer);
    const content = stripBom(buffer.toString(encoding));
    return { buffer, encoding, content };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Count lines in a file by streaming through it counting newline bytes.
 * Subtracts 1 for the header row. Much faster than parsing all rows.
 */
async function countLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lineCount = 0;
    let lastByte = 0;
    let totalBytes = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) lineCount++;
      }
      if (buf.length > 0) {
        lastByte = buf[buf.length - 1];
        totalBytes += buf.length;
      }
    });
    stream.on('end', () => {
      if (totalBytes === 0) {
        resolve(0);
        return;
      }
      // If file doesn't end with newline, the last line wasn't counted
      if (lastByte !== 0x0a) lineCount++;
      // Subtract 1 for the header row
      resolve(Math.max(0, lineCount - 1));
    });
    stream.on('error', reject);
  });
}

/**
 * Parse the first N sample rows from a CSV using streaming parser.
 */
async function parseSampleRows(
  filePath: string,
  encoding: BufferEncoding,
  delimiter: string,
  limit: number
): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    const stream = fs.createReadStream(filePath, { encoding });
    const parser = stream.pipe(parseStream({
      columns: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }));

    parser.on('data', (record: Record<string, string>) => {
      rows.push(record);
      if (rows.length >= limit) {
        parser.destroy();
        stream.destroy();
        resolve(rows);
      }
    });
    parser.on('end', () => resolve(rows));
    parser.on('error', (err) => {
      // If we already collected enough rows before error (e.g. stream destroyed), resolve
      if (rows.length > 0) {
        resolve(rows);
      } else {
        reject(err);
      }
    });
    stream.on('error', (err) => {
      if (rows.length > 0) {
        resolve(rows);
      } else {
        reject(err);
      }
    });
  });
}

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

// ─── Service ──────────────────────────────────────────────────────────────────

export class IngestService implements IIngestService {
  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private suppliers: ISupplierService,
    private columnMappingAgent: ColumnMappingAgent,
    private eventBus: EventBus
  ) {}

  async selectFile(): Promise<string | null> {
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

  async parseCSVPreview(filePath: string): Promise<CSVPreview> {
    if (!filePath || filePath.trim().length === 0) {
      throw new Error('File path must not be empty');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read only a small prefix for encoding/delimiter detection
    const { encoding, content } = readFilePrefix(filePath);

    if (content.trim().length === 0) {
      throw new Error('File is empty');
    }

    const delimiter = detectDelimiter(content);

    // Stream just the first N sample rows instead of parsing the entire file
    const sampleRows = await parseSampleRows(filePath, encoding, delimiter, SAMPLE_ROW_LIMIT);

    if (sampleRows.length === 0) {
      throw new Error('CSV file contains no data rows');
    }

    const columns = Object.keys(sampleRows[0]);

    // Count total rows via fast line counting (no full parse)
    const totalRows = await countLines(filePath);

    return { columns, sampleRows, totalRows: totalRows || sampleRows.length };
  }

  async suggestMappings(
    columns: string[],
    sampleRows: Record<string, string>[]
  ): Promise<ColumnMappingResult> {
    try {
      return await this.columnMappingAgent.suggestMappings(columns, sampleRows);
    } catch (err) {
      console.error('[suggestMappings] LLM mapping suggestion failed:', err instanceof Error ? err.message : err);
      return emptyMappingSuggestion(columns);
    }
  }

  private emitProgress(progress: IngestProgress): void {
    try {
      this.eventBus.emit('ingest:progress', progress);
    } catch {
      // Never let a listener error crash the import
    }
  }

  async importCSV(
    filePath: string,
    columnMapping: ColumnMapping,
    uploadId?: string
  ): Promise<{ rowsInserted: number; uploadId: string }> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`CSV file not found: ${filePath}`);
    }

    // Read prefix for encoding/delimiter detection (not the whole file)
    const { encoding, content: prefixContent } = readFilePrefix(filePath);
    const delimiter = detectDelimiter(prefixContent);

    // Estimate total rows for progress reporting
    const estimatedTotal = await countLines(filePath);

    this.emitProgress({
      status: 'running',
      totalRows: estimatedTotal,
      processedRows: 0,
      percentage: 0,
      currentStep: 'Starting import...',
    });

    const mapping = columnMapping || {};

    // Validate required canonicals are present
    for (const required of REQUIRED_CANONICAL_COLUMNS) {
      if (!mapping[required]) {
        throw new Error(`Required canonical column "${required}" is missing from the mapping`);
      }
    }

    // Validate no two canonical columns reference the same CSV column
    const csvColsSeen = new Set<string>();
    for (const [canonical, csvCol] of Object.entries(mapping)) {
      if (csvColsSeen.has(csvCol)) {
        throw new Error(`CSV column "${csvCol}" is assigned to multiple canonical columns (duplicate at "${canonical}")`);
      }
      csvColsSeen.add(csvCol);
    }

    // supplier_name maps to the original_supplier_name DB column (audit trail).
    // The canonical supplier_name is resolved via JOIN to project_suppliers after normalization.
    // We remap at the SQL level only — the mapping object stays unmutated so it's
    // stored correctly in the uploads table for reuse.
    const dbColumn = (canonical: string) =>
      canonical === 'supplier_name' ? 'original_supplier_name' : canonical;

    const canonicalNames = Object.keys(mapping);

    // Validate canonical names are safe identifiers before using in SQL
    for (const canonical of canonicalNames) {
      const col = dbColumn(canonical);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
        throw new Error(`Invalid column name: ${col}`);
      }
    }

    // ALTER TABLE to add mapped canonical columns
    const existingColumns = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = 'transactions'"
    );
    const existingSet = new Set(existingColumns.map((c) => c.column_name));

    for (const canonical of canonicalNames) {
      const col = dbColumn(canonical);
      if (!existingSet.has(col)) {
        await this.db.run(`ALTER TABLE transactions ADD COLUMN "${col}" VARCHAR`);
      }
    }

    this.transactions.invalidateColumnCache();

    // Build column list once for all batches
    const colNames: string[] = ['id', 'row_index'];
    for (const canonical of canonicalNames) {
      colNames.push(`"${dbColumn(canonical)}"`);
    }

    // Stream CSV and insert in batches
    let rowsInserted = 0;
    let rowIndex = 0;
    let batch: Record<string, string>[] = [];

    const flushBatch = async (records: Record<string, string>[], startIndex: number) => {
      if (records.length === 0) return;

      const valueRows: string[] = [];
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const idx = startIndex + i;
        const id = randomUUID();
        const vals: string[] = [`'${id}'`, `${idx}`];

        for (const canonical of canonicalNames) {
          const rawValue = rec[mapping[canonical]];
          vals.push(rawValue !== undefined && rawValue !== null
            ? `'${String(rawValue).replace(/'/g, "''")}'`
            : 'NULL');
        }

        valueRows.push(`(${vals.join(', ')})`);
      }

      const sql = `INSERT INTO transactions (${colNames.join(', ')}) VALUES ${valueRows.join(',\n')}`;
      await this.db.exec(sql);
    };

    // Stream through the file row by row
    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(filePath, { encoding });
      const parser = readStream.pipe(parseStream({
        columns: true,
        delimiter,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
      }));

      let streamError: Error | null = null;

      parser.on('data', (record: Record<string, string>) => {
        batch.push(record);

        if (batch.length >= IMPORT_BATCH_SIZE) {
          parser.pause();
          const currentBatch = batch;
          const batchStartIndex = rowIndex;
          batch = [];
          rowIndex += currentBatch.length;

          flushBatch(currentBatch, batchStartIndex)
            .then(() => {
              rowsInserted += currentBatch.length;
              this.emitProgress({
                status: 'running',
                totalRows: estimatedTotal,
                processedRows: rowsInserted,
                percentage: estimatedTotal > 0 ? Math.min(99, Math.round((rowsInserted / estimatedTotal) * 100)) : 0,
                currentStep: `Inserted ${rowsInserted.toLocaleString()} of ~${estimatedTotal.toLocaleString()} rows...`,
              });
              parser.resume();
            })
            .catch((err) => {
              streamError = err instanceof Error ? err : new Error(String(err));
              readStream.destroy();
              parser.destroy();
              reject(streamError);
            });
        }
      });

      parser.on('end', () => {
        if (streamError) return; // already rejected in catch handler
        // Flush remaining batch
        const remaining = batch;
        const batchStartIndex = rowIndex;
        batch = [];

        flushBatch(remaining, batchStartIndex)
          .then(() => {
            rowsInserted += remaining.length;
            resolve();
          })
          .catch(reject);
      });

      parser.on('error', (err) => {
        if (!streamError) reject(err);
      });
      readStream.on('error', (err) => {
        if (!streamError) reject(err);
      });
    });

    if (rowsInserted === 0) {
      throw new Error('CSV file contains no data rows');
    }

    this.emitProgress({
      status: 'running',
      totalRows: estimatedTotal,
      processedRows: rowsInserted,
      percentage: 95,
      currentStep: 'Saving upload record...',
    });

    // Save upload record
    const finalUploadId = uploadId || randomUUID();
    const fileName = path.basename(filePath);
    const enrichedMapping = toEnrichedMapping(mapping);
    await this.db.run(
      `INSERT INTO uploads (id, file_name, file_path, column_mappings, row_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'imported', CURRENT_TIMESTAMP)`,
      finalUploadId,
      fileName,
      filePath,
      JSON.stringify(enrichedMapping),
      rowsInserted
    );

    this.emitProgress({
      status: 'running',
      totalRows: estimatedTotal,
      processedRows: rowsInserted,
      percentage: 97,
      currentStep: 'Normalizing suppliers...',
    });

    // Link transactions to project_suppliers via original_supplier_name
    await this.suppliers.normalizeAllTransactions();

    // Auto-apply tail spend threshold to newly created suppliers
    const thresholdRow = await this.db.get<{ value: string }>(
      "SELECT value FROM project_settings WHERE key = 'tail_spend_threshold'"
    );
    if (thresholdRow) {
      const threshold = JSON.parse(thresholdRow.value) as number;
      if (threshold > 0) {
        await this.suppliers.filterTailSpend(threshold);
      }
    }

    const result = { rowsInserted, uploadId: finalUploadId };

    this.emitProgress({
      status: 'completed',
      totalRows: rowsInserted,
      processedRows: rowsInserted,
      percentage: 100,
      currentStep: 'Import complete',
      result,
    });

    return result;
  }

  async getUploadHistory(): Promise<UploadRecord[]> {
    const rows = await this.db.all<{
      id: string;
      file_name: string;
      file_path: string | null;
      column_mappings: string;
      row_count: number;
      status: string;
      created_at: string;
      updated_at: string | null;
    }>('SELECT * FROM uploads ORDER BY created_at DESC');

    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      filePath: row.file_path ?? undefined,
      columnMappings: row.column_mappings
        ? toSimpleMapping(JSON.parse(row.column_mappings) as ColumnMappingWithPriority)
        : {},
      rowCount: row.row_count,
      status: row.status as UploadRecord['status'],
      createdAt: String(row.created_at),
      updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    }));
  }

  async deriveMappings(
    columns: string[],
    sampleRows: Record<string, string>[],
    source: DeriveMappingsSource
  ): Promise<DerivedMappings> {
    const existingCanonicals = await this.getExistingCanonicals();

    if (source === 'llm') {
      // First upload path: use LLM to suggest mappings
      const suggestion = await this.suggestMappings(columns, sampleRows);
      const rows: MappingRow[] = [];

      // Required canonicals first
      for (const canonical of REQUIRED_CANONICAL_COLUMNS) {
        rows.push({ canonical, csvColumn: suggestion.mappings[canonical] ?? '' });
      }

      // Then non-required LLM suggestions
      const usedCsvCols = new Set(rows.map((r) => r.csvColumn).filter(Boolean));
      for (const [canonical, csv] of Object.entries(suggestion.mappings)) {
        if (!REQUIRED_CANONICAL_COLUMNS.includes(canonical as typeof REQUIRED_CANONICAL_COLUMNS[number]) && csv && !usedCsvCols.has(csv)) {
          rows.push({ canonical, csvColumn: csv });
        }
      }

      return { rows, existingCanonicals };
    }

    // Stored mapping path: load from a specific prior upload
    const uploads = await this.getUploadHistory();
    const upload = uploads.find((u) => u.id === source.uploadId);
    if (!upload) {
      throw new Error(`Upload not found: ${source.uploadId}`);
    }

    const storedMapping = upload.columnMappings; // canonical → csvColumn
    const rows: MappingRow[] = [];

    // Start with ALL existing canonicals, auto-fill CSV columns that match the new file
    const allCanonicals = new Set([
      ...REQUIRED_CANONICAL_COLUMNS,
      ...existingCanonicals,
      ...Object.keys(storedMapping),
    ]);

    for (const canonical of allCanonicals) {
      const csvCol = storedMapping[canonical];
      // Auto-fill if the stored CSV column exists in the new file's columns
      const matched = csvCol && columns.includes(csvCol) ? csvCol : '';
      rows.push({ canonical, csvColumn: matched });
    }

    // Sort: required first, then rest alphabetically
    const requiredSet = new Set<string>(REQUIRED_CANONICAL_COLUMNS);
    rows.sort((a, b) => {
      const aReq = requiredSet.has(a.canonical) ? 0 : 1;
      const bReq = requiredSet.has(b.canonical) ? 0 : 1;
      if (aReq !== bReq) return aReq - bReq;
      return a.canonical.localeCompare(b.canonical);
    });

    return { rows, existingCanonicals };
  }

  async getExistingCanonicals(): Promise<string[]> {
    const uploads = await this.getUploadHistory();
    const canonicals = new Set<string>();
    for (const upload of uploads) {
      for (const key of Object.keys(upload.columnMappings)) {
        canonicals.add(key);
      }
    }
    return [...canonicals].sort();
  }
}
