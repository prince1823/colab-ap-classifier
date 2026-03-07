import fs from 'fs';
import path from 'path';
import { dialog, BrowserWindow } from 'electron';
import { parse } from 'csv-parse/sync';
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
  UploadRecord,
} from '../../shared/types/services';

const SAMPLE_ROW_LIMIT = 10;
const DELIMITERS = [',', ';', '\t'] as const;

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
    const records = parse(content, {
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

export class IngestService implements IIngestService {
  constructor(
    private db: Database,
    private transactions: ITransactionStore,
    private suppliers: ISupplierService,
    private columnMappingAgent: ColumnMappingAgent
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

  parseCSVPreview(filePath: string): CSVPreview {
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

  async getStoredMappings(columns: string[]): Promise<UploadRecord | null> {
    // Find existing uploads with matching column structure for reuse
    const uploads = await this.db.all<{
      id: string;
      file_name: string;
      file_path: string | null;
      column_mappings: string;
      row_count: number;
      status: string;
      created_at: string;
      updated_at: string | null;
    }>('SELECT * FROM uploads ORDER BY created_at DESC');

    const sortedColumns = [...columns].sort().join(',');

    for (const upload of uploads) {
      try {
        const mappings = JSON.parse(upload.column_mappings) as ColumnMapping;
        const mappedCsvCols = [...new Set(Object.values(mappings))].sort().join(',');
        // Check if the CSV columns in the stored mapping are a subset of current columns
        const storedCsvCols = Object.values(mappings);
        const allMatch = storedCsvCols.every((col) => columns.includes(col));
        if (allMatch && storedCsvCols.length > 0) {
          return {
            id: upload.id,
            fileName: upload.file_name,
            filePath: upload.file_path ?? undefined,
            columnMappings: mappings,
            rowCount: upload.row_count,
            status: upload.status as UploadRecord['status'],
            createdAt: String(upload.created_at),
            updatedAt: upload.updated_at ? String(upload.updated_at) : undefined,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async importCSV(
    filePath: string,
    columnMapping: ColumnMapping,
    uploadId?: string
  ): Promise<{ rowsInserted: number; uploadId: string }> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`CSV file not found: ${filePath}`);
    }

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

    const mapping = columnMapping || {};

    // Raw CSV supplier value → original_supplier_name (static column, audit trail).
    // supplier_name (static column) gets populated later by normalizeAllTransactions().
    if (mapping.supplier_name) {
      mapping.original_supplier_name = mapping.supplier_name;
      delete mapping.supplier_name;
    }

    const canonicalNames = Object.keys(mapping);

    // ALTER TABLE to add mapped canonical columns
    const existingColumns = await this.db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = 'transactions'"
    );
    const existingSet = new Set(existingColumns.map((c) => c.column_name));

    for (const canonical of canonicalNames) {
      if (!existingSet.has(canonical)) {
        await this.db.run(`ALTER TABLE transactions ADD COLUMN "${canonical}" VARCHAR`);
      }
    }

    this.transactions.invalidateColumnCache();

    // Insert in batches
    let rowsInserted = 0;
    const BATCH_SIZE = 500;

    for (let batchStart = 0; batchStart < allRecords.length; batchStart += BATCH_SIZE) {
      const batch = allRecords.slice(batchStart, batchStart + BATCH_SIZE);

      const colNames: string[] = ['id', 'row_index'];
      for (const canonical of canonicalNames) {
        colNames.push(`"${canonical}"`);
      }

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
      await this.db.exec(sql);
      rowsInserted += batch.length;
    }

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

    // Link transactions to project_suppliers via original_supplier_name
    await this.suppliers.normalizeAllTransactions();

    return { rowsInserted, uploadId: finalUploadId };
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
