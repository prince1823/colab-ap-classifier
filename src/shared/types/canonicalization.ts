export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type CanonicalColumnRelevance = 'critical' | 'high' | 'medium' | 'low';
export type CanonicalColumnType = 'text' | 'log_text' | 'number' | 'category' | 'date';

// Maps canonical column name → original CSV column name
export interface CanonicalColumnMapping {
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
 * Extended preview that includes LLM-suggested column mappings (LLM-first flow).
 * Returned by `upload:parsePreview`.
 */
export interface CSVPreviewWithMappings extends CSVPreview {
  mappingSuggestion: CanonicalizationResult;
}

export interface CanonicalizationResult {
  mappings: CanonicalColumnMapping;
  confidence: ConfidenceLevel;
  unmappedClientColumns: string[];
  importantUnmappedColumns: string[];
  unmappedCanonicalColumns: string[];
  reasoning: string;
}
