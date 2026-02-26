export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type CanonicalColumnRelevance = 'critical' | 'high' | 'medium' | 'low';
export type CanonicalColumnType = 'text' | 'log_text' | 'number' | 'category' | 'date';

/** Maps canonical column name → original CSV column name */
export interface ColumnMapping {
  [canonicalName: string]: string;
}

export interface CanonicalColumnDefinition {
  name: string;
  relevance: CanonicalColumnRelevance;
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
