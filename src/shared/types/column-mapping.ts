export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type CanonicalColumnType = 'text' | 'log_text' | 'number' | 'category' | 'date';

/** Maps canonical column name → original CSV column name */
export interface ColumnMapping {
  [canonicalName: string]: string;
}

/** Entry in the enriched column mapping (stored in uploads table). */
export interface ColumnMappingEntry {
  csvColumn: string;
  classificationPriority?: number; // 1 = highest priority sent to LLM; undefined = don't send
}

/** Enriched column mapping persisted in uploads.column_mappings JSON. */
export interface ColumnMappingWithPriority {
  [canonicalName: string]: ColumnMappingEntry;
}

/** Convert enriched mapping to simple mapping for import/classification. */
export function toSimpleMapping(enriched: ColumnMappingWithPriority): ColumnMapping {
  const result: ColumnMapping = {};
  for (const [canonical, entry] of Object.entries(enriched)) {
    result[canonical] = entry.csvColumn;
  }
  return result;
}

/** Convert simple mapping to enriched mapping (no priorities set). */
export function toEnrichedMapping(simple: ColumnMapping): ColumnMappingWithPriority {
  const result: ColumnMappingWithPriority = {};
  for (const [canonical, csvCol] of Object.entries(simple)) {
    result[canonical] = { csvColumn: csvCol };
  }
  return result;
}

export interface CanonicalColumnDefinition {
  name: string;
  type: CanonicalColumnType;
  aliases: string[];
  description: string;
}

export interface CSVPreview {
  columns: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
}

/**
 * Extended preview that includes LLM-suggested column mappings.
 * Returned by `upload:parsePreview`.
 */
export interface CSVPreviewWithMappings extends CSVPreview {
  mappingSuggestion: ColumnMappingResult;
}

export interface ColumnMappingResult {
  mappings: ColumnMapping;
  confidence: ConfidenceLevel;
  unmappedClientColumns: string[];
  importantUnmappedColumns: string[];
  unmappedCanonicalColumns: string[];
  reasoning: string;
}

/** A single canonical → CSV column mapping row used in the mapping UI. */
export interface MappingRow {
  canonical: string;
  csvColumn: string;
}

/** Source for deriving column mappings: LLM suggestion or a stored upload. */
export type DeriveMappingsSource = 'llm' | { uploadId: string };

/** Result of backend mapping derivation — ready to display in the mapping step. */
export interface DerivedMappings {
  rows: MappingRow[];
  existingCanonicals: string[];
}

/** Summary of a completed upload (already imported into DB). */
export interface CompletedUpload {
  uploadId: string;
  fileName: string;
  rowCount: number;
  mappings: MappingRow[];
  createdAt?: string;
}
